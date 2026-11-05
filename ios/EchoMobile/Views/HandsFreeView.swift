import SwiftUI

/// Full screen during a hands-free session. It's built to be glanced at: the point is
/// that the phone stays in a pocket, so it mainly shows which note you're on and what was heard.
struct HandsFreeView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmDiscard = false

    private var session: HandsFreeSession { model.handsFree }
    private var paused: Bool { session.phase == .paused }
    private var preparing: Bool { session.phase == .preparing }

    var body: some View {
        ZStack {
            Rectangle().fill(.echoBackground).ignoresSafeArea()

            if preparing {
                VStack(spacing: 14) {
                    ProgressView().tint(.white).controlSize(.large)
                    Text("Getting ready to listen…").font(.headline).foregroundStyle(.white)
                }
            } else {
                content
            }
        }
        .preferredColorScheme(.dark)
        .confirmationDialog("Discard note \(session.note)?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard Note", role: .destructive) { session.tap(.discard) }
            Button("Keep Note", role: .cancel) {}
        } message: {
            Text("You can say “Echo, undo” to bring it back until you finish.")
        }
    }

    private var content: some View {
        VStack(spacing: 0) {
            header
            Spacer()
            Text("Note \(session.note)")
                .font(.system(size: 44, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .contentTransition(.numericText())
                .animation(.snappy, value: session.note)
            Text(session.elapsed.clock)
                .font(.system(size: 26, weight: .light, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.white.opacity(0.75))
                .padding(.top, 2)
                .accessibilityLabel("Recorded \(session.elapsed.spoken)")
            LevelMeter(levels: session.levels, paused: paused)
                .frame(height: 56)
                .padding(.horizontal, 28)
                .padding(.top, 20)
            status.padding(.top, 16).padding(.horizontal)
            Spacer()
            hints.padding(.bottom, 20)
            controls.padding(.bottom, 24)
        }
    }

    private var header: some View {
        HStack {
            Button("Discard Note") { confirmDiscard = true }
                .foregroundStyle(.white.opacity(0.85))
            Spacer()
            HStack(spacing: 7) {
                Circle()
                    .fill(paused ? Color.white.opacity(0.5) : .red)
                    .frame(width: 8, height: 8)
                Text(paused ? "Paused" : "Recording")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
    }

    /// What's wrong if something is, otherwise what was just heard, otherwise which mic is in use.
    @ViewBuilder private var status: some View {
        if let problem = session.problem {
            Label(problem, systemImage: session.listening ? "pause.circle" : "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 16))
        } else if let confirmation = session.confirmation {
            Label(confirmation, systemImage: "checkmark")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.white.opacity(0.14), in: Capsule())
                .id(confirmation)
                .transition(.opacity)
        } else if let headset = session.headset {
            Label(headset, systemImage: "headphones")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.75))
        }
    }

    private var hints: some View {
        VStack(spacing: 3) {
            Text(paused ? "Say “Echo, resume” to carry on" : "Say “Echo, new note” for the next one")
                .font(.subheadline.weight(.semibold))
            Text("“Echo, help” lists the rest")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.7))
        }
        .foregroundStyle(.white)
        .multilineTextAlignment(.center)
        .opacity(session.listening ? 1 : 0)
    }

    private var controls: some View {
        HStack(alignment: .center) {
            sideButton(paused ? "Resume" : "Pause", icon: paused ? "mic.fill" : "pause.fill") {
                session.tap(paused ? .resume : .pause)
            }

            Button {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                session.tap(.finish)
            } label: {
                VStack(spacing: 8) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(Color.echoDeep)
                        .frame(width: 84, height: 84)
                        .background(.white, in: Circle())
                    Text("Done").font(.footnote.weight(.semibold)).foregroundStyle(.white)
                }
            }
            .buttonStyle(PressableStyle())
            .frame(maxWidth: .infinity)
            .accessibilityHint("Saves your notes and transcribes them on this iPhone.")

            sideButton("New Note", icon: "plus") { session.tap(.newNote) }
        }
        .padding(.horizontal, 12)
    }

    private func sideButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            VStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 22, weight: .semibold))
                    .frame(width: 64, height: 64)
                    .background(.white.opacity(0.16), in: Circle())
                Text(title).font(.footnote)
            }
            .foregroundStyle(.white)
        }
        .buttonStyle(PressableStyle())
        .frame(maxWidth: .infinity)
    }
}
