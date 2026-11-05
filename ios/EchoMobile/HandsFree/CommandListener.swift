@preconcurrency import AVFoundation
@preconcurrency import CoreML
import FluidAudio
import Foundation
import Observation
import os

/// The small streaming speech model that listens for commands. It's a separate model from the
/// one that writes the transcript, and only downloaded if hands-free is turned on.
@MainActor @Observable
final class CommandModel {
    enum Status: Equatable {
        case notDownloaded
        case downloading(Double)
        case ready
        case failed(String)
    }

    private(set) var status: Status
    private var preparing: Task<Void, Never>?
    private static let downloadedKey = "commandModelDownloaded"
    /// For the row in Settings.
    static let sizeLabel = "220 MB"

    init() {
        status = UserDefaults.standard.bool(forKey: Self.downloadedKey) ? .ready : .notDownloaded
    }

    /// Downloads the model the first time. Safe to call repeatedly.
    func prepare() {
        if status == .ready || preparing != nil { return }
        preparing = Task {
            defer { preparing = nil }
            status = .downloading(0)
            do {
                try SpeechModel.makeDirectory()
                // On the Neural Engine, as it'll run: iOS compiles the model for it the first time, once.
                let manager = StreamingEouAsrManager(configuration: CommandListener.configuration(.cpuAndNeuralEngine), chunkSize: CommandListener.chunkSize)
                try await manager.loadModels(to: SpeechModel.directory, configuration: nil) { progress in
                    if case .downloading = progress.phase {
                        let fraction = progress.fractionCompleted
                        Task { @MainActor in if self.status != .ready { self.status = .downloading(fraction) } }
                    }
                }
                await manager.cleanup()
                UserDefaults.standard.set(true, forKey: Self.downloadedKey)
                status = .ready
            } catch {
                status = .failed(error.localizedDescription)
            }
        }
    }
}

/// Runs the microphone's audio through the speech model and reports commands. The words it
/// decodes stay in memory for a few seconds and are never logged or saved.
///
/// It runs on the Neural Engine, the most power-efficient choice. iOS 27 only allows that in the
/// background with the Background Inference entitlement (Echo.entitlements). If the Neural Engine
/// fails anyway, or can't keep up, it moves to the CPU, which iOS always allows, and carries on.
actor CommandListener {
    /// 0.32 s between results, against 0.16 s, for fewer mistakes: about 5.7% of words wrong, not 8–9%.
    nonisolated static let chunkSize: StreamingChunkSize = .ms320
    /// Falls back to the CPU if results run this far behind the audio.
    private static let lagLimitMs = 3000

    private static let log = Logger(subsystem: "care.person2person.echo.mobile", category: "handsfree")

    nonisolated static func configuration(_ units: MLComputeUnits) -> MLModelConfiguration {
        let configuration = MLModelConfiguration()
        configuration.computeUnits = units
        return configuration
    }

    private let onCommand: @Sendable (SpottedCommand) -> Void
    private let onFailure: @Sendable () -> Void
    private let audio: AsyncStream<[Float]>
    private let input: AsyncStream<[Float]>.Continuation
    private var manager: StreamingEouAsrManager?
    private var units = MLComputeUnits.cpuAndNeuralEngine
    private var spotter = CommandSpotter()
    private var worker: Task<Void, Never>?
    /// Tokens from the model already passed to the spotter.
    private var seen = 0
    /// Samples given to the model so far, in all.
    private var heardSamples = 0
    /// Added to the model's token times: a model reloaded mid-session counts from zero again.
    private var offsetMs = 0
    private var slowestChunkMs = 0.0

    init(onCommand: @escaping @Sendable (SpottedCommand) -> Void, onFailure: @escaping @Sendable () -> Void) {
        self.onCommand = onCommand
        self.onFailure = onFailure
        (audio, input) = AsyncStream.makeStream(of: [Float].self)
    }

    /// Takes 16 kHz mono audio, from any thread, in order.
    nonisolated func hear(_ samples: [Float]) {
        input.yield(samples)
    }

    /// Loads the model. Call this before the phone can lock, so its files can be read.
    func start() async throws {
        do {
            manager = try await load(.cpuAndNeuralEngine)
        } catch {
            units = .cpuOnly
            manager = try await load(.cpuOnly)
        }
        worker = Task { [weak self, audio] in
            for await samples in audio {
                guard let self else { return }
                await self.process(samples)
            }
        }
    }

    func stop() async {
        input.finish()
        worker?.cancel()
        await manager?.cleanup()
        manager = nil
        Self.log.notice("Listener stopped. Compute \(self.units == .cpuOnly ? "CPU" : "Neural Engine", privacy: .public), slowest chunk \(Int(self.slowestChunkMs), privacy: .public) ms")
    }

    private func load(_ units: MLComputeUnits) async throws -> StreamingEouAsrManager {
        let next = StreamingEouAsrManager(configuration: Self.configuration(units), chunkSize: Self.chunkSize)
        try await next.loadModels(to: SpeechModel.directory, configuration: nil, progressHandler: nil)
        return next
    }

    private func process(_ samples: [Float]) async {
        guard let manager else { return }
        heardSamples += samples.count
        let heardMs = heardSamples / (NoteCutter.sampleRate / 1000)
        let started = ContinuousClock.now
        do {
            try await manager.appendAudio(Self.buffer(samples))
            try await manager.processBufferedAudio()
        } catch {
            await recover("error \((error as NSError).code)")
            return
        }
        let took = (ContinuousClock.now - started) / .milliseconds(1)
        slowestChunkMs = max(slowestChunkMs, took)
        // Results falling behind means the cut could miss the command and the confirmation comes late.
        if took > Double(Self.lagLimitMs) {
            await recover("took \(Int(took)) ms")
            return
        }
        let tokens = await manager.getRawTokenStrings()
        let times = await manager.getTokenTimestampsMs()
        guard tokens.count == times.count, seen <= tokens.count else { return }
        let offset = offsetMs
        let command = spotter.feed(tokens: tokens[seen...], timesMs: ArraySlice(times[seen...].map { $0 + offset }), heardMs: heardMs)
        seen = tokens.count
        if let command { onCommand(command) }
    }

    /// Falls back to the CPU once. If that fails too, commands are over but the recording isn't.
    private func recover(_ reason: String) async {
        Self.log.error("Listener failed on \(self.units == .cpuOnly ? "CPU" : "Neural Engine", privacy: .public): \(reason, privacy: .public)")
        let old = manager
        manager = nil
        await old?.cleanup()
        guard units != .cpuOnly else {
            onFailure()
            return
        }
        units = .cpuOnly
        do {
            manager = try await load(.cpuOnly)
            offsetMs = heardSamples / (NoteCutter.sampleRate / 1000)
            seen = 0
            spotter = CommandSpotter()
        } catch {
            Self.log.error("Couldn't load the listener on the CPU: \((error as NSError).code, privacy: .public)")
            onFailure()
        }
    }

    private static func buffer(_ samples: [Float]) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(NoteCutter.sampleRate), channels: 1, interleaved: false)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))!
        buffer.frameLength = buffer.frameCapacity
        samples.withUnsafeBufferPointer { source in
            if let base = source.baseAddress { buffer.floatChannelData?[0].update(from: base, count: samples.count) }
        }
        return buffer
    }
}
