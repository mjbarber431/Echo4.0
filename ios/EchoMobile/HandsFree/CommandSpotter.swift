import Foundation

/// What can be said in hands-free mode. Every command starts with "Echo".
enum HandsFreeCommand: String, CaseIterable, Sendable {
    case newNote, pause, resume, discard, undo, finish, status, help

    /// How each one can be said, after "Echo", as the speech model writes it: lowercase, no
    /// punctuation. Includes the ways the model was heard to mishear them ("stopped recording").
    fileprivate var phrases: [String] {
        switch self {
        case .newNote: ["new note", "new notes", "next note", "next notes", "next", "start new note", "start a new note"]
        case .pause: ["pause", "paused", "pauses", "paws", "pause recording", "pause that"]
        case .resume: ["resume", "resumed", "resume recording", "continue", "keep going", "unpause"]
        case .discard: [
                "discard", "discarded", "discard note", "discard notes", "discard that", "discard this", "discard this note",
                "discard the note", "delete note", "delete that", "delete this note", "scratch that", "scratch this", "scrap that", "scrap this",
            ]
        case .undo: ["undo", "undo that", "undid", "take that back"]
        case .finish: [
                "finish", "finished", "finish up", "stop", "stopped", "stop recording", "stopped recording", "done", "im done", "all done",
                "end session",
            ]
        case .status: ["status", "where am i", "what note", "which note", "what note am i on"]
        case .help: ["help", "health", "commands"]
        }
    }
}

/// A command heard in the speech stream. Times are milliseconds from the start of the session.
struct SpottedCommand: Equatable, Sendable {
    let command: HandsFreeCommand
    /// When the speech model placed "Echo". The real start is a little earlier: see `NoteCutter.quietPoint`.
    let startMs: Int
    /// When the speech model placed the last word.
    let endMs: Int
    /// When the next word starts, if the speaker carried straight on. It belongs to the next note.
    let nextWordMs: Int?
    /// How much audio had been heard when the command was accepted.
    let heardMs: Int
}

/// Finds "Echo, <command>" in the words the streaming speech model produces. It has only
/// the last few words, and they're dropped after use: nothing here keeps what was dictated.
///
/// Discarding a note on a false alarm would be bad, so this is deliberately strict:
/// "Echo" must come straight before a known phrase, a pause must follow it (running on means
/// it's a sentence: "echo pause there for a while"), and the word before can't make
/// "echo" a noun ("the echo stopped").
struct CommandSpotter: Sendable {
    /// Silence needed after the last word when nothing follows it. Tokens arrive about 0.65 s
    /// after their audio, so this has to outlast that delay plus `pauseAfterMs`, or a sentence
    /// that runs on would be accepted before its next word shows up.
    static let quietAfterMs = 1100
    /// The gap before the next word that counts as a pause. Measured on the speech model's
    /// timestamps: words in a sentence are about 240 ms apart, and at least 480 ms follows a command.
    static let pauseAfterMs = 400
    /// The most that can pass between "Echo" and the command.
    static let maxGapMs = 1500

    private struct Word: Sendable {
        var text: String
        var startMs: Int
        var endMs: Int
    }

    private static let wakeWords: Set<String> = ["echo", "ecco", "eco", "ecko", "ekko"]
    private static let fillers: Set<String> = ["um", "uh", "ah", "er", "please"]
    /// "the echo stopped", "an echo paused", "her echo finished".
    private static let nounMarkers: Set<String> = ["a", "an", "the", "this", "that", "my", "your", "his", "her", "their", "our"]
    private static let lookup: [String: HandsFreeCommand] = {
        var map: [String: HandsFreeCommand] = [:]
        for command in HandsFreeCommand.allCases {
            for phrase in command.phrases { map[phrase] = command }
        }
        return map
    }()
    private static let longestPhrase = lookup.keys.map { $0.split(separator: " ").count }.max() ?? 1

    private var words: [Word] = []

    /// Adds newly decoded tokens (SentencePiece pieces; "▁" starts a word) and returns a command
    /// if one has just been completed. Call it often, even with no tokens: the time
    /// passing is what shows the speaker has stopped.
    mutating func feed(tokens: ArraySlice<String>, timesMs: ArraySlice<Int>, heardMs: Int) -> SpottedCommand? {
        for (token, ms) in zip(tokens, timesMs) {
            if token.hasPrefix("▁") || words.isEmpty {
                words.append(Word(text: Self.clean(token), startMs: ms, endMs: ms))
            } else {
                words[words.count - 1].text += Self.clean(token)
                words[words.count - 1].endMs = ms
            }
        }
        let keep = Self.longestPhrase + 6
        if words.count > keep { words.removeFirst(words.count - keep) }
        return match(heardMs: heardMs)
    }

    private mutating func match(heardMs: Int) -> SpottedCommand? {
        for (i, wake) in words.enumerated() where Self.wakeWords.contains(wake.text) {
            if i > 0, Self.nounMarkers.contains(words[i - 1].text), wake.startMs - words[i - 1].endMs < 500 { continue }
            // Longest first: "stop recording" rather than "stop".
            var last = min(words.count - 1, i + Self.longestPhrase + 2)
            while last > i {
                defer { last -= 1 }
                let spoken = words[(i + 1)...last].filter { !Self.fillers.contains($0.text) }
                guard let first = spoken.first, first.startMs - wake.endMs <= Self.maxGapMs,
                    let command = Self.lookup[spoken.map(\.text).joined(separator: " ")]
                else { continue }
                let end = words[last].endMs
                if last + 1 < words.count {
                    let next = words[last + 1]
                    guard next.startMs - end >= Self.pauseAfterMs else { continue }
                    words.removeFirst(last + 1)
                    return SpottedCommand(command: command, startMs: wake.startMs, endMs: end, nextWordMs: next.startMs, heardMs: heardMs)
                }
                guard heardMs - end >= Self.quietAfterMs else { return nil } // Not sure yet: wait and see.
                words.removeAll()
                return SpottedCommand(command: command, startMs: wake.startMs, endMs: end, nextWordMs: nil, heardMs: heardMs)
            }
        }
        // Long enough that a trailing "Echo" can't still be waiting for its command, whose tokens arrive late.
        if let last = words.last, heardMs - last.endMs >= Self.maxGapMs + Self.quietAfterMs { words.removeAll() }
        return nil
    }

    private static func clean(_ token: String) -> String {
        token.lowercased().filter { $0.isLetter }
    }
}
