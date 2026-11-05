@preconcurrency import AVFoundation
import Foundation

/// A note that's finished and on disk in `Recording/`, ready to become a `Memo`.
struct FinishedNote: Equatable, Sendable {
    let id: UUID
    let recordedAt: Date
    let duration: TimeInterval
}

/// The files behind a hands-free session: one per note, in `Recording/`, so a crash leaves each
/// one to be recovered by `MemoStore.load` like any other recording. Used from one queue only.
///
/// The phone is usually locked, so nothing here can become a `Memo` yet: that writes
/// files iOS keeps sealed until it's unlocked. `HandsFreeSession` does it afterwards.
final class NoteDesk {
    /// How long a split can be taken back. The audio since the split stays in memory until then.
    static let undoSeconds = 60.0
    /// Shorter than this and it's not a note, it's a slip: the same rule as `AppModel.finishRecording`.
    static let shortestNote = 1.0

    private final class OpenNote {
        let id = UUID()
        let recordedAt: Date
        let url: URL
        var file: AVAudioFile?
        var samples = 0

        init(url: (UUID) -> URL, recordedAt: Date) throws {
            self.recordedAt = recordedAt
            self.url = url(id)
            file = try NoteDesk.makeFile(self.url)
        }

        var duration: TimeInterval { Double(samples) / Double(NoteCutter.sampleRate) }

        func write(_ samples: [Float]) throws {
            guard let file, !samples.isEmpty else { return }
            let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(samples.count))!
            buffer.frameLength = buffer.frameCapacity
            samples.withUnsafeBufferPointer { buffer.floatChannelData?[0].update(from: $0.baseAddress!, count: samples.count) }
            try file.write(from: buffer)
            self.samples += samples.count
        }

        func close() {
            if #available(iOS 18.0, *) { file?.close() }
            file = nil
        }
    }

    private let recordingDir: URL
    private let binDir: URL
    private let fm = FileManager.default
    private var current: OpenNote
    /// The note before the last split, still open in case the split is taken back.
    private var previous: OpenNote?
    /// What's gone into `current` since that split, while it can still go back.
    private var sinceSplit: [Float] = []
    /// The last note discarded, kept until the session ends in case that's taken back.
    private var discarded: FinishedNote?
    private(set) var finished: [FinishedNote] = []

    init(recordingDir: URL, now: Date = Date()) throws {
        self.recordingDir = recordingDir
        binDir = recordingDir.appendingPathComponent("Discarded", isDirectory: true)
        try? fm.createDirectory(at: binDir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUnlessOpen])
        current = try OpenNote(url: { recordingDir.appendingPathComponent("\($0.uuidString).caf") }, recordedAt: now)
    }

    private func newNote(_ now: Date) throws -> OpenNote {
        try OpenNote(url: { self.recordingDir.appendingPathComponent("\($0.uuidString).caf") }, recordedAt: now)
    }

    func write(_ samples: [Float]) throws {
        try current.write(samples)
        guard previous != nil else { return }
        sinceSplit += samples
        if Double(sinceSplit.count) >= Self.undoSeconds * Double(NoteCutter.sampleRate) { settlePrevious() }
    }

    /// Ends the current note and starts the next one.
    func split(now: Date = Date()) throws {
        let next = try newNote(now)
        settlePrevious()
        previous = current
        current = next
    }

    /// Puts the last split back, carrying on in the earlier note. False if it's too late.
    func undoSplit() throws -> Bool {
        guard let previous else { return false }
        try previous.write(sinceSplit)
        current.close()
        try? fm.removeItem(at: current.url)
        current = previous
        self.previous = nil
        sinceSplit = []
        return true
    }

    /// Sets the current note aside and starts it over.
    func discard(now: Date = Date()) throws {
        let next = try newNote(now)
        settlePrevious()
        if let older = discarded { try? fm.removeItem(at: binURL(older.id)) }
        current.close()
        if current.duration >= Self.shortestNote {
            try fm.moveItem(at: current.url, to: binURL(current.id))
            discarded = FinishedNote(id: current.id, recordedAt: current.recordedAt, duration: current.duration)
        } else {
            try? fm.removeItem(at: current.url)
            discarded = nil
        }
        current = next
    }

    /// Brings the last discarded note back as a finished note. False if there isn't one.
    func restore() throws -> Bool {
        guard let note = discarded else { return false }
        try fm.moveItem(at: binURL(note.id), to: recordingDir.appendingPathComponent("\(note.id.uuidString).caf"))
        finished.append(note)
        discarded = nil
        return true
    }

    /// Closes everything and permanently deletes what was discarded. Returns every note, oldest first.
    func close() -> [FinishedNote] {
        settlePrevious()
        keep(current)
        Self.emptyBin(recordingDir: recordingDir)
        discarded = nil
        return finished.sorted { $0.recordedAt < $1.recordedAt }
    }

    private func settlePrevious() {
        if let previous { keep(previous) }
        previous = nil
        sinceSplit = []
    }

    private func keep(_ note: OpenNote) {
        note.close()
        if note.duration >= Self.shortestNote {
            finished.append(FinishedNote(id: note.id, recordedAt: note.recordedAt, duration: note.duration))
        } else {
            try? fm.removeItem(at: note.url)
        }
    }

    private func binURL(_ id: UUID) -> URL { binDir.appendingPathComponent("\(id.uuidString).caf") }

    /// Discarded notes never outlive the session, even one that ended in a crash.
    static func emptyBin(recordingDir: URL) {
        try? FileManager.default.removeItem(at: recordingDir.appendingPathComponent("Discarded", isDirectory: true))
    }

    /// AAC at 16 kHz mono, as `Recorder` writes, or 16-bit PCM if the encoder won't start.
    private static func makeFile(_ url: URL) throws -> AVAudioFile {
        let common: [String: Any] = [AVSampleRateKey: Double(NoteCutter.sampleRate), AVNumberOfChannelsKey: 1]
        var aac = common
        aac[AVFormatIDKey] = kAudioFormatMPEG4AAC
        aac[AVEncoderBitRateKey] = 32_000
        aac[AVEncoderAudioQualityKey] = AVAudioQuality.high.rawValue
        do {
            return try AVAudioFile(forWriting: url, settings: aac, commonFormat: .pcmFormatFloat32, interleaved: false)
        } catch {
            var pcm = common
            pcm[AVFormatIDKey] = kAudioFormatLinearPCM
            pcm[AVLinearPCMBitDepthKey] = 16
            pcm[AVLinearPCMIsFloatKey] = false
            pcm[AVLinearPCMIsBigEndianKey] = false
            return try AVAudioFile(forWriting: url, settings: pcm, commonFormat: .pcmFormatFloat32, interleaved: false)
        }
    }
}
