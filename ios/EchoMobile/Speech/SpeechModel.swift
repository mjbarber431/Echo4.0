import FluidAudio
import Foundation
import Observation

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

    /// Downloads (the first time) and loads the model. Safe to call repeatedly.
    func prepare() {
        if status == .ready || preparing != nil { return }
        preparing = Task {
            defer { preparing = nil }
            status = isDownloaded ? .loading : .downloading(0)
            do {
                try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
                var dir = Self.directory
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try? dir.setResourceValues(values)
                try await engine.prepare(in: Self.directory) { fraction, downloading in
                    Task { @MainActor in
                        if self.status != .ready { self.status = downloading ? .downloading(fraction) : .loading }
                    }
                }
                UserDefaults.standard.set(true, forKey: Self.downloadedKey)
                status = .ready
                onReady?()
            } catch {
                status = .failed(error.localizedDescription)
            }
        }
    }

    func transcribe(_ url: URL) async throws -> String {
        try await engine.transcribe(url)
    }
}

/// Owns the FluidAudio manager off the main thread.
actor SpeechEngine {
    private var manager: AsrManager?
    private var decoderLayers = 2

    func prepare(in dir: URL, progress: @escaping @Sendable (Double, Bool) -> Void) async throws {
        if manager != nil { return }
        let target = dir.appendingPathComponent(Repo.parakeetV2.folderName)
        let models = try await AsrModels.downloadAndLoad(to: target, version: .v2) { p in
            if case .downloading = p.phase { progress(p.fractionCompleted, true) } else { progress(p.fractionCompleted, false) }
        }
        let next = AsrManager(config: .default)
        try await next.loadModels(models)
        decoderLayers = models.version.decoderLayers
        manager = next
    }

    func transcribe(_ url: URL) async throws -> String {
        guard let manager else { throw SpeechError.notReady }
        // A fresh decoder state per recording. Anything over 30 seconds is converted into a scratch
        // file in tmp/ and read in chunks, not loaded whole. iOS can clear tmp/ (the folder itself
        // included), so make sure it's there first.
        try? FileManager.default.createDirectory(at: FileManager.default.temporaryDirectory, withIntermediateDirectories: true)
        var state = TdtDecoderState.make(decoderLayers: decoderLayers)
        do {
            return try await manager.transcribe(url, decoderState: &state).text.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch is AudioSourceError {
            // The scratch file couldn't be made (e.g. the phone is short on space): decode in memory
            // instead, about 4 MB a minute of audio.
            let samples = try AudioConverter().resampleAudioFile(url)
            state = TdtDecoderState.make(decoderLayers: decoderLayers)
            return try await manager.transcribe(samples, decoderState: &state).text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}

enum SpeechError: LocalizedError {
    case notReady
    var errorDescription: String? { "The speech model isn’t ready yet." }
}
