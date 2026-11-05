@preconcurrency import AVFoundation
import Foundation

/// The confirmations played in your ear. They're audio files in the app: nothing is generated
/// or fetched at the time, so they work with no signal and nothing leaves the phone.
@MainActor
final class HandsFreeCues {
    enum Cue: Equatable {
        case ready
        /// The note that's starting now.
        case note(Int)
        /// Which note you're on, when asked.
        case status(Int)
        case paused, resumed, discarded, restored, undone, saved, nothingSaved, nothingToUndo, micChanged, commandsStopped, problem, help
    }

    private var player: AVAudioPlayer?

    /// Plays over anything still playing, and returns how long it lasts.
    @discardableResult
    func play(_ cue: Cue, style: HandsFreeSettings.Confirmation, voice: HandsFreeSettings.Voice) -> TimeInterval {
        guard let url = Self.url(cue, style: style, voice: voice), let next = try? AVAudioPlayer(contentsOf: url) else { return 0 }
        player?.stop()
        player = next
        next.prepareToPlay()
        next.play()
        return next.duration
    }

    func stop() {
        player?.stop()
        player = nil
    }

    /// A sample for Settings, when nothing is recording.
    func preview(style: HandsFreeSettings.Confirmation, voice: HandsFreeSettings.Voice) {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.duckOthers])
        try? session.setActive(true)
        let length = play(.note(2), style: style, voice: voice)
        Task {
            try? await Task.sleep(for: .seconds(length + 0.2))
            guard player?.isPlaying != true else { return }
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    static func fileName(_ cue: Cue, style: HandsFreeSettings.Confirmation, voice: HandsFreeSettings.Voice) -> String {
        // Help is a list of words, which a chime can't say.
        if style == .chimes, cue != .help { return "chime-\(chimeName(cue)).wav" }
        return "voice-\(voice.rawValue)-\(voiceName(cue)).m4a"
    }

    private static func url(_ cue: Cue, style: HandsFreeSettings.Confirmation, voice: HandsFreeSettings.Voice) -> URL? {
        let name = fileName(cue, style: style, voice: voice) as NSString
        return Bundle.main.url(forResource: name.deletingPathExtension, withExtension: name.pathExtension)
    }

    private static func chimeName(_ cue: Cue) -> String {
        switch cue {
        case .ready: "ready"
        case .note: "note"
        case let .status(n): "count-\(min(max(n, 1), 5))"
        case .paused: "paused"
        case .resumed: "resumed"
        case .discarded: "discarded"
        case .restored, .undone: "undone"
        case .saved: "saved"
        case .nothingSaved, .nothingToUndo, .micChanged, .commandsStopped, .problem, .help: "problem"
        }
    }

    private static func voiceName(_ cue: Cue) -> String {
        switch cue {
        case .ready: "ready"
        case let .note(n), let .status(n): (1...20).contains(n) ? "note-\(n)" : "new-note"
        case .paused: "paused"
        case .resumed: "resumed"
        case .discarded: "discarded"
        case .restored: "restored"
        case .undone: "undone"
        case .saved: "saved"
        case .nothingSaved: "nothing-saved"
        case .nothingToUndo: "nothing-to-undo"
        case .micChanged: "mic-changed"
        case .commandsStopped: "commands-stopped"
        case .problem: "problem"
        case .help: "help"
        }
    }
}
