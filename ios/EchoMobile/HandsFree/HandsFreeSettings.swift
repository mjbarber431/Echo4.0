import Foundation
import Observation

/// The choices for hands-free mode. It's off until turned on, and with it off Echo works exactly as before.
@MainActor @Observable
final class HandsFreeSettings {
    enum Confirmation: String, CaseIterable, Identifiable {
        case chimes, voice
        var id: String { rawValue }
        var label: String { self == .chimes ? "Chimes" : "Voice" }
    }

    /// The names match the recordings in Resources/Cues, made by ios/scripts/generate-cues.py.
    enum Voice: String, CaseIterable, Identifiable {
        case sarah, eric
        var id: String { rawValue }
        var label: String { rawValue.capitalized }
    }

    var enabled: Bool { didSet { defaults.set(enabled, forKey: "handsFreeEnabled") } }
    /// Which way the Record button is swiped: whether it starts a hands-free session or a plain recording.
    var armed: Bool { didSet { defaults.set(armed, forKey: "handsFreeArmed") } }
    var confirmation: Confirmation { didSet { defaults.set(confirmation.rawValue, forKey: "handsFreeConfirmation") } }
    var voice: Voice { didSet { defaults.set(voice.rawValue, forKey: "handsFreeVoice") } }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        enabled = defaults.bool(forKey: "handsFreeEnabled")
        armed = defaults.bool(forKey: "handsFreeArmed")
        confirmation = defaults.string(forKey: "handsFreeConfirmation").flatMap(Confirmation.init) ?? .chimes
        voice = defaults.string(forKey: "handsFreeVoice").flatMap(Voice.init) ?? .sarah
    }
}
