@preconcurrency import AVFoundation
import Foundation
import Observation
import UIKit
import os

/// A hands-free session: one sitting, any number of notes, driven by voice or by the buttons on
/// screen. The phone is expected to be locked in a pocket, so everything here says what it did
/// in your ear, and when anything goes wrong it keeps what's recorded and tells you.
@MainActor @Observable
final class HandsFreeSession {
    enum Phase: Equatable {
        case idle
        /// Loading the listener.
        case preparing
        case recording
        case paused
    }

    private enum Undoable {
        case split(at: Date)
        case discard
    }

    private(set) var phase = Phase.idle
    /// The note being recorded, from 1.
    private(set) var note = 1
    /// How long the current note has run, not counting pauses.
    private(set) var elapsed: TimeInterval = 0
    private(set) var levels = Array(repeating: Float(0), count: Recorder.levelCount)
    /// Why it's paused or what's wrong, when it isn't the speaker's own doing.
    private(set) var problem: String?
    /// The last thing heard or done, shown briefly on screen.
    private(set) var confirmation: String?
    /// False once commands have stopped working. The recording carries on.
    private(set) var listening = true
    /// A connected headset's name, while it's the mic in use.
    private(set) var headset: String?

    var isActive: Bool { phase != .idle }

    /// Called whenever the phase or the note changes, e.g. to update the Live Activity.
    var onChange: (() -> Void)?
    /// Called when a session has ended and its notes can be collected.
    var onEnded: (() -> Void)?
    /// Why the last session ended early, to show when Echo is next on screen.
    private(set) var endProblem: String?
    /// Finished notes waiting for the phone to unlock, so they can become memos.
    private(set) var waiting: [FinishedNote] = []

    private static let log = Logger(subsystem: "care.person2person.echo.mobile", category: "handsfree")
    private let settings: HandsFreeSettings
    private let recordingDir: URL
    private let cues = HandsFreeCues()
    private var capture: HandsFreeCapture?
    private var listener: CommandListener?
    private var observers: [NSObjectProtocol] = []
    private var ticker: Task<Void, Never>?
    private var undoable: Undoable?
    private var resumeAfterInterruption = false
    private var ending = false
    private var restarts = 0
    /// Ends the wait for the listener to load, for this load only.
    private var endLoad: ((Result<Void, Error>) -> Void)?
    private var loadID = 0

    init(settings: HandsFreeSettings, recordingDir: URL) {
        self.settings = settings
        self.recordingDir = recordingDir
    }

    /// Throws if it couldn't start or was cancelled, in which case nothing was recorded.
    /// `warmUp` is any model build already under way: loading alongside it would only do the work twice.
    func start(after warmUp: Task<Void, Never>? = nil) async throws {
        guard phase == .idle else { return }
        phase = .preparing
        do {
            Self.log.notice("Start: asking for the mic")
            guard await AVAudioApplication.requestRecordPermission() else { throw Recorder.RecorderError.microphoneDenied }
            let listener = CommandListener(
                onCommand: { [weak self] spotted in Task { @MainActor in self?.heard(spotted) } },
                onFailure: { [weak self] in Task { @MainActor in self?.listenerStopped() } }
            )
            Self.log.notice("Start: loading the listener")
            try await load(listener, after: warmUp)
            self.listener = listener
            Self.log.notice("Start: setting up audio")
            try Self.configureAudio()
            Self.log.notice("Start: starting the mic")
            let capture = try HandsFreeCapture(recordingDir: recordingDir)
            capture.onHeard = { [listener] samples in listener.hear(samples) }
            capture.onLevel = { [weak self] level in Task { @MainActor in self?.addLevel(level) } }
            capture.onFailure = { [weak self] message in Task { @MainActor in self?.fail(message) } }
            #if DEBUG
                if let path = ProcessInfo.processInfo.environment["ECHO_HANDS_FREE_AUDIO"] {
                    capture.debugPlay(path)
                } else {
                    try capture.start()
                }
            #else
                try capture.start()
            #endif
            self.capture = capture
        } catch {
            Self.log.error("Start failed: \(String(describing: error), privacy: .public)")
            await listener?.stop()
            listener = nil
            capture = nil
            phase = .idle
            try? AVAudioSession.sharedInstance().setActive(false)
            throw error
        }
        note = 1
        elapsed = 0
        problem = nil
        confirmation = nil
        listening = true
        undoable = nil
        ending = false
        restarts = 0
        levels = Array(repeating: 0, count: Recorder.levelCount)
        updateHeadset()
        observe()
        tick()
        setPhase(.recording)
    }

    /// Gives up waiting for the listener. The load itself can't be stopped, but it isn't wasted:
    /// iOS keeps what it compiled, so the next start is quick.
    func cancelStart() {
        endLoad?(.failure(CancellationError()))
        endLoad = nil
    }

