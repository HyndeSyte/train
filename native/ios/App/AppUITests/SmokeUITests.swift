import XCTest

// The durable-store smoke (plan v4, R2 tests): the app launches on a synthetic fixture (two invented
// sessions, imported into an empty store by bridge.js under -trainFixture), one recovery ring session
// is driven through the web UI to Complete, then the app relaunches: no banner, the session is in
// History, Settings shows "Store: rev N committed", and the authoritative file (read by native and
// shown in the store-summary label) carries the new Session ID and payload fields.
final class SmokeUITests: XCTestCase {
    private let args = ["-trainFixture", "smoke", "-trainSmoke", "-trainUITest"]

    func testFixtureSessionSurvivesRelaunch() throws {
        let app = XCUIApplication()
        app.launchArguments = args + ["-trainResetStore"]   // the first launch starts from an empty phone
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 60), "web view present")
        let store = app.staticTexts["store-summary"]
        XCTAssertTrue(store.waitForExistence(timeout: 60), "store-summary label present")
        print("SMOKE_DEBUG_BOOT store=" + store.label)
        XCTAssertTrue(waitLabel(store, contains: "\"sessions\":2"), "the fixture was imported into the store: " + store.label)
        XCTAssertTrue(web.buttons["Start Today's Session"].waitForExistence(timeout: 60), "Home is writable after hydration; " + labelsOf(app))
        // the fixture import recorded verification like a real Import; at the record's rev the state is verified
        XCTAssertTrue(waitSummary(store, timeout: 20) { (($0["bridge"] as? [String: Any])?["verified"] as? [String: Any])?["ok"] as? Bool == true }, "verified after the import: " + store.label)
        XCTAssertEqual(bridgeNote(store, "verified")["changedSince"] as? Bool, false, store.label)
        XCTAssertFalse(web.staticTexts.matching(NSPredicate(format: "label CONTAINS 'kept as a snapshot' OR label CONTAINS 'fell behind'")).firstMatch.exists, "no banner on first launch")

        // 1. one recovery ring session through the real UI
        let run = runSessionToComplete(app, web)
        let completed = run.completed, trail = run.trail
        print("SMOKE_TRAIL " + trail.joined(separator: " > "))
        XCTAssertTrue(completed, "reached Complete Session; trail: " + trail.joined(separator: " > ") + "; " + labelsOf(app))

        // 2. the store committed the new session: parsed from the file by native
        XCTAssertTrue(waitLabel(store, contains: "\"sessions\":3"), "store has the new session: " + store.label)
        let afterText = stableLabel(store)
        let after = json(afterText)
        let lastId = try XCTUnwrap(after["lastSessionId"] as? String, "lastSessionId in the file: " + store.label)
        XCTAssertFalse(lastId.isEmpty)
        XCTAssertEqual(after["lastSessionType"] as? String, "RP", "the new entry is the RP session")
        XCTAssertNotNil(after["lastDate"] as? String)
        XCTAssertNotNil(after["lastStatus"] as? String)
        let rev1 = (after["rev"] as? NSNumber)?.intValue ?? -1
        XCTAssertGreaterThan(rev1, 1, "rev advanced past the fixture import")
        print("SMOKE_RESULT_1 " + afterText)
        // the session's cues played natively: the audio session is back to mix-only and inactive
        let audio = try XCTUnwrap(after["audio"] as? [String: Any], "audio status in the summary: " + afterText)
        XCTAssertGreaterThan((audio["plays"] as? NSNumber)?.intValue ?? 0, 0, "cues played: " + afterText)
        XCTAssertEqual((audio["failures"] as? NSNumber)?.intValue, 0, "no cue failed: " + afterText)
        XCTAssertEqual(audio["active"] as? Bool, false, "the audio session is deactivated after the last cue: " + afterText)
        XCTAssertEqual(audio["options"] as? [String], ["mixWithOthers"], "category back to mix-only: " + afterText)
        XCTAssertEqual(audio["category"] as? String, "AVAudioSessionCategoryPlayback")
        XCTAssertGreaterThan((audio["deactivations"] as? NSNumber)?.intValue ?? 0, 0, "deactivated with notifyOthersOnDeactivation: " + afterText)
        XCTAssertTrue(audio["lastError"] is NSNull || audio["lastError"] == nil, "no audio error: " + afterText)
        // one cue's own result, recorded by bridge.js as it played: ducking was on while the cue sounded
        let cue = try XCTUnwrap((after["bridge"] as? [String: Any])?["cue"] as? [String: Any], "a cue result in the summary: " + afterText)
        XCTAssertEqual(cue["active"] as? Bool, true, "the session was active during the cue: " + String(describing: cue))
        XCTAssertTrue((cue["options"] as? [String] ?? []).contains("duckOthers"), "duckOthers set during the cue: " + String(describing: cue))
        XCTAssertTrue((cue["options"] as? [String] ?? []).contains("mixWithOthers"), "mixWithOthers kept during the cue: " + String(describing: cue))
        print("SMOKE_AUDIO " + afterText)

        // 3. relaunch: no banner, same file, the session in History, Settings shows the store line
        app.terminate()
        app.launchArguments = args
        app.launch()
        XCTAssertTrue(web.waitForExistence(timeout: 60))
        XCTAssertTrue(web.buttons["Start Today's Session"].waitForExistence(timeout: 60), "Home writable after relaunch; " + labelsOf(app))
        XCTAssertTrue(waitLabel(store, contains: lastId), "the file still carries the session after relaunch: " + store.label)
        let againText = stableLabel(store)
        let again = json(againText)
        XCTAssertEqual((again["sessions"] as? NSNumber)?.intValue, 3)
        XCTAssertEqual(again["lastSessionId"] as? String, lastId)
        XCTAssertEqual((again["rev"] as? NSNumber)?.intValue, rev1, "no write on an equal-hash relaunch: before " + afterText + " after " + againText)
        XCTAssertEqual(again["hash"] as? String, after["hash"] as? String, "same bytes after the relaunch")
        // the Import's verdict is read back from the sidecar after the kill and reopen; the state moved on since
        XCTAssertTrue(waitSummary(store, timeout: 20) { (($0["bridge"] as? [String: Any])?["verified"] as? [String: Any])?["changedSince"] as? Bool == true }, "verified record after relaunch: " + store.label)
        let verified = bridgeNote(store, "verified")
        XCTAssertEqual(verified["ok"] as? Bool, true, "the verdict made at the import's rev stands: " + String(describing: verified))
        XCTAssertEqual(int(verified["rev"]), 1, "the record's rev is the fixture import's")
        XCTAssertEqual(int(verified["sessionsNow"]), 3)
        XCTAssertFalse(web.staticTexts.matching(NSPredicate(format: "label CONTAINS 'kept as a snapshot' OR label CONTAINS 'fell behind' OR label CONTAINS 'did not reach'")).firstMatch.exists, "no banner after relaunch")

        web.buttons.matching(NSPredicate(format: "label CONTAINS 'History'")).firstMatch.tap()
        XCTAssertTrue(web.staticTexts.matching(NSPredicate(format: "label CONTAINS 'RP'")).firstMatch.waitForExistence(timeout: 15), "History lists the RP session")
        web.buttons.matching(NSPredicate(format: "label CONTAINS 'Settings'")).firstMatch.tap()
        let storeLine = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Store: rev'")).firstMatch
        XCTAssertTrue(storeLine.waitForExistence(timeout: 15), "Settings shows the store line")
        XCTAssertTrue(storeLine.label.contains("committed"), "store line names the commit: " + storeLine.label)
        print("SMOKE_RESULT_2 " + store.label + " | " + storeLine.label)
        let attachment = XCTAttachment(string: store.label + "\n" + storeLine.label + "\n" + trail.joined(separator: " > "))
        attachment.name = "smoke.txt"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
