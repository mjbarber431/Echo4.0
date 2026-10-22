import Foundation

/// One dictated session summary. It's recorded, transcribed on the phone, then
/// handed to Echo on the Mac. Once the Mac confirms it has it, the transcript is
/// deleted and only a receipt (time and length, no content) stays until the end of the day.
struct Memo: Codable, Identifiable, Equatable, Sendable {
    enum Phase: String, Codable, Sendable {
        /// Audio saved, waiting to be transcribed.
        case recorded
        /// Transcribed, waiting for the Mac.
        case ready
        /// Couldn't be transcribed. The audio is kept so it can be tried again.
        case failed
        /// The Mac has it. Nothing but the receipt is left on the phone.
        case sent
    }

    let id: UUID
    let recordedAt: Date
    var duration: TimeInterval
    var phase: Phase
    var transcript: String?
    var problem: String?
    var sentAt: Date?
    var sentTo: String?

    /// The opening words, which name the client, so a recording can be told apart from the others.
    var preview: String? {
        guard let transcript, !transcript.isEmpty else { return nil }
        let words = transcript.split(whereSeparator: \.isWhitespace).prefix(12)
        return words.joined(separator: " ") + (words.count == 12 ? "…" : "")
    }
}

extension TimeInterval {
    /// 0:42, 12:05, 1:02:10
    var clock: String {
        let total = Int(self.rounded(.down))
        let (h, m, s) = (total / 3600, total / 60 % 60, total % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// "42 sec", "12 min"
    var spoken: String {
        self < 60 ? "\(max(1, Int(self.rounded()))) sec" : "\(Int((self / 60).rounded())) min"
    }
}
