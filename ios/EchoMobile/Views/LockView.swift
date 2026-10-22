import SwiftUI

/// Shown until Face ID (or the passcode) unlocks Echo.
struct LockView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            Rectangle().fill(.echoBackground).ignoresSafeArea()
            VStack(spacing: 18) {
                EchoMark(size: 64)
                Text("Echo is locked")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white)
                Button {
                    model.lock.unlock(tapped: true)
                } label: {
                    Label("Unlock with \(model.lock.biometryName)", systemImage: model.lock.biometryName == "Face ID" ? "faceid" : "lock.open")
                        .padding(.horizontal, 6)
                }
                .buttonStyle(.borderedProminent)
                .tint(.white)
                .foregroundStyle(Color.echoDeep)
                .controlSize(.large)
                .padding(.top, 8)
            }
        }
        .onAppear { model.lock.unlock() }
    }
}

/// Covers the screen in the app switcher so transcripts aren't visible there.
struct PrivacyCover: View {
    var body: some View {
        ZStack {
            Rectangle().fill(.echoBackground).ignoresSafeArea()
            EchoMark(size: 64)
        }
        // Lets the UI tests check the cover is gone once Echo is in front.
        .accessibilityElement()
        .accessibilityIdentifier("privacy-cover")
    }
}
