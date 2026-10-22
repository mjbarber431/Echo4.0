import ActivityKit
import SwiftUI
import WidgetKit

/// Lock screen and Dynamic Island while recording: a red dot, "Recording" and the time.
struct RecordingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingAttributes.self) { context in
            LockScreenView(state: context.state)
                .activityBackgroundTint(Color.echoDeeper)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label {
                        Text(state.title)
                    } icon: {
                        StatusDot(status: state.status)
                    }
                    .font(.headline)
                    .padding(.leading, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Timer(state: state)
                        .font(.title2.weight(.semibold))
                        .padding(.trailing, 6)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(state.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 6)
                }
            } compactLeading: {
                Image(systemName: state.status == .recording ? "mic.fill" : "pause.fill")
                    .foregroundStyle(state.status == .recording ? .red : .orange)
            } compactTrailing: {
                Timer(state: state)
                    .frame(maxWidth: 52)
                    .foregroundStyle(state.status == .recording ? .red : .orange)
            } minimal: {
                Image(systemName: state.status == .recording ? "mic.fill" : "pause.fill")
                    .foregroundStyle(state.status == .recording ? .red : .orange)
            }
            .keylineTint(.red)
        }
    }
}

private struct LockScreenView: View {
    let state: RecordingAttributes.ContentState

    var body: some View {
        HStack(spacing: 12) {
            StatusDot(status: state.status)
            VStack(alignment: .leading, spacing: 2) {
                Text("Echo · \(state.title)")
                    .font(.headline)
                Text(state.detail)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.7))
            }
            Spacer(minLength: 8)
            Timer(state: state)
                .font(.system(size: 34, weight: .light, design: .rounded))
        }
        .foregroundStyle(.white)
        .padding(16)
    }
}

/// Counts up by itself while recording (no updates needed from the app); frozen otherwise.
private struct Timer: View {
    let state: RecordingAttributes.ContentState

    var body: some View {
        Text(
            timerInterval: state.since...state.since.addingTimeInterval(24 * 3600),
            pauseTime: state.status == .recording ? nil : state.since.addingTimeInterval(state.elapsed),
            countsDown: false
        )
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
    }
}

private struct StatusDot: View {
    let status: RecordingAttributes.ContentState.Status

    var body: some View {
        Circle()
            .fill(status == .recording ? Color.red : Color.orange)
            .frame(width: 10, height: 10)
    }
}

private extension RecordingAttributes.ContentState {
    var title: String {
        switch status {
        case .recording: "Recording"
        case .paused: "Paused"
        case .stopped: "Stopped"
        }
    }

    var detail: String {
        switch status {
        case .recording: "Keeps recording with the phone locked."
        case .paused: "Open Echo to resume."
        case .stopped: "Open Echo to save what was recorded."
        }
    }
}

private extension Color {
    /// Echo's deep green, as on the recording screen.
    static let echoDeeper = Color(red: 0.09, green: 0.22, blue: 0.19)
}
