import AVFoundation
import Foundation
import Observation

/// Recordings on disk, in Application Support (never backed up to iCloud).
///
/// File protection: a recording in progress lives in `Recording/`, protected
/// "complete unless open", so it keeps writing after the phone locks. When it
/// stops it moves to `Memos/` and becomes "complete": unreadable while the phone
/// is locked. Transcripts are always written "complete".
@MainActor @Observable
final class MemoStore {
    private(set) var memos: [Memo] = []

    private let fm = FileManager.default
    private let memosDir: URL
    let recordingDir: URL

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        memosDir = support.appendingPathComponent("Memos", isDirectory: true)
        recordingDir = support.appendingPathComponent("Recording", isDirectory: true)
        makeDirectory(memosDir, protection: .complete)
        makeDirectory(recordingDir, protection: .completeUnlessOpen)
    }

    private func makeDirectory(_ url: URL, protection: FileProtectionType) {
        try? fm.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.protectionKey: protection])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = url
        try? url.setResourceValues(values)
    }

    func audioURL(_ id: UUID) -> URL { memosDir.appendingPathComponent("\(id.uuidString).caf") }
    func recordingURL(_ id: UUID) -> URL { recordingDir.appendingPathComponent("\(id.uuidString).caf") }
    private func jsonURL(_ id: UUID) -> URL { memosDir.appendingPathComponent("\(id.uuidString).json") }

    var waiting: [Memo] { memos.filter { $0.phase != .sent } }
    var sentToday: [Memo] { memos.filter { $0.phase == .sent } }
    var readyToSend: [Memo] { memos.filter { $0.phase == .ready }.sorted { $0.recordedAt < $1.recordedAt } }
    var needsTranscribing: [Memo] { memos.filter { $0.phase == .recorded }.sorted { $0.recordedAt < $1.recordedAt } }

    /// Reads everything back. Receipts from earlier days are dropped, and a recording
    /// cut off by a crash is kept rather than lost.
    func load() {
        var loaded: [Memo] = []
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        for url in (try? fm.contentsOfDirectory(at: memosDir, includingPropertiesForKeys: nil)) ?? [] where url.pathExtension == "json" {
            guard let data = try? Data(contentsOf: url), let memo = try? decoder.decode(Memo.self, from: data) else { continue }
            if memo.phase == .sent, let sentAt = memo.sentAt, !Calendar.current.isDateInToday(sentAt) {
                try? fm.removeItem(at: url)
                continue
            }
            loaded.append(memo)
        }
        for url in (try? fm.contentsOfDirectory(at: recordingDir, includingPropertiesForKeys: nil)) ?? [] {
            guard let id = UUID(uuidString: url.deletingPathExtension().lastPathComponent), !loaded.contains(where: { $0.id == id }) else { continue }
            let duration = (try? AVAudioFile(forReading: url)).map { Double($0.length) / $0.processingFormat.sampleRate } ?? 0
            let created = (try? fm.attributesOfItem(atPath: url.path)[.creationDate] as? Date) ?? Date()
            if duration < 1 {
                try? fm.removeItem(at: url)
                continue
            }
            let memo = Memo(id: id, recordedAt: created, duration: duration, phase: .recorded)
            if (try? adoptRecording(memo)) != nil { loaded.append(memo) }
        }
        memos = loaded.sorted { $0.recordedAt > $1.recordedAt }
    }

    /// Moves a finished recording out of `Recording/` and saves it as a memo waiting to be transcribed.
    func adoptRecording(_ memo: Memo) throws {
        let from = recordingURL(memo.id)
        let to = audioURL(memo.id)
        try? fm.removeItem(at: to)
        try fm.moveItem(at: from, to: to)
        try fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: to.path)
        try save(memo)
    }

    func save(_ memo: Memo) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(memo).write(to: jsonURL(memo.id), options: [.atomic, .completeFileProtection])
        if let i = memos.firstIndex(where: { $0.id == memo.id }) {
            memos[i] = memo
        } else {
            memos.append(memo)
            memos.sort { $0.recordedAt > $1.recordedAt }
        }
    }

    func deleteAudio(_ id: UUID) {
        try? fm.removeItem(at: audioURL(id))
    }

    func delete(_ id: UUID) {
        try? fm.removeItem(at: jsonURL(id))
        try? fm.removeItem(at: audioURL(id))
        try? fm.removeItem(at: recordingURL(id))
        memos.removeAll { $0.id == id }
    }

    /// The Mac has these. Keep a receipt and nothing else.
    func markSent(_ ids: Set<UUID>, to mac: String) {
        for memo in memos where ids.contains(memo.id) && memo.phase == .ready {
            var receipt = memo
            receipt.phase = .sent
            receipt.transcript = nil
            receipt.sentAt = Date()
            receipt.sentTo = mac
            try? save(receipt)
            deleteAudio(memo.id)
        }
    }
}
