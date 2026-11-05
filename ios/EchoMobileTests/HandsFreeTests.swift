import AVFoundation
import XCTest

@testable import Echo

final class CommandSpotterTests: XCTestCase {
    /// Feeds a sentence as the speech model would: tokens late, with time passing afterwards.
    /// Each word is (text, ms). Splitting into pieces is covered by `testWordsArriveInPieces`.
    private func spot(_ words: [(String, Int)], trailMs: Int = 3000) -> [SpottedCommand] {
        var spotter = CommandSpotter()
        var found: [SpottedCommand] = []
        var next = 0
        let last = (words.last?.1 ?? 0) + trailMs
        for heard in stride(from: 100, through: last, by: 100) {
            var end = next
            while end < words.count, words[end].1 + 700 <= heard { end += 1 }
            let tokens = words[next..<end].map { "▁" + $0.0 }
            let times = words[next..<end].map(\.1)
            if let hit = spotter.feed(tokens: tokens[...], timesMs: times[...], heardMs: heard) { found.append(hit) }
            next = end
        }
        return found
    }

    func testEveryCommand() {
        let cases: [(String, HandsFreeCommand)] = [
            ("new note", .newNote), ("next note", .newNote), ("pause", .pause), ("resume", .resume), ("continue", .resume),
            ("discard note", .discard), ("scratch that", .discard), ("undo", .undo), ("finish", .finish),
            ("stopped recording", .finish), ("status", .status), ("help", .help), ("where am i", .status),
        ]
        for (phrase, command) in cases {
            var at = 1400
            let words = phrase.split(separator: " ").map { word -> (String, Int) in
                at += 250
                return (String(word), at)
            }
            XCTAssertEqual(spot([("echo", 1000)] + words).map(\.command), [command], phrase)
        }
    }

    func testWordsArriveInPieces() {
        var spotter = CommandSpotter()
        let tokens = ["▁e", "ch", "o", "▁new", "▁not", "e"]
        let times = [1000, 1000, 1200, 1700, 1800, 1900]
        XCTAssertNil(spotter.feed(tokens: tokens[...], timesMs: times[...], heardMs: 2400))
        XCTAssertEqual(spotter.feed(tokens: [], timesMs: [], heardMs: 3000)?.command, .newNote)
    }

    func testEchoIsKeptWhileItsCommandIsOnItsWay() {
        // The bug this guards: "Echo" alone for a second shouldn't be forgotten.
        XCTAssertEqual(spot([("echo", 1000), ("pause", 2200)]).map(\.command), [.pause])
    }

    func testCarryingStraightOnAfterAPauseStillCounts() {
        let hit = spot([("echo", 1000), ("new", 1400), ("note", 1600), ("the", 2000), ("next", 2200)]).first
        XCTAssertEqual(hit?.command, .newNote)
        XCTAssertEqual(hit?.nextWordMs, 2000)
    }

    func testOrdinarySpeechDoesNothing() {
        let sentences: [[(String, Int)]] = [
            [("still", 800), ("echo", 1000), ("in", 1200), ("her", 1400), ("head", 1600)],
            [("an", 900), ("echo", 1000), ("stopped", 1300)], // A noun, not a command.
            [("the", 900), ("echo", 1000), ("paused", 1300)],
            [("echo", 1000), ("pause", 1250), ("there", 1450), ("for", 1650)], // Runs on.
            [("echo", 1000), ("new", 1200), ("note", 1400), ("of", 1600), ("hope", 1800)],
            [("echo", 1000), ("pause", 1250), ("there", 1600), ("for", 1800)], // Runs on, a little slower.
            [("we", 800), ("will", 1000), ("pause", 1200)], // No "Echo".
            [("echo", 1000), ("pause", 4000)], // Too long after "Echo".
        ]
        for words in sentences { XCTAssertEqual(spot(words), [], "\(words)") }
    }

    func testTwoCommandsInARow() {
        let found = spot([("echo", 1000), ("pause", 1300), ("echo", 4000), ("resume", 4300)])
        XCTAssertEqual(found.map(\.command), [.pause, .resume])
    }
}

final class NoteCutterTests: XCTestCase {
    private func ramp(_ range: Range<Int>) -> [Float] { range.map(Float.init) }

    private func audio(_ steps: [NoteCutter.Step]) -> [Float] {
        steps.flatMap { step -> [Float] in
            if case let .audio(samples) = step { return samples }
            return []
        }
    }

