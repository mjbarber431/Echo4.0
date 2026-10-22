@preconcurrency import ActivityKit
import Foundation
import UIKit

/// Shows the recording on the lock screen and in the Dynamic Island. Only ever a convenience:
/// if Live Activities are turned off or refused, recording carries on just the same.
@MainActor
final class RecordingActivity {
    private var activity: Activity<RecordingAttributes>?
    /// Updates run one after another, so a quick pause and resume can't arrive out of order.
    private var queue: Task<Void, Never>?

    func show(_ status: RecordingAttributes.ContentState.Status, elapsed: TimeInterval) {
        let state = RecordingAttributes.ContentState(status: status, since: Date().addingTimeInterval(-elapsed), elapsed: elapsed)
        let content = ActivityContent(state: state, staleDate: nil)
        if let activity {
            enqueue { await activity.update(content) }
            return
        }
        // iOS only lets an activity start from the foreground, which is where Record is tapped.
        guard UIApplication.shared.applicationState != .background, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        activity = try? Activity.request(attributes: RecordingAttributes(), content: content)
    }

    func end() {
        guard let activity else { return }
        self.activity = nil
        enqueue { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    /// Clears any activity left behind by a recording that was cut off (Echo crashed or was closed).
    static func endLeftovers() {
        for activity in Activity<RecordingAttributes>.activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }

    private func enqueue(_ work: @escaping @MainActor () async -> Void) {
        let previous = queue
        queue = Task {
            await previous?.value
            await work()
        }
    }
}
