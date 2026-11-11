import FluidAudio
import Foundation

// Echo's vocabulary checker, compiled into both the Mac's transcriber helper
// (symlinked into native/transcriber) and the phone app (listed in
// ios/project.yml). After Parakeet transcribes a recording, a second, smaller
// model (Parakeet CTC 110M, about 100 MB) listens to the same audio for the terms
// in vocabulary/clinical.json plus any the user added, and swaps in a term where
// Parakeet wrote something that looks and sounds close to it: "cognitive
// diffusion" becomes "cognitive defusion", "Sir Traline" becomes "sertraline".
// It runs on the device that holds the audio, so audio still never moves.
//
// This is FluidAudio's VocabularyBoostingSession, rebuilt so the model and its
// tokenizer can live in Echo's own model folder rather than FluidAudio's default.

/// One vocabulary entry: the spelling to write, and mishearings to correct to it.
struct VocabularyEntry: Codable, Sendable, Equatable {
    let text: String
    var aliases: [String]? = nil
}

enum VocabularyList {
    /// Reads clinical.json: every array in it holds terms, as strings or {text, aliases}.
    static func entries(fromClinicalJSON data: Data) throws -> [VocabularyEntry] {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        var entries: [VocabularyEntry] = []
        for key in root.keys.sorted() {
            guard let items = root[key] as? [Any] else { continue }
            for item in items {
                if let text = item as? String {
                    entries.append(VocabularyEntry(text: text))
                } else if let object = item as? [String: Any], let text = object["text"] as? String {
                    entries.append(VocabularyEntry(text: text, aliases: object["aliases"] as? [String]))
                }
            }
        }
        return entries
    }

    /// Trims, drops terms too short to check safely, and merges repeats (the later entry's aliases are added).
    static func clean(_ entries: [VocabularyEntry]) -> [VocabularyEntry] {
        var order: [String] = []
        var byKey: [String: VocabularyEntry] = [:]
        for entry in entries {
            let text = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.count >= 3, text.count <= 80 else { continue }
            let aliases = (entry.aliases ?? [])
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { $0.count >= 2 && $0.count <= 80 && $0.lowercased() != text.lowercased() }
            let key = text.lowercased()
            if let existing = byKey[key] {
                let merged = (existing.aliases ?? []) + aliases.filter { !(existing.aliases ?? []).contains($0) }
                byKey[key] = VocabularyEntry(text: existing.text, aliases: merged.isEmpty ? nil : merged)
            } else {
                order.append(key)
                byKey[key] = VocabularyEntry(text: text, aliases: aliases.isEmpty ? nil : aliases)
            }
        }
        return order.compactMap { byKey[$0] }
    }
}

struct VocabularyChecker: Sendable {
    static let variant = CtcModelVariant.ctc110m
    static var folderName: String { variant.repo.folderName }

    let entries: [VocabularyEntry]
    private let vocabulary: CustomVocabularyContext
    private let spotter: CtcKeywordSpotter
    private let rescorer: VocabularyRescorer
    private let sizeConfig: ContextBiasingConstants.VocabSizeConfig

    /// The checker's model folder inside `modelsDir`.
    static func modelFolder(in modelsDir: URL) -> URL {
        modelsDir.appendingPathComponent(folderName, isDirectory: true)
    }

    static func modelsExist(in modelsDir: URL) -> Bool {
        let folder = modelFolder(in: modelsDir)
        return CtcModels.modelsExist(at: folder)
            && FileManager.default.fileExists(atPath: folder.appendingPathComponent("tokenizer.json").path)
    }

    /// Downloads the model (the first time) and loads it.
    static func loadModels(in modelsDir: URL) async throws -> CtcModels {
        let folder = modelFolder(in: modelsDir)
        if !modelsExist(in: modelsDir) {
            try await CtcModels.download(to: folder, variant: variant, force: CtcModels.modelsExist(at: folder))
        }
        return try await CtcModels.load(from: folder, variant: variant)
    }

