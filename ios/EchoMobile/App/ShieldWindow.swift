import SwiftUI
import UIKit

/// The lock screen and the app-switcher cover live in their own window above
/// everything else. In the main window they'd sit under any open sheet, so a
/// transcript open in a sheet would show in the app switcher and stay usable
/// while "locked".
@MainActor
final class ShieldWindow {
    private var window: UIWindow?

    func install(model: AppModel) {
        guard window == nil, let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        let window = PassThroughWindow(windowScene: scene)
        window.shielding = { [weak model] in model.map { $0.lock.enabled && $0.lock.locked } ?? false }
        window.windowLevel = .alert + 1
        let host = UIHostingController(rootView: ShieldView().environment(model))
        host.view.backgroundColor = .clear
        window.rootViewController = host
        window.isHidden = false
        self.window = window
    }
}

/// Takes touches only while the lock screen is up; otherwise they go to the app underneath.
/// (SwiftUI handles touches on the hosting view itself, so asking which view was hit can't tell
/// the lock screen's button from empty space.)
private final class PassThroughWindow: UIWindow {
    var shielding: () -> Bool = { false }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        shielding() ? super.hitTest(point, with: event) : nil
    }
}

private struct ShieldView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        // Not @Environment(\.scenePhase): in a window SwiftUI didn't create, it never reports .active.
        ZStack {
            if model.lock.enabled && model.lock.locked {
                LockView().transition(.opacity)
            } else if model.lock.enabled && !model.active {
                PrivacyCover()
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.lock.locked)
    }
}
