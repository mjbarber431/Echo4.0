import FluidAudio
import Foundation
import Observation
import os

/// Speech-to-text on the phone: NVIDIA's Parakeet (English v2, the model Echo on
/// the Mac uses by default) on the Neural Engine through FluidAudio. Audio never
/// leaves the phone. The model (about 450 MB) downloads once from Hugging Face.
@MainActor @Observable
final class SpeechModel {
    enum Status: Equatable {
        case notDownloaded
        case downloading(Double)
        case loading
        case ready
        case failed(String)
    }

    private(set) var status: Status
    private let engine = SpeechEngine()
    private var preparing: Task<Void, Never>?
    /// Called each time the model finishes loading, so recordings waiting for it get transcribed.
    var onReady: (() -> Void)?

    /// Set once the model has loaded on this phone, so later launches load it without asking.
    private static let downloadedKey = "speechModelDownloaded"
    var isDownloaded: Bool { UserDefaults.standard.bool(forKey: Self.downloadedKey) }

    init() {
        status = UserDefaults.standard.bool(forKey: Self.downloadedKey) ? .loading : .notDownloaded
    }

    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Models", isDirectory: true)
    }

    /// Makes the folder models live in, kept out of iCloud backups.
    static func makeDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var dir = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
    }

    /// Downloads (the first time) and loads the model. Safe to call repeatedly. `repair` allows a
    /// model that won't load to be deleted and downloaded again, which should only follow a tap.
    func prepare(repair: Bool = false) {
        if status == .ready || preparing != nil { return }
        preparing = Task {
            defer { preparing = nil }
            status = isDownloaded ? .loading : .downloading(0)
            do {
                try Self.makeDirectory()
                try await engine.prepare(in: Self.directory, keepFiles: isDownloaded && !repair) { fraction, downloading in
                    Task { @MainActor in
                        if self.status != .ready { self.status = downloading ? .downloading(fraction) : .loading }
                    }
                }
                UserDefaults.standard.set(true, forKey: Self.downloadedKey)
                status = .ready
                onReady?()
                startChecker()
            } catch {
                status = .failed(error.localizedDescription)
            }
        }
    }

    func transcribe(_ url: URL) async throws -> String {
        try await engine.transcribe(url)
    }

    /// The clinician's own terms, as the Mac last sent them. Kept with file protection, like recordings.
    private static var customVocabularyURL: URL { directory.appendingPathComponent("custom-vocabulary.json") }

    private static func savedCustomVocabulary() -> [VocabularyEntry] {
        guard let data = try? Data(contentsOf: customVocabularyURL) else { return [] }
        return (try? JSONDecoder().decode([VocabularyEntry].self, from: data)) ?? []
    }

    /// Saves the Mac's custom terms and, if they changed, has the vocabulary checker use them.
    func setCustomVocabulary(_ terms: [VocabularyEntry]) {
        guard terms != Self.savedCustomVocabulary() else { return }
        try? Self.makeDirectory()
        try? JSONEncoder().encode(terms).write(to: Self.customVocabularyURL, options: [.atomic, .completeFileProtection])
        if status == .ready { Task { await engine.loadChecker(in: Self.directory, custom: terms) } }
    }

    /// Starts the vocabulary checker once the speech model is ready. It downloads its own model
    /// (about 100 MB) the first time; until it's loaded, transcripts just aren't checked.
    private func startChecker() {
        let custom = Self.savedCustomVocabulary()
        Task { await engine.loadChecker(in: Self.directory, custom: custom) }
    }
}

