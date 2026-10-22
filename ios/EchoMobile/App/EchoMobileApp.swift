import SwiftUI

@main
struct EchoMobileApp: App {
    @State private var model = AppModel()
    @State private var shield = ShieldWindow()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(.accentColor)
                .onAppear {
                    shield.install(model: model)
                    model.launch()
                }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            model.active = phase == .active
            switch phase {
            case .active:
                model.lock.unlock()
                model.becameActive()
            case .background:
                model.lock.lock()
                model.wentToBackground()
            default:
                break
            }
        }
    }
}

/// The lock screen and app-switcher cover are drawn by ShieldWindow, above any open sheet.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.onboarded {
            HomeView()
        } else {
            OnboardingView()
        }
    }
}