    func testHoldsAudioBack() {
        var cutter = NoteCutter(holdSeconds: 1)
        XCTAssertEqual(audio(cutter.append(ramp(0..<16_000))), [])
        XCTAssertEqual(audio(cutter.append(ramp(16_000..<16_100))), ramp(0..<100))
        XCTAssertEqual(audio(cutter.flush()), ramp(100..<16_100))
    }

    func testCutRemovesTheCommandAndMarksTheSpot() {
        var cutter = NoteCutter(holdSeconds: 1)
        var steps = cutter.append(ramp(0..<20_000))
        cutter.cut(id: 7, from: 1_000, to: 3_000) // Already released up to 4,000: too late, see below.
        steps += cutter.flush()
        XCTAssertTrue(steps.contains(.cut(7)))
        var late = NoteCutter(holdSeconds: 1)
        var parts: [[Float]] = [[]]
        late.cut(id: 1, from: 18_000, to: 19_000)
        for step in late.append(ramp(0..<40_000)) + late.flush() {
            switch step {
            case let .audio(samples): parts[parts.count - 1] += samples
            case .cut: parts.append([])
            }
        }
        XCTAssertEqual(parts, [ramp(0..<18_000), ramp(19_000..<40_000)])
    }

    func testCutCanReachIntoTheFuture() {
        var cutter = NoteCutter(holdSeconds: 0.1)
        cutter.cut(id: 1, from: 100, to: 5_000)
        let out = audio(cutter.append(ramp(0..<10_000))) + audio(cutter.flush())
        XCTAssertEqual(out, ramp(0..<100) + ramp(5_000..<10_000))
    }

    func testCutsHappenInOrder() {
        var cutter = NoteCutter(holdSeconds: 0.1)
        cutter.cut(id: 2, from: 2_000, to: 2_100)
        cutter.cut(id: 1, from: 1_000, to: 1_100)
        let order = (cutter.append(ramp(0..<10_000)) + cutter.flush()).compactMap { step -> Int? in
            if case let .cut(id) = step { return id }
            return nil
        }
        XCTAssertEqual(order, [1, 2])
    }

    func testFlushRunsCutsThatHaventBeenReached() {
        var cutter = NoteCutter(holdSeconds: 5)
        _ = cutter.append(ramp(0..<1_000))
        cutter.cut(id: 1, from: 500, to: .max)
        let steps = cutter.flush()
        XCTAssertEqual(audio(steps), ramp(0..<500))
        XCTAssertTrue(steps.contains(.cut(1)))
    }

    func testCutEndsWhereTheCommandEndsNotWhereItWasAccepted() {
        var cutter = NoteCutter(holdSeconds: 6)
        // The command's sound runs to 20,000; the next note starts at 22,000. The model's last
        // token says 18,000, and by the time it's accepted, at 30,000, the next note is well under way.
        let loud: (Range<Int>) -> [Float] = { range in range.map { $0 % 2 == 0 ? 0.5 : -0.5 } }
        _ = cutter.append(loud(0..<20_000) + [Float](repeating: 0, count: 2_000) + loud(22_000..<30_000))
        let point = cutter.quietPoint(after: 18_000, withinMs: 700)
        XCTAssertTrue((20_000...21_000).contains(point), "\(point)")
    }

    func testQuietPointFindsTheGapBeforeTheWord() {
        var cutter = NoteCutter(holdSeconds: 6)
        // Loud, a quiet gap from 16,000 to 20,000, then the command, whose token time is later than its start.
        let loud: (Range<Int>) -> [Float] = { range in range.map { $0 % 2 == 0 ? 0.5 : -0.5 } }
        _ = cutter.append(loud(0..<16_000) + [Float](repeating: 0, count: 4_000) + loud(20_000..<30_000))
        let point = cutter.quietPoint(before: 24_000)
        XCTAssertTrue((19_000...20_400).contains(point), "\(point)")
    }
}