    /// Builds a checker for these terms. Loading the model is the slow part, so keep `models` to rebuild for new terms.
    init(models: CtcModels, modelsDir: URL, entries: [VocabularyEntry]) async throws {
        let folder = Self.modelFolder(in: modelsDir)
        let tokenizer = try await CtcTokenizer.load(from: folder)
        let cleaned = VocabularyList.clean(entries)
        let terms = cleaned.compactMap { entry -> CustomVocabularyTerm? in
            let ids = tokenizer.encode(entry.text)
            return ids.isEmpty ? nil : CustomVocabularyTerm(text: entry.text, aliases: entry.aliases, ctcTokenIds: ids)
        }
        self.entries = cleaned
        vocabulary = CustomVocabularyContext(terms: terms)
        spotter = CtcKeywordSpotter(models: models, blankId: models.vocabulary.count)
        rescorer = try await VocabularyRescorer.create(spotter: spotter, vocabulary: vocabulary, ctcModelDirectory: folder)
        sizeConfig = ContextBiasingConstants.rescorerConfig(forVocabSize: terms.count)
    }

    /// The transcript with vocabulary corrections applied, or unchanged if there are none
    /// (or the check fails: it must never cost a transcript).
    func check(_ result: ASRResult, audio: [Float]) async -> String {
        let text = result.text
        guard !vocabulary.terms.isEmpty, let timings = result.tokenTimings, !timings.isEmpty, !audio.isEmpty else { return text }
        do {
            let spotted = try await spotter.spotKeywordsWithLogProbs(audioSamples: audio, customVocabulary: vocabulary, minScore: nil)
            guard !spotted.logProbs.isEmpty else { return text }
            let output = rescorer.ctcTokenRescore(
                transcript: text,
                tokenTimings: timings,
                logProbs: spotted.logProbs,
                frameDuration: spotted.frameDuration,
                cbw: sizeConfig.cbw,
                marginSeconds: 0.5,
                minSimilarity: max(sizeConfig.minSimilarity, vocabulary.minSimilarity)
            )
            guard output.wasModified else { return text }
            let swaps = output.replacements.compactMap { r -> (String, String)? in
                guard r.shouldReplace, let term = r.replacementWord else { return nil }
                return (r.originalWord, term)
            }
            return VocabularySwaps.apply(swaps, to: text, terms: entries.map(\.text))
        } catch {
            return text
        }
    }
}

/// Applies the checker's corrections to the transcript as Parakeet wrote it. FluidAudio's own
/// rebuilt text drops punctuation and can swallow neighbouring words into a term ("no anhedonia"
/// came back as "anhedonia"), so each correction is placed here instead, and only if it is safe:
/// it replaces the misheard words and nothing else.
enum VocabularySwaps {
    /// Never swallowed into a term: losing one reverses what the clinician said.
    static let protected: Set<String> = [
        "no", "not", "never", "nor", "none", "neither", "without", "deny", "denies", "denied", "denying",
        "negative", "absent", "non", "isnt", "doesnt", "didnt", "dont", "wasnt", "werent", "arent", "hasnt",
        "havent", "hadnt", "cant", "cannot", "couldnt", "wont", "wouldnt", "shouldnt",
    ]
    /// Small words a term mustn't absorb either ("his obsessive-compulsive disorder", "radical acceptance and").
    static let small: Set<String> = [
        "a", "an", "the", "and", "or", "but", "of", "to", "for", "with", "on", "in", "at", "by", "from", "as",
        "is", "was", "are", "were", "be", "he", "she", "they", "it", "his", "her", "hers", "their", "them",
        "him", "my", "your", "our", "its", "this", "that", "these", "those", "so", "if", "also", "plus", "then",
    ]

    private struct Word {
        let range: Range<String.Index>
        let key: String
    }

