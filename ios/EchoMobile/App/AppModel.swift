import Foundation
import Observation
import UIKit

/// Ties the pieces together: record → transcribe on the phone → send to the Mac
/// → delete the transcript once the Mac has it.
@MainActor @Observable
final class AppModel {
    let store = MemoStore()
    let recorder = Recorder()
    let speech = SpeechModel()
    let link = MacLink()
    let lock = AppLock()
    private let activity = RecordingActivity()

    /// The memo being transcribed right now.
    private(set) var transcribingID: UUID?
    /// The memo being recorded right now.
    private(set) var recordingID: UUID?
    /// Whether Echo is in the foreground. Set from the app's scene phase; the lock's window reads it.
    var active = false

    /// Something the clinician should see once, e.g. a send or recording error.
    var alert: String?
    #if DEBUG
        /// Opens this recording's sheet at launch (simulator testing).
        var debugOpenMemo: UUID?
    #endif

    private var working = false
    private var launched = false
    private var sending = false

    var onboarded = UserDefaults.standard.bool(forKey: "onboarded") {
        didSet {
            UserDefaults.standard.set(onboarded, forKey: "onboarded")
            if onboarded { lock.release() }
        }
    }

    init() {
        link.onFound = { [weak self] in self?.sendWaiting() }
        speech.onReady = { [weak self] in self?.transcribeWaiting() }
        recorder.onChange = { [weak self] in self?.recorderChanged() }
        NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.transcribeWaiting() }
        }
    }

    func launch() {
        // onAppear can fire again if iOS reconnects the scene mid-recording. Loading again then would
        // adopt the recording still being written, and ending activities would hide the one in use.
        guard !launched else { return }
        launched = true
        // Nothing is recording yet, so any Live Activity still up is from a recording that was cut off.
        RecordingActivity.endLeftovers()
        store.load()
        if speech.isDownloaded { speech.prepare() }
        #if DEBUG
            DebugHooks.apply(to: self)
        #endif
    }

    func becameActive() {
        link.start()
        transcribeWaiting()
        sendWaiting()
    }

    func wentToBackground() {
        // Keep the link only while something's in flight; iOS stops browsing in the background anyway.
        if !sending { link.stop() }
    }

    // MARK: Recording

    func startRecording() async {
        let id = UUID()
        do {
            try await recorder.start(to: store.recordingURL(id))
            recordingID = id
        } catch {
            alert = error.localizedDescription
        }
    }

    func finishRecording() {
        guard let id = recordingID, let startedAt = recorder.startedAt else { return }
        let duration = recorder.stop()
        recordingID = nil
        guard duration >= 1 else {
            store.delete(id)
            return
        }
        do {
            try store.adoptRecording(Memo(id: id, recordedAt: startedAt, duration: duration, phase: .recorded))
        } catch {
            alert = "The recording couldn’t be saved: \(error.localizedDescription)"
        }
        transcribeWaiting()
    }

    /// Keeps the lock screen and Dynamic Island in step with the recorder, however its state changed.
    private func recorderChanged() {
        switch recorder.state {
        case .idle: activity.end()
        case .recording: activity.show(.recording, elapsed: recorder.elapsed)
        case .paused: activity.show(.paused, elapsed: recorder.elapsed)
        case .stopped: activity.show(.stopped, elapsed: recorder.elapsed)
        }
    }

    func discardRecording() {
        guard let id = recordingID else { return }
        recorder.discard()
        store.delete(id)
        recordingID = nil
    }

    // MARK: Transcription

    /// Transcribes recordings one at a time, oldest first, whenever the model is ready and the phone is unlocked.
    func transcribeWaiting() {
        guard !working, let next = store.needsTranscribing.first else { return }
        // Picked up again by onReady once the model has loaded.
        guard speech.status == .ready else { return }
        guard UIApplication.shared.isProtectedDataAvailable else { return }
        working = true
        transcribingID = next.id
        // Finish this one if the app is sent to the background. If iOS's allowance runs out first,
        // the recording stays on disk and is transcribed the next time Echo opens.
        var task = UIBackgroundTaskIdentifier.invalid
        let end = {
            guard task != .invalid else { return }
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
        }
        task = UIApplication.shared.beginBackgroundTask(withName: "Transcribe") { MainActor.assumeIsolated { end() } }
        Task {
            defer {
                working = false
                transcribingID = nil
                end()
            }
            var memo = next
            do {
                let text = try await speech.transcribe(store.audioURL(next.id))
                if text.isEmpty {
                    memo.phase = .failed
                    memo.problem = "Nothing was picked up. Check the microphone wasn’t covered, and record again."
                    try store.save(memo)
                } else {
                    memo.phase = .ready
                    memo.transcript = text
                    memo.problem = nil
                    // The transcript is on disk before the audio goes.
                    try store.save(memo)
                    store.deleteAudio(next.id)
                }
            } catch {
                guard UIApplication.shared.isProtectedDataAvailable else { return } // Locked mid-way: try again on unlock.
                memo.phase = .failed
                memo.problem = "Couldn’t transcribe: \(error.localizedDescription)"
                try? store.save(memo)
            }
            transcribeWaiting()
            sendWaiting()
        }
    }

    func retry(_ memo: Memo) {
        var memo = memo
        memo.phase = .recorded
        memo.problem = nil
        try? store.save(memo)
        transcribeWaiting()
    }

    func delete(_ memo: Memo) {
        store.delete(memo.id)
    }

    // MARK: Sending

    /// Sends every finished transcript once the Mac is around. Safe to call any time.
    func sendWaiting() {
        guard !sending, link.canSend, !store.readyToSend.isEmpty else { return }
        sending = true
        Task {
            defer { sending = false }
            do {
                let batch = store.readyToSend
                let received = try await link.send(batch)
                store.markSent(received, to: link.macName)
                if received.count < batch.count { alert = "\(link.macName) didn’t take every recording. Echo will try again." }
            } catch LinkError.notFound {
            } catch {
                // Shown in the status row; a retry happens when the Mac next appears or the app reopens.
            }
        }
    }

    /// Checks in with the Mac right after pairing, so it shows the iPhone as paired.
    func greetMac() {
        Task {
            for _ in 0..<20 where !link.canSend {
                try? await Task.sleep(for: .milliseconds(500))
            }
            guard link.canSend else { return }
            _ = try? await link.send([])
            sendWaiting()
        }
    }
}
