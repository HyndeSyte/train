import XCTest

// Parity (plan v4, R2 build order 3 and 4) on the CI simulator:
//   - the awake screen: PT's list acquires the idle timer through the navigator.wakeLock polyfill; the
//     app goes to the background (home) and comes back; the page re-acquires (acquires 2, releases 1);
//   - embeds: the uiTest-only "Embed test" in Settings opens the reference modal on a known public video
//     through the https wrapper on Pages and the wrapper reports player-ready by postMessage. The
//     wrapper is served from main, so a branch build may find it missing (404); that is reported, not
//     asserted, and the player-ready assertion runs when the wrapper is reachable.
final class ParityUITests: XCTestCase {
    private let args = ["-trainFixture", "smoke", "-trainSmoke", "-trainUITest"]

    private func wake(_ store: XCUIElement) -> [String: Any] { json(store.label)["wake"] as? [String: Any] ?? [:] }
    private func embed(_ store: XCUIElement) -> [String: Any] { (json(store.label)["bridge"] as? [String: Any])?["embed"] as? [String: Any] ?? [:] }

    func testWakeReacquireAcrossBackgroundAndEmbed() throws {
        let app = XCUIApplication()
        app.launchArguments = args + ["-trainResetStore"]
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 60), "web view present")
        let store = app.staticTexts["store-summary"]
        XCTAssertTrue(store.waitForExistence(timeout: 60), "store-summary label present")
        XCTAssertTrue(waitLabel(store, contains: "\"sessions\":2"), "the fixture was imported: " + store.label)

        // 1. PT's list: Start holds the screen
        let ptButton = web.buttons.matching(NSPredicate(format: "label CONTAINS 'PT'")).firstMatch
        XCTAssertTrue(ptButton.waitForExistence(timeout: 30), "Home offers PT's list (recovery mode)")
        ptButton.tap()
        let same = web.buttons["Same"]
        if same.waitForExistence(timeout: 5) { same.tap() }
        let startWith = web.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Start with'")).firstMatch
        XCTAssertTrue(startWith.waitForExistence(timeout: 30), "the list offers its first item")
        startWith.tap()
        let start = web.buttons["Start"]
        XCTAssertTrue(start.waitForExistence(timeout: 30), "the item offers Start")
        start.tap()
        XCTAssertTrue(waitSummary(store) { self.int(($0["wake"] as? [String: Any])?["acquires"]) >= 1 && (($0["wake"] as? [String: Any])?["held"] as? Bool) == true }, "ptWakeOn acquired the idle timer: " + store.label)
        var w = wake(store)
        XCTAssertEqual(int(w["acquires"]), 1, "one acquire so far: " + store.label)
        XCTAssertEqual(w["held"] as? Bool, true, "held: " + store.label)
        XCTAssertEqual(w["idleTimerDisabled"] as? Bool, true, "UIApplication idle timer disabled: " + store.label)
        print("PARITY_WAKE_1 " + String(describing: w))

        // 2. background (home) and back: native released; the page re-acquires on visible
        XCUIDevice.shared.press(.home)
        sleep(3)
        app.activate()
        XCTAssertTrue(web.waitForExistence(timeout: 30))
        XCTAssertTrue(waitSummary(store) { self.int(($0["wake"] as? [String: Any])?["acquires"]) >= 2 && (($0["wake"] as? [String: Any])?["held"] as? Bool) == true }, "re-acquired after foreground: " + store.label)
        w = wake(store)
        XCTAssertEqual(w["held"] as? Bool, true, "held again: " + store.label)
        XCTAssertGreaterThanOrEqual((w["releases"] as? NSNumber)?.intValue ?? 0, 1, "released in between: " + store.label)
        XCTAssertEqual(w["idleTimerDisabled"] as? Bool, true)
        print("PARITY_WAKE_2 " + String(describing: w))

        // closing the list releases it
        let close = web.buttons.matching(NSPredicate(format: "label CONTAINS 'Close'")).firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 10), "the PT screen's Close")
        close.tap()
        XCTAssertTrue(waitSummary(store, timeout: 15) { (($0["wake"] as? [String: Any])?["held"] as? Bool) == false }, "Close released the idle timer: " + store.label)
        XCTAssertEqual(wake(store)["idleTimerDisabled"] as? Bool, false)
        print("PARITY_WAKE_3 " + String(describing: wake(store)))

        // 3. embeds through the wrapper
        web.buttons.matching(NSPredicate(format: "label CONTAINS 'Settings'")).firstMatch.tap()
        let embedButton = web.buttons["Embed test"]
        XCTAssertTrue(embedButton.waitForExistence(timeout: 15), "Settings offers the uiTest embed button")
        embedButton.tap()
        XCTAssertTrue(waitLabel(store, contains: "\"wrapper\":", timeout: 30), "the wrapper probe answered: " + store.label)
        var e = embed(store)
        let wrapper = e["wrapper"]
        print("PARITY_EMBED_PROBE " + String(describing: e))
        if (wrapper as? NSNumber)?.intValue == 404 {
            // exactly 404: the wrapper lives on Pages (main) and is not published yet. Reported, not asserted.
            sleep(5)
            e = embed(store)
            print("PARITY_EMBED wrapper not published yet (404): player-ready not observable on this branch; state " + String(describing: e["state"]))
        } else {
            // anything else is a verdict: ready passes; a 5xx, a fetch error, a player error or a timeout fails
            let ready = waitLabel(store, contains: "\"state\":\"ready\"", timeout: 75)
            e = embed(store)
            print("PARITY_EMBED " + String(describing: e))
            XCTAssertEqual((wrapper as? NSNumber)?.intValue, 200, "the wrapper answered: " + String(describing: e))
            XCTAssertTrue(ready, "the player reported ready through the wrapper: " + String(describing: e))
        }
        let attachment = XCTAttachment(string: store.label)
        attachment.name = "parity.txt"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
