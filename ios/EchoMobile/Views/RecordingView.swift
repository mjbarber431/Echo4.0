import SwiftUI

/// Full screen while recording: the time, a level meter so you can see it's
/// hearing you, pause, and Done. Locking the phone doesn't stop it.
struct RecordingView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmDiscard = false

    private var recorder: Recorder { model.recorder }
    private var paused: Bool { recorder.state != .recording }
    private var stopped: Bool { recorder.state == .stopped }

    var body: some View {
        ZStack {
            Rectangle().fill(.echoBackground).ignoresSafeArea()

            VStack(spacing: 0) {
                header
                Spacer()
                prompt
                Spacer().frame(height: 28)
                Text(recorder.elapsed.clock)
                    .font(.system(size: 68, weight: .light, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .contentTransition(.numericText())
                    .accessibilityLabel("Recorded \(recorder.elapsed.spoken)")
                LevelMeter(levels: recorder.levels, paused: paused)
                    .frame(height: 64)
                    .padding(.horizontal, 28)
                    .padding(.top, 22)
                if let interruption = recorder.interruption {
                    Label(interruption, systemImage: "pause.circle")
                        .font(.footnote)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(.white.opacity(0.14), in: Capsule())
                        .padding(.top, 18)
                        .padding(.horizontal)
                }
                Spacer()
                controls
                    .padding(.bottom, 24)
            }
        }
        .preferredColorScheme(.dark)
        .confirmationDialog("Discard this recording?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard Recording", role: .destructive) { model.discardRecording() }
            Button("Keep Recording", role: .cancel) {}
        } message: {
            Text("It will be deleted and can’t be recovered.")
        }
    }

    private var header: some View {
        HStack {
            Button("Discard") { confirmDiscard = true }
                .foregroundStyle(.white.opacity(0.85))
            Spacer()
            HStack(spacing: 7) {
                Circle()
                    .fill(paused ? Color.white.opacity(0.5) : .red)
                    .frame(width: 8, height: 8)
                    .opacity(paused ? 1 : 0.9)
                Text(stopped ? "Stopped" : paused ? "Paused" : "Recording")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
            }
            Spacer()
            // Balances the Discard button so the status stays centred.
            Text("Discard").hidden()
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
    }

    /// A nudge to say the name first, for the opening seconds, while it still matters.
    private var prompt: some View {
        let early = recorder.elapsed < 10
        return VStack(spacing: 6) {
            Image(systemName: "person.wave.2")
                .font(.system(size: 22))
            Text(early ? "Start with the client’s name" : "Your Mac will match the name")
                .font(.headline)
            Text(early ? "“This is for Jordan…”" : "Then confirm it in the Queue before the note is written.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.white.opacity(0.7))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 32)
        .animation(.easeInOut, value: early)
    }

    private var controls: some View {
        HStack(alignment: .center) {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                if paused { recorder.resume() } else { recorder.pause() }
            } label: {
                VStack(spacing: 8) {
                    Image(systemName: paused ? "mic.fill" : "pause.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .frame(width: 64, height: 64)
                        .background(.white.opacity(0.16), in: Circle())
                    Text(paused ? "Resume" : "Pause").font(.footnote)
                }
                .foregroundStyle(.white)
            }
            .buttonStyle(PressableStyle())
            .frame(maxWidth: .infinity)
            // A stopped recording can only be saved or discarded.
            .opacity(stopped ? 0 : 1)
            .disabled(stopped)

            Button {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                model.finishRecording()
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
            .accessibilityHint("Saves the recording and transcribes it on this iPhone.")

            // Keeps Done centred.
            Color.clear.frame(width: 64, height: 64).frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 12)
    }
}

/// Recent input levels as a row of bars, newest on the right.
struct LevelMeter: View {
    let levels: [Float]
    let paused: Bool

    var body: some View {
        GeometryReader { geo in
            let count = levels.count
            let spacing: CGFloat = 3
            let width = max(1, (geo.size.width - spacing * CGFloat(count - 1)) / CGFloat(count))
            HStack(alignment: .center, spacing: spacing) {
                ForEach(0..<count, id: \.self) { i in
                    Capsule()
                        .fill(.white.opacity(paused ? 0.25 : 0.35 + 0.65 * Double(i) / Double(count)))
                        .frame(width: width, height: max(width, geo.size.height * CGFloat(levels[i])))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(.linear(duration: 0.06), value: levels)
        }
        .accessibilityHidden(true)
    }
}
