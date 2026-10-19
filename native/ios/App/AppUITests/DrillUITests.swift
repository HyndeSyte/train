import XCTest

// The forced-failure drill (plan v4, section 5): on the synthetic fixture, one session is completed and
// its finalize save is refused by a Debug-only hook (-trainFailSaveOnSessions 3 refuses the first save
// whose log holds three sessions, reason "write"); the app relaunches. The drill passes only if the
// newest completed Session ID and payload are in active History afterwards (the write-through case), or,
// in the conflict case, both copies are kept, Settings offers "Export the saved snapshot" beside Export
// and the kept snapshot (read through the test summary) holds that session. An older history is never
// called a successful rollback.
final class DrillUITests: XCTestCase {
    private let args = ["-trainFixture", "smoke", "-trainSmoke", "-trainUITest"]

    func testForcedFailureDrill() throws {
        let app = XCUIApplication()
        app.launchArguments = args + ["-trainResetStore", "-trainFailSaveOnSessions", "3"]
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 60), "web view present")
        let store = app.staticTexts["store-summary"]
        XCTAssertTrue(store.waitForExistence(timeout: 60), "store-summary label present")
        XCTAssertTrue(waitLabel(store, contains: "\"sessions\":2"), "the fixture was imported: " + store.label)

        // 1. a session; its finalize save is refused
        let run = runSessionToComplete(app, web)
        XCTAssertTrue(run.completed, "reached Complete Session; trail: " + run.trail.joined(separator: " > "))
        XCTAssertTrue(waitSummary(store, timeout: 30) { (($0["bridge"] as? [String: Any])?["failedSave"] as? [String: Any]) != nil }, "the drill hook refused a save: " + store.label)
        XCTAssertTrue(waitSummary(store, timeout: 30) { self.int((($0["bridge"] as? [String: Any])?["local"] as? [String: Any])?["sessions"]) == 3 }, "the local copy holds the new session: " + store.label)
        let before = json(store.label)
        let local = bridgeNote(store, "local")
        let newId = try XCTUnwrap(local["lastSessionId"] as? String, "the local copy's newest session id: " + store.label)
        XCTAssertEqual(local["lastSessionType"] as? String, "RP")
        XCTAssertEqual(local["lastStatus"] as? String, "completed")
        XCTAssertEqual(int(before["sessions"]), 2, "the file is behind after the refused save: " + store.label)
        XCTAssertTrue(web.staticTexts.matching(NSPredicate(format: "label CONTAINS 'refused the last save'")).firstMatch.waitForExistence(timeout: 10), "the banner names the refused save; " + labelsOf(app))
        print("DRILL_BEFORE " + store.label)

        // 2. relaunch without the hook
        app.terminate()
        app.launchArguments = args
        app.launch()
        XCTAssertTrue(web.waitForExistence(timeout: 60))
        XCTAssertTrue(web.buttons["Start Today's Session"].waitForExistence(timeout: 60), "Home after the relaunch; " + labelsOf(app))
        let afterText = stableLabel(store)
        let after = json(afterText)
        let fileHasIt = (after["sessionIds"] as? [String] ?? []).contains(newId)
        if fileHasIt {
            // the write-through case: the newest completed session and its payload are in the authoritative file and in History
            XCTAssertEqual(int(after["sessions"]), 3, afterText)
            XCTAssertEqual(after["lastSessionId"] as? String, newId, afterText)
            XCTAssertEqual(after["lastSessionType"] as? String, "RP", afterText)
            XCTAssertEqual(after["lastStatus"] as? String, "completed", afterText)
            XCTAssertFalse(web.staticTexts.matching(NSPredicate(format: "label CONTAINS 'kept as a snapshot'")).firstMatch.exists, "no conflict banner in the write-through case")
            web.buttons.matching(NSPredicate(format: "label CONTAINS 'History'")).firstMatch.tap()
            XCTAssertTrue(web.staticTexts.matching(NSPredicate(format: "label CONTAINS 'RP'")).firstMatch.waitForExistence(timeout: 15), "History lists the RP session")
            print("DRILL_RESULT write-through: " + newId + " in the file and in History | " + afterText)
        } else {
            // the conflict case: both copies kept, the snapshot export offered beside Export, the snapshot holds the session
            XCTAssertTrue(web.staticTexts.matching(NSPredicate(format: "label CONTAINS 'kept as a snapshot'")).firstMatch.waitForExistence(timeout: 15), "the conflict banner; " + afterText)
            let snapshot = bridgeNote(store, "snapshot")
            XCTAssertTrue((snapshot["sessionIds"] as? [String] ?? []).contains(newId), "the kept snapshot holds the session: " + String(describing: snapshot))
            web.buttons.matching(NSPredicate(format: "label CONTAINS 'Settings'")).firstMatch.tap()
            XCTAssertTrue(web.buttons["Export the saved snapshot"].waitForExistence(timeout: 15), "Settings offers the snapshot export")
            XCTAssertTrue(web.buttons["Export"].exists, "beside Export")
            print("DRILL_RESULT conflict: " + newId + " kept in the snapshot, not in the loaded history | " + afterText)
        }
        let attachment = XCTAttachment(string: afterText)
        attachment.name = "drill.txt"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
