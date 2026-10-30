import AVFoundation
import Observation
import os

/// Records one dictation to a file. Keeps going with the screen locked (background
/// audio), pauses itself for a phone call or Siri and carries on afterwards, and
/// never loses what's recorded.
///
/// AAC in a CAF file: small, and a CAF file cut off by a crash is still readable.
@MainActor @Observable
final class Recorder {
    enum State: Equatable {
        case idle
        case recording
        case paused
        /// The recorder ended on its own (the audio system restarted, the encoder failed).
        /// What's recorded is kept on disk; it can be saved with Done but not resumed.
        case stopped
    }

    private(set) var state: State = .idle {
        didSet { if state != oldValue { onChange?() } }
    }
    private(set) var elapsed: TimeInterval = 0
    /// Recent input levels, 0–1, oldest first, for the level meter.
    private(set) var levels: [Float] = Array(repeating: 0, count: Recorder.levelCount)
    /// Set when the system paused or stopped the recording (a call, Siri, an alarm), so the clinician knows.
    private(set) var interruption: String?
    private(set) var startedAt: Date?
    /// The mic in use, while a Bluetooth headset is connected, so the iPhone's own mic being used with
    /// AirPods in doesn't go unnoticed. Nil with no headset: the iPhone's mic is the only choice then.
    private(set) var microphone: Microphone?
    /// Called whenever `state` changes, whoever changed it, e.g. to update the Live Activity.
    var onChange: (() -> Void)?

    static let levelCount = 48
    private static let log = Logger(subsystem: "care.person2person.echo.mobile", category: "recorder")

    struct Microphone: Equatable {
        /// The headset's name, e.g. "Jo’s AirPods Pro".
        let headset: String
        /// False when the iPhone's own mic is in use although the headset is connected.
        let usingHeadset: Bool
    }

    private var recorder: AVAudioRecorder?
    private let delegate = RecorderDelegate()
    private var ticker: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    /// The system paused it, so it should carry on by itself once the call or Siri is done.
    private var resumeAfterInterruption = false
    /// Ticks in a row where it should be recording but isn't, and no notification said why.
    private var silentTicks = 0

    enum RecorderError: LocalizedError {
        case microphoneDenied
        case couldNotStart
        /// A step that failed, with the system's error, so a report says where it went wrong.
        case failed(String, Error)
        var errorDescription: String? {
            switch self {
            case .microphoneDenied: "Echo needs microphone access. Turn it on in Settings › Privacy & Security › Microphone."
            case .couldNotStart: "The recording couldn’t start. Try again."
            case let .failed(step, error): "Couldn’t \(step) (error \((error as NSError).code)). Try again."
            }
        }
    }

    init() {
        delegate.ended = { [weak self] id, message in self?.recorderEnded(id, message) }
    }