/// Owns the FluidAudio manager off the main thread.
actor SpeechEngine {
    private static let log = Logger(subsystem: "care.person2person.echo.mobile", category: "speech")
    private var manager: AsrManager?
    private var decoderLayers = 2
    /// Corrects clinical terms after transcription (vocabulary/VocabularyChecker.swift).
    private var checker: VocabularyChecker?
    private var checkerModels: CtcModels?
    private var loadingChecker = false
    /// Terms that arrived while the checker was loading, to load next.
    private var pendingCustom: [VocabularyEntry]?

    func loadChecker(in dir: URL, custom: [VocabularyEntry]) async {
        guard !loadingChecker else {
            pendingCustom = custom
            return
        }
        loadingChecker = true
        defer {
            loadingChecker = false
            if let next = pendingCustom {
                pendingCustom = nil
                Task { await loadChecker(in: dir, custom: next) }
            }
        }
        do {
            guard let url = Bundle.main.url(forResource: "clinical", withExtension: "json") else { return }
            let builtIn = try VocabularyList.entries(fromClinicalJSON: Data(contentsOf: url))
            if checkerModels == nil { checkerModels = try await VocabularyChecker.loadModels(in: dir) }
            guard let models = checkerModels else { return }
            checker = try await VocabularyChecker(models: models, modelsDir: dir, entries: builtIn + custom)
        } catch {
            Self.log.error("Vocabulary checker didn't load: \((error as NSError).domain, privacy: .public) \((error as NSError).code, privacy: .public)")
        }
    }

    /// The transcript after the vocabulary check, if the checker is ready. It needs the whole
    /// recording in memory (about 4 MB a minute); if that fails, the transcript goes unchecked.
    private func checked(_ result: ASRResult, url: URL, samples: [Float]? = nil) async -> String {
        guard let checker else { return result.text }
        guard let audio = samples ?? (try? AudioConverter().resampleAudioFile(url)) else { return result.text }
        return await checker.check(result, audio: audio)
    }

    /// `keepFiles` loads a model that's already on the phone without going near the download code.
    /// That code takes any failed load for a corrupt download and deletes the model to fetch it again,
    /// and iOS has to rebuild its compiled copy after an app update, which is when a load is likeliest to fail.
    func prepare(in dir: URL, keepFiles: Bool, progress: @escaping @Sendable (Double, Bool) -> Void) async throws {
        if manager != nil { return }
        let target = dir.appendingPathComponent(Repo.parakeetV2.folderName)
        let models: AsrModels
        if keepFiles, AsrModels.modelsExist(at: target, version: .v2) {
            models = try await loadFromPhone(target)
        } else {
            Self.log.notice("Fetching the speech model. Files kept: \(keepFiles, privacy: .public)")
            models = try await AsrModels.downloadAndLoad(to: target, version: .v2) { p in
                if case .downloading = p.phase { progress(p.fractionCompleted, true) } else { progress(p.fractionCompleted, false) }
            }
        }
        let next = AsrManager(config: .default)
        try await next.loadModels(models)
        decoderLayers = models.version.decoderLayers
        manager = next
    }

    private func loadFromPhone(_ folder: URL) async throws -> AsrModels {
        do {
            return try AsrModels.loadLocal(from: folder, version: .v2)
        } catch {
            let failure = error as NSError
            Self.log.error("Speech model didn't load: \(failure.domain, privacy: .public) \(failure.code, privacy: .public). Trying once more.")
            try await Task.sleep(for: .seconds(2))
            return try AsrModels.loadLocal(from: folder, version: .v2)
        }
    }

    func transcribe(_ url: URL) async throws -> String {
        guard let manager else { throw SpeechError.notReady }
        // A fresh decoder state per recording. Anything over 30 seconds is converted into a scratch
        // file in tmp/ and read in chunks, not loaded whole. iOS can clear tmp/ (the folder itself
        // included), so make sure it's there first.
        try? FileManager.default.createDirectory(at: FileManager.default.temporaryDirectory, withIntermediateDirectories: true)
        var state = TdtDecoderState.make(decoderLayers: decoderLayers)
        do {
            let result = try await manager.transcribe(url, decoderState: &state)
            return await checked(result, url: url).trimmingCharacters(in: .whitespacesAndNewlines)
        } catch is AudioSourceError {
            // The scratch file couldn't be made (e.g. the phone is short on space): decode in memory
            // instead, about 4 MB a minute of audio.
            let samples = try AudioConverter().resampleAudioFile(url)
            state = TdtDecoderState.make(decoderLayers: decoderLayers)
            let result = try await manager.transcribe(samples, decoderState: &state)
            return await checked(result, url: url, samples: samples).trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}

enum SpeechError: LocalizedError {
    case notReady
    var errorDescription: String? { "The speech model isn’t ready yet." }
}
