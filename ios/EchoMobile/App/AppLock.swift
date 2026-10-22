import LocalAuthentication
import Observation
import UIKit

/// Face ID (or the passcode) to open Echo. On by default: the phone holds
/// transcripts until the Mac has them.
@MainActor @Observable
final class AppLock {
    var enabled = AppLock.savedEnabled {
        didSet { UserDefaults.standard.set(enabled, forKey: "faceIDLock") }
    }
    private(set) var locked: Bool
    private var authenticating = false
    /// Echo asks on its own once each time it's opened. If the clinician cancels, the
    /// Face ID sheet closing makes the app active again, which would otherwise ask again forever.
    private var askedSinceLock = false
    /// The kind of unlock this phone offers, for labels.
    let biometryName: String

    /// On unless turned off. (bool(forKey:) also reads "NO" passed as a launch argument.)
    private static var savedEnabled: Bool {
        UserDefaults.standard.object(forKey: "faceIDLock") == nil ? true : UserDefaults.standard.bool(forKey: "faceIDLock")
    }

    /// Nothing is recorded before setup is finished, so there's nothing to lock until then.
    private var setUp: Bool { UserDefaults.standard.bool(forKey: "onboarded") }

    init() {
        #if DEBUG
            if ProcessInfo.processInfo.environment["ECHO_NO_LOCK"] == "1" { UserDefaults.standard.set(false, forKey: "faceIDLock") }
        #endif
        let enabled = AppLock.savedEnabled
        self.enabled = enabled
        locked = enabled && UserDefaults.standard.bool(forKey: "onboarded")
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: biometryName = "Face ID"
        case .touchID: biometryName = "Touch ID"
        case .opticID: biometryName = "Optic ID"
        default: biometryName = "Passcode"
        }
        // Scene phase reports .active a moment before UIKit lets Face ID run, so asking from there
        // is refused. This fires once the app really is active.
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.unlock() }
        }
    }

    func lock() {
        if enabled && setUp { locked = true }
        askedSinceLock = false
    }

    /// Setup was just finished in front of the clinician: no need to ask who they are.
    func release() {
        locked = false
    }

    /// `tapped` is true when the clinician pressed Unlock, rather than Echo asking on its own.
    func unlock(tapped: Bool = false) {
        guard locked, !authenticating else { return }
        // iOS refuses Face ID until the app is fully in the foreground; it's asked again when it is.
        guard UIApplication.shared.applicationState == .active else { return }
        guard tapped || !askedSinceLock else { return }
        #if DEBUG
            let env = ProcessInfo.processInfo.environment
            if env["ECHO_LOCK_NO_PROMPT"] == "1" { return }
            if env["ECHO_FAKE_UNLOCK"] == "1" {
                if tapped { locked = false }
                return
            }
        #endif
        let context = LAContext()
        var error: NSError?
        // No passcode set on the phone: there's nothing to check against, so don't lock the clinician out.
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            locked = false
            return
        }
        authenticating = true
        askedSinceLock = true
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Open your recordings") { ok, _ in
            Task { @MainActor in
                self.authenticating = false
                if ok { self.locked = false }
            }
        }
    }
}