    private func load(_ listener: CommandListener, after warmUp: Task<Void, Never>?) async throws {
        loadID += 1
        let id = loadID
        try await withCheckedThrowingContinuation { (waiting: CheckedContinuation<Void, Error>) in
            endLoad = { waiting.resume(with: $0) }
            Task {
                await warmUp?.value
                let result: Result<Void, Error>
                do {
                    try await listener.start()
                    result = .success(())
                } catch {
                    result = .failure(error)
                }
                guard id == loadID, let endLoad else {
                    await listener.stop() // Cancelled while it loaded.
                    return
                }
                self.endLoad = nil
                endLoad(result)
            }
        }
    }

    // MARK: Commands

    /// From a button on screen.
    func tap(_ command: HandsFreeCommand) {
        run(command, spotted: nil)
    }

    /// Throws away this note and ends the session, the way Discard ends a normal recording.
    /// Notes already finished are kept.
    func discardAndFinish() {
        guard phase == .recording || phase == .paused, !ending else { return }
        capture?.apply(.discard, startMs: nil, endMs: nil, nextWordMs: nil, speakerCue: 0)
        finish(nil)
    }

    private func heard(_ spotted: SpottedCommand) {
        Self.log.notice("Heard \(spotted.command.rawValue, privacy: .public), \(spotted.heardMs - spotted.endMs, privacy: .public) ms after it was said")
        run(spotted.command, spotted: spotted)
    }

    private func run(_ command: HandsFreeCommand, spotted: SpottedCommand?) {
        guard phase == .recording || phase == .paused, !ending else { return }
        switch command {
        case .newNote: newNote(spotted)
        case .pause:
            setPhase(.paused)
            problem = nil
            edit(.pause, cue: .paused, spotted: spotted, say: "Paused")
        case .resume:
            setPhase(.recording)
            problem = nil
            edit(.resume, cue: .resumed, spotted: spotted, say: "Recording")
        case .discard:
            undoable = .discard
            elapsed = 0
            edit(.discard, cue: .discarded, spotted: spotted, say: "Note \(note) discarded")
        case .undo: undo(spotted)
        case .status: edit(nil, cue: .status(note), spotted: spotted, say: "On note \(note)")
        case .help: edit(nil, cue: .help, spotted: spotted, say: nil)
        case .finish: finish(spotted)
        }
    }

    private func newNote(_ spotted: SpottedCommand?) {
        // Nothing said since the last one: stay on this note rather than leave an empty one behind.
        guard elapsed >= NoteDesk.shortestNote else {
            if phase == .paused { setPhase(.recording) }
            edit(.resume, cue: .note(note), spotted: spotted, say: "Note \(note)")
            return
        }
        note += 1
        elapsed = 0
        undoable = .split(at: Date())
        setPhase(.recording)
        onChange?()
        edit(.split, cue: .note(note), spotted: spotted, say: "Note \(note)")
    }

    private func undo(_ spotted: SpottedCommand?) {
        switch undoable {
        case let .split(at) where Date().timeIntervalSince(at) < NoteDesk.undoSeconds - HandsFreeCapture.holdSeconds:
            note -= 1
            undoable = nil
            onChange?()
            edit(.undoSplit, cue: .undone, spotted: spotted, say: "Back on note \(note)")
        case .discard:
            note += 1
            undoable = nil
            onChange?()
            edit(.restore, cue: .restored, spotted: spotted, say: "Note restored")
        default:
            edit(nil, cue: .nothingToUndo, spotted: spotted, say: "Nothing to undo")
        }
    }

    private func finish(_ spotted: SpottedCommand?) {
        guard let capture else { return }
        ending = true
        ticker?.cancel()
        capture.stopMic()
        capture.finish(startMs: spotted?.startMs) { [weak self] notes in
            Task { @MainActor in self?.ended(notes) }
        }
    }

