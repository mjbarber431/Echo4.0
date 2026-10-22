import SwiftUI

/// First run: what Echo for iPhone does, the speech model download, and pairing.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var step = 0
    @State private var showPairing = false

    var body: some View {
        VStack(spacing: 0) {
            TabView(selection: $step) {
                welcome.tag(0)
                speech.tag(1)
                pair.tag(2)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .animation(.easeInOut, value: step)

            HStack(spacing: 8) {
                ForEach(0..<3) { i in
                    Capsule()
                        .fill(i == step ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(width: i == step ? 22 : 8, height: 8)
                }
            }
            .animation(.spring, value: step)
            .padding(.bottom, 12)
        }
        .sheet(isPresented: $showPairing) {
            PairingView(onPaired: {
                showPairing = false
                model.onboarded = true
            })
        }
    }

    private var welcome: some View {
        page {
            ZStack {
                RoundedRectangle(cornerRadius: 26, style: .continuous).fill(.echoBackground)
                EchoMark(size: 58)
            }
            .frame(width: 108, height: 108)
            .shadow(color: .black.opacity(0.15), radius: 14, y: 8)
            Text("Echo for iPhone").font(.largeTitle.weight(.bold))
            Text("Record your session summary anywhere. When you get home, it’s waiting in Echo on your Mac.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 18) {
                point("person.wave.2", "Say the client’s name, then your summary.")
                point("iphone", "Transcribed on this iPhone. The audio never leaves it.")
                point("laptopcomputer", "Sent to your Mac over Wi-Fi, then deleted here.")
            }
            .padding(.top, 10)
        } action: {
            primary("Continue") { step = 1 }
        }
    }

    private var speech: some View {
        page {
            Image(systemName: "waveform.badge.mic")
                .font(.system(size: 54, weight: .light))
                .foregroundStyle(Color.accentColor)
                .frame(height: 108)
            Text("Speech model").font(.largeTitle.weight(.bold))
            Text("Echo transcribes on this iPhone with the same model as your Mac. It’s a one-time download of about 450 MB, best over Wi-Fi.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            SpeechModelRow()
                .padding()
                .frame(maxWidth: .infinity)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.top, 8)
        } action: {
            switch model.speech.status {
            case .notDownloaded, .failed:
                primary("Download") { model.speech.prepare() }
                secondary("Later") { step = 2 }
            default:
                primary("Continue") { step = 2 }
                if model.speech.status != .ready {
                    Text("You can carry on while it downloads.").font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var pair: some View {
        page {
            Image(systemName: "qrcode.viewfinder")
                .font(.system(size: 54, weight: .light))
                .foregroundStyle(Color.accentColor)
                .frame(height: 108)
            Text("Pair with your Mac").font(.largeTitle.weight(.bold))
            Text("On your Mac, open Echo › Settings, find iPhone and click Pair iPhone. Then scan the code it shows.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        } action: {
            if model.link.pairing != nil {
                primary("Start Recording") { model.onboarded = true }
            } else {
                primary("Scan Pairing Code") { showPairing = true }
                secondary("Later") { model.onboarded = true }
            }
        }
    }

    private func page<Content: View, Action: View>(@ViewBuilder _ content: () -> Content, @ViewBuilder action: () -> Action) -> some View {
        VStack(spacing: 16) {
            Spacer()
            content()
            Spacer()
            VStack(spacing: 10) { action() }
        }
        .padding(.horizontal, 32)
        .padding(.bottom, 20)
    }

    private func point(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(Color.accentColor)
                .frame(width: 30)
            Text(text).font(.body)
        }
    }

    private func primary(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).frame(maxWidth: .infinity) }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
    }

    private func secondary(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(title, action: action).controlSize(.large)
    }
}