    static func key<S: StringProtocol>(_ word: S) -> String {
        String(word.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
    }

    static func keys(_ phrase: String) -> [String] {
        phrase.split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "/" }).map(key).filter { !$0.isEmpty }
    }

    private static func words(_ text: String) -> [Word] {
        var found: [Word] = []
        var start: String.Index?
        var i = text.startIndex
        func close(_ end: String.Index) {
            if let s = start {
                let k = key(text[s..<end])
                if !k.isEmpty { found.append(Word(range: s..<end, key: k)) }
            }
            start = nil
        }
        while i < text.endIndex {
            if text[i].isWhitespace || text[i] == "-" || text[i] == "/" { close(i) } else if start == nil { start = i }
            i = text.index(after: i)
        }
        close(text.endIndex)
        return found
    }

    /// True for a different form of the same word ("titrating"/"titration", "defused"/"defusion",
    /// "distortion"/"distortions"): that's the speaker's grammar, not a mishearing.
    static func isInflection(_ a: String, _ b: String) -> Bool {
        guard a != b else { return false }
        let common = zip(a, b).prefix { $0 == $1 }.count
        return common >= 4 && a.count - common <= 3 && b.count - common <= 3
    }

    /// 1 for the same letters, 0 for nothing in common (Levenshtein, scaled by the longer word).
    static func similarity(_ a: String, _ b: String) -> Double {
        let x = Array(a), y = Array(b)
        guard !x.isEmpty, !y.isEmpty else { return 0 }
        var row = Array(0...y.count)
        for i in 1...x.count {
            var previous = row[0]
            row[0] = i
            for j in 1...y.count {
                let saved = row[j]
                row[j] = min(row[j] + 1, row[j - 1] + 1, previous + (x[i - 1] == y[j - 1] ? 0 : 1))
                previous = saved
            }
        }
        return 1 - Double(row[y.count]) / Double(max(x.count, y.count))
    }

    /// Whether replacing these transcript words with the term only fixes a mishearing.
    static func isSafe(span: [String], term: [String]) -> Bool {
        guard !span.isEmpty, !term.isEmpty else { return false }
        let termSet = Set(term)
        // Never absorb a negation or a small word the term doesn't have.
        if span.contains(where: { (protected.contains($0) || small.contains($0)) && !termSet.contains($0) }) { return false }
        if span.count == term.count {
            // Word for word: each changed word must be a near-miss of its counterpart, not a different
            // word ("no hallucinations" isn't "command hallucinations") or another form of it.
            return zip(span, term).allSatisfy { s, t in s == t || (similarity(s, t) >= 0.4 && !isInflection(s, t)) }
        }
        // Split or run together ("lamo trigine", "selfascontext"): the letters must still match closely.
        guard abs(span.count - term.count) <= 1 else { return false }
        return similarity(span.joined(), term.joined()) >= 0.6
    }

    /// Applies corrections (in any order) to the transcript. Words that already spell one of
    /// `terms` are left alone: "response prevention" mustn't become "response perseveration".
    static func apply(_ swaps: [(original: String, term: String)], to text: String, terms: [String] = []) -> String {
        let all = words(text)
        var locked = Array(repeating: false, count: all.count)
        for term in Set(terms.map(keys)) where !term.isEmpty && term.count <= all.count {
            for i in 0...(all.count - term.count) where all[i..<(i + term.count)].map(\.key) == term {
                for j in i..<(i + term.count) { locked[j] = true }
            }
        }
        var edits: [(range: Range<String.Index>, at: Range<Int>, text: String)] = []
        for (original, term) in swaps {
            let span = keys(original), termKeys = keys(term)
            guard isSafe(span: span, term: termKeys), span.count <= all.count else { continue }
            let starts = (0...(all.count - span.count)).filter { i in
                all[i..<(i + span.count)].map(\.key) == span
                    && !locked[i..<(i + span.count)].contains(true)
                    && !edits.contains { $0.at.overlaps(i..<(i + span.count)) }
            }
            // Only one place it could be: if the same words appear twice, there's no telling which was misheard.
            guard starts.count == 1, let at = starts.first else { continue }
            let first = all[at], last = all[at + span.count - 1]
            // Keep punctuation at the edges ("eriprazole," keeps its comma); don't join across a sentence.
            let core = coreRange(first.range.lowerBound..<last.range.upperBound, in: text)
            if text[core].contains(where: { ".?!;:,".contains($0) }) { continue }
            var replacement = term
            if let c = text[core].first, c.isUppercase, let t = term.first, t.isLowercase {
                replacement = t.uppercased() + term.dropFirst()
            }
            edits.append((core, at..<(at + span.count), replacement))
        }
        var result = text
        for edit in edits.sorted(by: { $0.range.lowerBound > $1.range.lowerBound }) {
            result.replaceSubrange(edit.range, with: edit.text)
        }
        return result
    }

    /// The range without leading or trailing punctuation.
    private static func coreRange(_ range: Range<String.Index>, in text: String) -> Range<String.Index> {
        var lower = range.lowerBound, upper = range.upperBound
        while lower < upper, !text[lower].isLetter, !text[lower].isNumber { lower = text.index(after: lower) }
        while upper > lower {
            let before = text.index(before: upper)
            if text[before].isLetter || text[before].isNumber { break }
            upper = before
        }
        return lower..<upper
    }
}
