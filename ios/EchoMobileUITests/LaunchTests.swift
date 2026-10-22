import XCTest

/// Taps through the screens a clinician meets first, so a screen that can't be
/// got past (as the lock screen once was) fails here rather than on a phone.
@MainActor
final class LaunchTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func launch(onboarded: Bool, lock: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        // Launch arguments override saved settings, so each test starts from a known state.
        app.launchArguments = ["-onboarded", onboarded ? "YES" : "NO", "-faceIDLock", lock ? "YES" : "NO"]
        app.launchEnvironment = ["ECHO_FAKE_UNLOCK": "1"]
        app.launch()
        // Buttons under a cover can still be found and tapped by tests, so check the cover itself.
        let cover = app.otherElements["privacy-cover"]
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: cover)
        wait(for: [gone], timeout: 5)
        return app
    }

    func testFreshInstallGetsPastTheWelcomeScreen() {
        let app = launch(onboarded: false, lock: true)
        XCTAssertTrue(app.staticTexts["Echo for iPhone"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Echo is locked"].exists, "Nothing to lock before setup")
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.staticTexts["Speech model"].waitForExistence(timeout: 5))
    }

    func testUnlockButtonOpensTheAppAndTapsReachIt() {
        let app = launch(onboarded: true, lock: true)
        XCTAssertTrue(app.staticTexts["Echo is locked"].waitForExistence(timeout: 10))
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Unlock with'")).firstMatch.tap()
        XCTAssertTrue(app.buttons["Record"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Echo is locked"].exists)
        // The lock's window stays installed above the app; touches must pass through it now.
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    }

    func testWithoutLockTheHomeScreenIsUsable() {
        let app = launch(onboarded: true, lock: false)
        XCTAssertTrue(app.buttons["Record"].waitForExistence(timeout: 10))
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    }

    func testRecordStartsAndSavesARecording() {
        let app = launch(onboarded: true, lock: false)
        XCTAssertTrue(app.buttons["Record"].waitForExistence(timeout: 10))
        app.buttons["Record"].tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5), "Recording screen didn't open: \(app.alerts.firstMatch.debugDescription)")
        sleep(2)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.staticTexts["On this iPhone".uppercased()].waitForExistence(timeout: 5) || app.staticTexts["On this iPhone"].exists)
    }
}