final class NoteDeskTests: XCTestCase {
    private var dir: URL!
    private let second = [Float](repeating: 0.1, count: NoteCutter.sampleRate)

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func files() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".caf") }
    }

    private func length(_ note: FinishedNote) throws -> Double {
        let file = try AVAudioFile(forReading: dir.appendingPathComponent("\(note.id.uuidString).caf"))
        return Double(file.length) / file.processingFormat.sampleRate
    }

    func testSplitMakesTwoNotesInOrder() throws {
        let desk = try NoteDesk(recordingDir: dir)
        try desk.write(second + second)
        try desk.split(now: Date().addingTimeInterval(5))
        try desk.write(second + second + second)
        let notes = desk.close()
        XCTAssertEqual(notes.map(\.duration), [2, 3])
        XCTAssertEqual(try length(notes[0]), 2, accuracy: 0.2)
        XCTAssertEqual(try length(notes[1]), 3, accuracy: 0.2)
        XCTAssertEqual(files().count, 2)
    }

    func testAnEmptyLastNoteLeavesNothing() throws {
        let desk = try NoteDesk(recordingDir: dir)
        try desk.write(second + second)
        try desk.split()
        XCTAssertEqual(desk.close().count, 1)
        XCTAssertEqual(files().count, 1)
    }

    func testUndoSplitPutsTheAudioBack() throws {
        let desk = try NoteDesk(recordingDir: dir)
        try desk.write(second + second)
        try desk.split()
        try desk.write(second)
        XCTAssertTrue(try desk.undoSplit())
        try desk.write(second)
        let notes = desk.close()
        XCTAssertEqual(notes.map(\.duration), [4])
        XCTAssertEqual(try length(notes[0]), 4, accuracy: 0.2)
    }

    func testSplitCanOnlyBeUndoneForAMinute() throws {
        let desk = try NoteDesk(recordingDir: dir)
        try desk.write(second + second)
        try desk.split()
        for _ in 0..<61 { try desk.write(second) }
        XCTAssertFalse(try desk.undoSplit())
        XCTAssertEqual(desk.close().count, 2)
    }

    func testDiscardDeletesTheNoteAtTheEnd() throws {
        let desk = try NoteDesk(recordingDir: dir)
        try desk.write(second + second)
        try desk.discard()
        try desk.write(second + second)
        let notes = desk.close()
        XCTAssertEqual(notes.count, 1)
        XCTAssertEqual(files().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("Discarded").path))
    }

    func testRestoreBringsADiscardedNoteBack() throws {
        let desk = try NoteDesk(recordingDir: dir)
        try desk.write(second + second)
        try desk.discard()
        try desk.write(second + second + second)
        XCTAssertTrue(try desk.restore())
        XCTAssertFalse(try desk.restore())
        let notes = desk.close()
        XCTAssertEqual(notes.map(\.duration), [2, 3])
        XCTAssertEqual(try length(notes[0]), 2, accuracy: 0.2)
    }

    func testOnlyTheLastDiscardCanComeBack() throws {
        let desk = try NoteDesk(recordingDir: dir)
        try desk.write(second + second)
        try desk.discard()
        try desk.write(second + second + second)
        try desk.discard()
        XCTAssertTrue(try desk.restore())
        XCTAssertEqual(desk.close().map(\.duration), [3])
    }

    func testADiscardedNoteIsntRecoveredAfterACrash() throws {
        let desk = try NoteDesk(recordingDir: dir)
        try desk.write(second + second)
        try desk.discard()
        NoteDesk.emptyBin(recordingDir: dir) // What launch does.
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("Discarded").path))
    }
}

@MainActor
final class HandsFreeCueTests: XCTestCase {
    func testEveryCueHasItsFile() {
        var cues: [HandsFreeCues.Cue] = [.ready, .paused, .resumed, .discarded, .restored, .undone, .saved, .nothingSaved, .nothingToUndo, .micChanged, .commandsStopped, .problem, .help]
        cues += (1...25).flatMap { [HandsFreeCues.Cue.note($0), .status($0)] }
        for cue in cues {
            for style in HandsFreeSettings.Confirmation.allCases {
                for voice in HandsFreeSettings.Voice.allCases {
                    let name = HandsFreeCues.fileName(cue, style: style, voice: voice) as NSString
                    XCTAssertNotNil(Bundle.main.url(forResource: name.deletingPathExtension, withExtension: name.pathExtension), name as String)
                }
            }
        }
    }

    func testSettingsAreRememberedAndOffByDefault() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let settings = HandsFreeSettings(defaults: defaults)
        XCTAssertFalse(settings.enabled)
        XCTAssertFalse(settings.armed)
        XCTAssertEqual(settings.confirmation, .chimes)
        settings.enabled = true
        settings.armed = true
        settings.confirmation = .voice
        settings.voice = .eric
        let again = HandsFreeSettings(defaults: defaults)
        XCTAssertTrue(again.enabled)
        XCTAssertTrue(again.armed)
        XCTAssertEqual(again.confirmation, .voice)
        XCTAssertEqual(again.voice, .eric)
    }
}
