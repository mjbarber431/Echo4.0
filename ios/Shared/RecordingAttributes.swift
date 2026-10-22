import ActivityKit
import Foundation

/// The Live Activity shown on the lock screen and in the Dynamic Island while Echo records.
/// It says only that Echo is recording and for how long: nothing about the client.
struct RecordingAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Status: String, Codable, Hashable {
            case recording
            case paused
            /// The recording ended on its own; open Echo to save it.
            case stopped
        }

        var status: Status
        /// When the recording would have started had it never paused: the timer counts up from here.
        var since: Date
        /// The length recorded so far, shown frozen while it isn't recording.
        var elapsed: TimeInterval
    }
}