    func start(to url: URL) async throws {
        guard await AVAudioApplication.requestRecordPermission() else { throw RecorderError.microphoneDenied }
        let session = AVAudioSession.sharedInstance()
        do {
            try Self.configure(session)
            try session.setActive(true)
        } catch {
            throw RecorderError.failed("set up the microphone", error)
        }
        Self.preferHeadset(session)
        let recorder: AVAudioRecorder
        do {
            recorder = try Self.makeRecorder(url, compressed: true)
        } catch {
            // If the AAC encoder won't take these settings, uncompressed audio always works; it's just larger.
            do {
                recorder = try Self.makeRecorder(url, compressed: false)
            } catch {
                throw RecorderError.failed("create the recording", error)
            }
        }
        recorder.isMeteringEnabled = true
        recorder.delegate = delegate
        guard recorder.prepareToRecord(), recorder.record() else {
            recorder.deleteRecording()
            throw RecorderError.couldNotStart
        }
        // Keep writing after the phone locks; it becomes "complete" when it's moved after stopping.
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUnlessOpen], ofItemAtPath: url.path)
        self.recorder = recorder
        elapsed = 0
        interruption = nil
        resumeAfterInterruption = false
        silentTicks = 0
        startedAt = Date()
        levels = Array(repeating: 0, count: Self.levelCount)
        state = .recording
        updateMicrophone()
        observe()
        tick()
    }

    /// AirPods or a Bluetooth headset are used as the mic when connected (so a phone in a pocket isn't
    /// what's heard), at full quality where they support it.
    /// Play-and-record, though nothing plays: AirPods' automatic switching only hands them to a session that
    /// could play through them. With .record, an iPhone that doesn't already own them (they were last used
    /// with the Mac, say) refuses their mic and stays on its own.
    /// The default mode: .spokenAudio is a playback mode, and a real iPhone rejects it for recording (-50).
    private static func configure(_ session: AVAudioSession) throws {
        if #available(iOS 26.0, *) {
            do {
                try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP, .bluetoothHighQualityRecording])
                try? session.setPrefersNoInterruptionsFromSystemAlerts(true)
                return
            } catch {
                // Falls through to plain Bluetooth input.
            }
        }
        try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP])
        // A ringtone alone doesn't stop the recording; answering the call does.
        try? session.setPrefersNoInterruptionsFromSystemAlerts(true)
    }

    /// Allowing Bluetooth isn't enough: a recording-only session stays on the iPhone's own mic, even with
    /// AirPods in, unless the headset is asked for by name. Without one, back to the iPhone's mic.
    private static func preferHeadset(_ session: AVAudioSession) {
        do {
            try session.setPreferredInput(session.availableInputs?.first(where: isHeadset))
        } catch {
            log.error("Couldn't prefer the headset mic: \((error as NSError).code, privacy: .public)")
        }
    }

    private static func isHeadset(_ port: AVAudioSessionPortDescription) -> Bool {
        port.portType == .bluetoothHFP || port.portType == .bluetoothLE
    }

    private func updateMicrophone() {
        let session = AVAudioSession.sharedInstance()
        // Port types only, never names (a name can be the clinician's).
        let types = { (ports: [AVAudioSessionPortDescription]?) in (ports ?? []).map(\.portType.rawValue).joined(separator: ",") }
        Self.log.notice("Input \(types(session.currentRoute.inputs), privacy: .public); available \(types(session.availableInputs), privacy: .public)")
        let inUse = session.currentRoute.inputs.first(where: Self.isHeadset)
        guard let headset = inUse ?? session.availableInputs?.first(where: Self.isHeadset) else {
            microphone = nil
            return
        }
        microphone = Microphone(headset: headset.portName, usingHeadset: inUse != nil)
    }

    /// 16 kHz mono, the rate the speech model uses: AAC normally, 16-bit PCM as a fallback.
    private static func makeRecorder(_ url: URL, compressed: Bool) throws -> AVAudioRecorder {
        var settings: [String: Any] = [AVSampleRateKey: 16_000.0, AVNumberOfChannelsKey: 1]
        if compressed {
            settings[AVFormatIDKey] = kAudioFormatMPEG4AAC
            settings[AVEncoderBitRateKey] = 32_000
            settings[AVEncoderAudioQualityKey] = AVAudioQuality.high.rawValue
        } else {
            settings[AVFormatIDKey] = kAudioFormatLinearPCM
            settings[AVLinearPCMBitDepthKey] = 16
            settings[AVLinearPCMIsFloatKey] = false
            settings[AVLinearPCMIsBigEndianKey] = false
        }
        return try AVAudioRecorder(url: url, settings: settings)
    }

    func pause() {
        guard state == .recording, let recorder else { return }
        if recorder.isRecording { elapsed = recorder.currentTime }
        recorder.pause()
        resumeAfterInterruption = false
        state = .paused
    }

    /// Carries on into the same file. Returns false if the microphone couldn't be had back.
    @discardableResult
    func resume() -> Bool {
        guard state == .paused, let recorder else { return false }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setActive(true)
        } catch {
            interruption = "Couldn’t get the microphone back. Tap Resume to try again."
            return false
        }
        // AirPods put in while paused are picked up here.
        Self.preferHeadset(session)
        guard recorder.record() else {
            interruption = "Couldn’t get the microphone back. Tap Resume to try again."
            return false
        }
        interruption = nil
        resumeAfterInterruption = false
        silentTicks = 0
        state = .recording
        updateMicrophone()
        return true
    }

    /// Stops and closes the file. Returns the length recorded, not counting pauses.
    @discardableResult
    func stop() -> TimeInterval {
        let duration = recorder?.isRecording == true ? recorder?.currentTime ?? elapsed : elapsed
        recorder?.delegate = nil
        recorder?.stop()
        finish()
        return max(duration, elapsed)
    }

    /// Stops and deletes the recording.
    func discard() {
        recorder?.delegate = nil
        recorder?.stop()
        recorder?.deleteRecording()
        finish()
    }

    private func finish() {
        recorder = nil
        ticker?.cancel()
        ticker = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        resumeAfterInterruption = false
        startedAt = nil
        microphone = nil
        state = .idle
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// The recorder can't carry on. Close the file and let go of the recorder; the file stays where it is
    /// for Done to save. (Calling record() again on a recorder that has stopped would start the file over.)
    /// After an audio reset the recorder is dead, so it's dropped without being told to stop.
    private func lost(_ message: String, closeFile: Bool = true) {
        guard state == .recording || state == .paused else { return }
        if let recorder, recorder.isRecording { elapsed = recorder.currentTime }
        recorder?.delegate = nil
        if closeFile { recorder?.stop() }
        recorder = nil
        resumeAfterInterruption = false
        interruption = message
        state = .stopped
    }

    /// The recorder stopped without being asked: the disk filled up or the encoder failed.
    private func recorderEnded(_ id: ObjectIdentifier, _ message: String) {
        guard let recorder, ObjectIdentifier(recorder) == id else { return }
        lost(message)
    }

    private func tick() {
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(60))
                guard let self else { return }
                guard let recorder = self.recorder else { continue }
                if recorder.isRecording {
                    self.elapsed = recorder.currentTime
                    self.silentTicks = 0
                } else if self.state == .recording {
                    // Should be recording and isn't, with no interruption to say why. After a few seconds,
                    // stop rather than show "Recording" over a file that isn't growing.
                    self.silentTicks += 1
                    if self.silentTicks > 50 {
                        self.lost("The recording stopped unexpectedly. What was recorded is kept: tap Done to save it.")
                    }
                }
                recorder.updateMeters()
                // -50 dB and below reads as silence.
                let db = recorder.isRecording ? recorder.averagePower(forChannel: 0) : -160
                let level = max(0, min(1, (db + 50) / 50))
                self.levels.removeFirst()
                self.levels.append(level)
            }
        }
    }

    private func observe() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            MainActor.assumeIsolated {
                switch type {
                case .began:
                    guard self.state == .recording else { return }
                    self.recorder?.pause()
                    self.resumeAfterInterruption = true
                    self.interruption = "Paused for an interruption. Tap Resume to carry on."
                    self.state = .paused
                case .ended:
                    // Carry on by itself after a call or Siri, so a locked phone on a walk doesn't sit
                    // paused for the rest of it. If iOS says not to, or won't give the mic back, wait for Resume.
                    guard self.state == .paused, self.resumeAfterInterruption else { return }
                    self.resumeAfterInterruption = false
                    if options.contains(.shouldResume) { self.resume() }
                default:
                    break
                }
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init)
            MainActor.assumeIsolated {
                self.updateMicrophone()
                // A headset or AirPods went away mid-sentence: pause rather than carry on with a different mic unnoticed.
                guard reason == .oldDeviceUnavailable, self.state == .recording else { return }
                self.pause()
                self.interruption = "Paused because the microphone changed. Tap Resume to carry on."
            }
        })
        // The audio system restarted: every recorder is dead, though the file written so far is fine.
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                self.lost("iOS restarted its audio, so the recording stopped. What was recorded is kept: tap Done to save it.", closeFile: false)
            }
        })
    }
}

/// AVAudioRecorder wants an NSObject delegate; this passes its two "it stopped" calls on.
private final class RecorderDelegate: NSObject, AVAudioRecorderDelegate, @unchecked Sendable {
    @MainActor var ended: ((ObjectIdentifier, String) -> Void)?

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        report(recorder, "The recording stopped by itself. What was recorded is kept: tap Done to save it.")
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        report(recorder, "The recording hit a problem and stopped. What was recorded is kept: tap Done to save it.")
    }

    private nonisolated func report(_ recorder: AVAudioRecorder, _ message: String) {
        let id = ObjectIdentifier(recorder)
        Task { @MainActor in self.ended?(id, message) }
    }
}
