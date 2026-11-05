@preconcurrency import AVFoundation
import Foundation
import os

/// One microphone stream, going to two places: straight to the command listener, and through
/// `NoteCutter` to the note files. Everything but `start` and `stop` runs on its own queue.
///
/// Separate from `Recorder` on purpose: that one writes straight from the mic with AVAudioRecorder,
/// which gives no access to the audio, and normal recordings shouldn't change for this.
final class HandsFreeCapture: @unchecked Sendable {
    enum Edit: Sendable {
        case split, pause, resume, discard, undoSplit, restore
        /// Nothing changes, but the command comes out of the audio.
        case none
    }

    /// Long enough for the longest command, the model's delay and a slow moment on a warm phone.
    static let holdSeconds = 6.0

    /// On the capture queue. Hop to the main actor from these.
    var onLevel: (@Sendable (Float) -> Void)?
    var onHeard: (@Sendable ([Float]) -> Void)?
    /// A note file couldn't be written. What's on disk is safe; the session has to end.
    var onFailure: (@Sendable (String) -> Void)?

    private static let log = Logger(subsystem: "care.person2person.echo.mobile", category: "handsfree")
    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "care.person2person.echo.handsfree.capture", qos: .userInitiated)
    private let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(NoteCutter.sampleRate), channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?
    private var cutter = NoteCutter(holdSeconds: HandsFreeCapture.holdSeconds)
    private var desk: NoteDesk
    private var edits: [Int: Edit] = [:]
    private var nextEdit = 0
    private var paused = false
    private var failed = false
    /// While a cue plays on the speaker, the listener hears silence, not Echo talking to itself.
    private var deafUntil = 0
    private var lastAudio = Date()

    init(recordingDir: URL) throws {
        desk = try NoteDesk(recordingDir: recordingDir)
    }

    /// Starts or restarts the mic. Run on the main thread, after the audio session is active.
    /// Restarting (after a call, or when the mic changes) builds the path again for the new format.
    func start() throws {
        engine.stop()
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, let converter = AVAudioConverter(from: format, to: output) else { throw CaptureError.noInput }
        queue.sync {
            self.converter = converter
            self.lastAudio = Date()
        }
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            self?.tapped(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    enum CaptureError: LocalizedError {
        case noInput
        var errorDescription: String? { "The microphone isn’t available." }
    }

    func stopMic() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    /// The mic has gone quiet in a way no notification explained.
    var secondsSinceAudio: TimeInterval { queue.sync { Date().timeIntervalSince(lastAudio) } }

    /// Applies `edit` at the place in the stream where the command was said, cutting the command out.
    /// `endMs` is the command's last word and `nextWordMs` the speech after it, if that's been heard.
    /// `speakerCue`, on a speaker, is the length of the confirmation. The listener ignores that stretch so
    /// it can't act on its own voice, but the note keeps it: a stray "new note" beats losing what was said over it.
    func apply(_ edit: Edit, startMs: Int?, endMs: Int?, nextWordMs: Int?, speakerCue: TimeInterval) {
        queue.async { [self] in
            let rate = NoteCutter.sampleRate / 1000
            let now = cutter.end
            let from = startMs.map { cutter.quietPoint(before: $0 * rate) } ?? now
            var to = from
            if let nextWordMs {
                to = cutter.quietPoint(before: nextWordMs * rate)
            } else if let endMs {
                to = cutter.quietPoint(after: endMs * rate)
            }
            if speakerCue > 0 {
                deafUntil = max(deafUntil, now + Int((speakerCue + 0.15) * Double(NoteCutter.sampleRate)))
            }
            nextEdit += 1
            edits[nextEdit] = edit
            cutter.cut(id: nextEdit, from: from, to: max(from, to))
        }
    }

    /// Cuts the command out and ends the session. Calls back with every note that was kept.
    func finish(startMs: Int?, then done: @escaping @Sendable ([FinishedNote]) -> Void) {
        queue.async { [self] in
            nextEdit += 1
            if let startMs {
                cutter.cut(id: nextEdit, from: cutter.quietPoint(before: startMs * NoteCutter.sampleRate / 1000), to: .max)
            }
            run(cutter.flush())
            done(desk.close())
        }
    }

    private func tapped(_ buffer: AVAudioPCMBuffer) {
        guard let samples = convert(buffer) else { return }
        take(samples)
    }

    private func take(_ samples: [Float]) {
        queue.async { [self] in
            lastAudio = Date()
            onLevel?(Self.level(samples))
            let position = cutter.end
            if position < deafUntil {
                onHeard?([Float](repeating: 0, count: samples.count))
            } else {
                onHeard?(samples)
            }
            run(cutter.append(samples))
        }
    }

    #if DEBUG
        /// Plays a 16 kHz mono file into the pipeline in real time, in place of the mic.
        func debugPlay(_ path: String) {
            Thread.detachNewThread { [self] in
                guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)),
                    let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 1600)
                else { return }
                // Keep going a little past the end: "Okay, finish" needs its silence too.
                var left = 30
                while left > 0 {
                    buffer.frameLength = 0
                    try? file.read(into: buffer)
                    guard let channel = buffer.floatChannelData?[0] else { return }
                    var samples = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
                    if samples.count < 1600 {
                        samples += [Float](repeating: 0, count: 1600 - samples.count)
                        left -= 1
                    }
                    take(samples)
                    Thread.sleep(forTimeInterval: 0.1)
                }
            }
        }
    #endif

    /// To 16 kHz mono. Happens on the tap's thread: the buffer isn't valid after the tap returns.
    private func convert(_ buffer: AVAudioPCMBuffer) -> [Float]? {
        guard let converter else { return nil }
        let ratio = output.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return nil }
        nonisolated(unsafe) var given = false
        nonisolated(unsafe) let source = buffer
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return source
        }
        guard error == nil, let channel = out.floatChannelData?[0] else { return nil }
        return Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
    }

    private func run(_ steps: [NoteCutter.Step]) {
        guard !failed else { return }
        do {
            for step in steps {
                switch step {
                case let .audio(samples):
                    if !paused { try desk.write(samples) }
                case let .cut(id):
                    guard let edit = edits.removeValue(forKey: id) else { continue }
                    try perform(edit)
                }
            }
        } catch {
            failed = true
            Self.log.error("Note file failed: \((error as NSError).code, privacy: .public)")
            onFailure?("Echo couldn’t write to this iPhone’s storage, so the recording stopped. What was recorded is kept.")
        }
    }

    private func perform(_ edit: Edit) throws {
        switch edit {
        case .split:
            try desk.split()
            paused = false
        case .pause:
            paused = true
        case .resume:
            paused = false
        case .discard:
            try desk.discard()
        case .undoSplit:
            _ = try desk.undoSplit()
        case .restore:
            _ = try desk.restore()
        case .none:
            break
        }
    }

    /// 0–1 for the level meter, where -50 dB and below reads as silence, as on the recording screen.
    private static func level(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        let power = samples.reduce(0) { $0 + $1 * $1 } / Float(samples.count)
        let db = 10 * log10(max(power, 1e-10))
        return max(0, min(1, (db + 50) / 50))
    }
}