    private func ended(_ notes: [FinishedNote]) {
        waiting += notes
        // After a failure, the alarm that's already playing says more than "saved" would.
        let length = endProblem != nil ? 0 : play(notes.isEmpty ? .nothingSaved : .saved)
        stopObserving()
        let listener = self.listener
        self.listener = nil
        capture = nil
        setPhase(.idle)
        onEnded?()
        Task {
            await listener?.stop()
            // Let the confirmation finish before giving up the audio.
            try? await Task.sleep(for: .seconds(max(length, endProblem == nil ? 0 : 2) + 0.2))
            guard !isActive else { return }
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// Notes handed over, called once the phone is unlocked and they could be saved.
    func collected(_ note: FinishedNote) {
        waiting.removeAll { $0 == note }
    }

    /// Applies an edit where the command was said, and confirms it.
    private func edit(_ edit: HandsFreeCapture.Edit?, cue: HandsFreeCues.Cue, spotted: SpottedCommand?, say: String?) {
        let length = play(cue)
        confirmation = say
        // Headphones keep the mic clear of the cue. A speaker doesn't, so the listener skips that stretch.
        let speakerCue = Self.playsAloud ? length : 0
        if let edit {
            capture?.apply(edit, startMs: spotted?.startMs, endMs: spotted?.endMs, nextWordMs: spotted?.nextWordMs, speakerCue: speakerCue)
        } else if let spotted {
            // Nothing changes, but the command still comes out of the note.
            capture?.apply(.none, startMs: spotted.startMs, endMs: spotted.endMs, nextWordMs: spotted.nextWordMs, speakerCue: speakerCue)
        }
    }

    @discardableResult
    private func play(_ cue: HandsFreeCues.Cue) -> TimeInterval {
        cues.play(cue, style: settings.confirmation, voice: settings.voice)
    }

    private static var playsAloud: Bool {
        AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .builtInSpeaker || $0.portType == .builtInReceiver }
    }

    private func setPhase(_ next: Phase) {
        guard next != phase else { return }
        phase = next
        onChange?()
    }

    // MARK: Things going wrong

    private func listenerStopped() {
        guard isActive, listening else { return }
        listening = false
        play(.commandsStopped)
        problem = "Voice commands stopped. It’s still recording. Use the buttons below."
    }

    private func fail(_ message: String) {
        guard isActive, !ending else { return }
        play(.problem)
        endProblem = message
        finish(nil)
    }

    func clearEndProblem() {
        endProblem = nil
    }

    private func pauseForProblem(_ message: String, cue: HandsFreeCues.Cue?) {
        guard phase == .recording else { return }
        capture?.apply(.pause, startMs: nil, endMs: nil, nextWordMs: nil, speakerCue: 0)
        setPhase(.paused)
        problem = message
        if let cue { play(cue) }
    }

    // MARK: Plumbing

    private func addLevel(_ level: Float) {
        guard phase == .recording || phase == .paused else { return }
        levels.removeFirst()
        levels.append(phase == .recording ? level : 0)
    }

    private func tick() {
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                self?.tickOnce()
            }
        }
    }

    private func tickOnce() {
        guard phase == .recording || phase == .paused else { return }
        if phase == .recording { elapsed += 1 }
        // No audio, and no notification saying why: try the mic again before giving up.
        guard !resumeAfterInterruption, let capture, capture.secondsSinceAudio > 4 else { return }
        restarts += 1
        Self.log.error("No audio from the mic; restart \(self.restarts, privacy: .public)")
        if restarts <= 2, (try? capture.start()) != nil { return }
        fail("The microphone stopped, so the recording stopped. What was recorded is kept.")
    }

    private static func configureAudio() throws {
        let session = AVAudioSession.sharedInstance()
        // Like `Recorder`, with one addition: a phone on the counter should answer from
        // its speaker, not the earpiece, which is where play-and-record goes by default.
        var options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .defaultToSpeaker]
        if #available(iOS 26.0, *) { options.insert(.bluetoothHighQualityRecording) }
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: options)
        } catch {
            try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP, .defaultToSpeaker])
        }
        try? session.setPrefersNoInterruptionsFromSystemAlerts(true)
        try session.setActive(true)
        preferHeadset(session)
    }

    private static func preferHeadset(_ session: AVAudioSession) {
        try? session.setPreferredInput(session.availableInputs?.first { $0.portType == .bluetoothHFP || $0.portType == .bluetoothLE })
    }

    private func updateHeadset() {
        let input = AVAudioSession.sharedInstance().currentRoute.inputs.first { $0.portType == .bluetoothHFP || $0.portType == .bluetoothLE }
        headset = input?.portName
    }

    private func observe() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            MainActor.assumeIsolated {
                guard let self else { return }
                switch type {
                case .began:
                    guard self.phase == .recording else { return }
                    self.resumeAfterInterruption = true
                    self.pauseForProblem("Paused for an interruption. It carries on afterwards, or tap Resume.", cue: nil)
                case .ended:
                    let resume = self.resumeAfterInterruption && options.contains(.shouldResume)
                    self.resumeAfterInterruption = false
                    try? AVAudioSession.sharedInstance().setActive(true)
                    try? self.capture?.start()
                    if resume { self.run(.resume, spotted: nil) }
                default:
                    break
                }
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init)
            MainActor.assumeIsolated {
                guard let self else { return }
                self.updateHeadset()
                // Same rule as `Recorder`: no carrying on with a different mic unnoticed.
                guard reason == .oldDeviceUnavailable else { return }
                self.pauseForProblem("Paused because the microphone changed. Say “Okay, resume” to carry on.", cue: .micChanged)
            }
        })
        // Changing the mic or the sample rate stops the engine; it needs rebuilding for the new format.
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.isActive, !self.ending, !self.resumeAfterInterruption else { return }
                Self.preferHeadset(AVAudioSession.sharedInstance())
                try? self.capture?.start()
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.fail("iOS restarted its audio, so the recording stopped. What was recorded is kept.")
            }
        })
    }

    private func stopObserving() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        ticker?.cancel()
        ticker = nil
    }
}
