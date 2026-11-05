import Foundation

/// What can be said in hands-free mode. Every command starts with "Okay".
enum HandsFreeCommand: String, CaseIterable, Sendable {
    case newNote, pause, resume, discard, undo, finish, status, help

    /// How each one can be said, after "Okay", as the speech model writes it: lowercase, no
    /// punctuation. Includes the ways the model was heard to mishear them ("stopped recording").
    /// Nothing a person says on the way to their next sentence belongs here: "okay, next",
    /// "okay, scratch that" and "okay, done" are dictation, not commands.
    fileprivate var phrases: [String] {
        switch self {
        case .newNote: ["new note", "new notes", "next note", "next notes", "start new note", "start a new note"]
        case .pause: ["pause", "paused", "pauses", "paws", "pause recording", "pause that"]
        case .resume: ["resume", "resumed", "resume recording", "unpause"]
        case .discard: [
                "discard", "discarded", "discard note", "discard notes", "discard that", "discard this", "discard this note",
                "discard the note", "delete note", "delete this note",
            ]
        case .undo: ["undo", "undo that", "undid"]
        case .finish: ["finish", "finished", "finish up", "stop recording", "stopped recording", "end session"]
        case .status: ["status", "where am i", "what note", "which note", "what note am i on"]
        case .help: ["help", "health", "commands"]
        }
    }
}

/// A command heard in the speech stream. Times are milliseconds from the start of the session.
struct SpottedCommand: Equatable, Sendable {
    let command: HandsFreeCommand
    /// When the speech model placed "Okay". The real start is a little earlier: see `NoteCutter.quietPoint`.
    let startMs: Int
    /// When the speech model placed the last word.
    let endMs: Int
    /// When the next word starts, if the speaker carried straight on. It belongs to the next note.
    let nextWordMs: Int?
    /// How much audio had been heard when the command was accepted.
    let heardMs: Int
}

/// Finds "Okay, <command>" in the words the streaming speech model produces. It has only
/// the last few words, and they're dropped after use: nothing here keeps what was dictated.
///
/// People say "okay" constantly, and discarding a note on a false alarm would be bad, so this
/// is deliberately strict: a pause must come before "Okay" (mid-sentence it's just a word:
/// "she said okay pause"), it must come straight before a known phrase, and a pause must follow
/// that (running on means it's a sentence: "okay pause there for a while").
struct CommandSpotter: Sendable {
    /// Silence needed after the last word when nothing follows it. Tokens arrive about 0.65 s
    /// after their audio, so this has to outlast that delay plus `pauseAfterMs`, or a sentence
    /// that runs on would be accepted before its next word shows up.
    static let quietAfterMs = 1100
    /// The gap before the next word that counts as a pause. Measured on the speech model's
    /// timestamps: words in a sentence are about 240 ms apart, and at least 480 ms follows a command.
    static let pauseAfterMs = 400
    /// The gap after the previous word that counts as a pause. Words in a sentence can sit
    /// 320 ms apart on the speech model's timestamps, so this has to be longer than that.
    static let pauseBeforeMs = 400
    /// The most that can pass between "Okay" and the command.
    static let maxGapMs = 1500

    private struct Word: Sendable {
        var text: String
        var startMs: Int
        var endMs: Int
    }

    private static let wakeWords: Set<String> = ["okay", "ok", "okey"]
    private static let fillers: Set<String> = ["um", "uh", "ah", "er", "please"]
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
            if i > 0, wake.startMs - words[i - 1].endMs < Self.pauseBeforeMs { continue }
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
        // Long enough that a trailing "Okay" can't still be waiting for its command, whose tokens arrive late.
        if let last = words.last, heardMs - last.endMs >= Self.maxGapMs + Self.quietAfterMs { words.removeAll() }
        return nil
    }

    private static func clean(_ token: String) -> String {
        token.lowercased().filter { $0.isLetter }
    }
}
