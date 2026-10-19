import XCTest

// The tombstone probe (plan v4, section 5): the one live call a CI run may make. On -trainProbeTombstone
// (Debug + -trainUITest), bridge.js posts one op:'delete' for the probe fixture's unused id (empty log,
// one pendingDeletes id of 8+ characters) over the ORIGINAL window.fetch, so the request carries
// Origin: capacitor://localhost and a real preflight, with X-Train-Client: pwa (a test-only header value:
// the live writer flag says pwa until cutover) and no key. The function answers 200 noop-absent and
// writes nothing. A CORS failure is reported as it is, not worked around.
final class ProbeUITests: XCTestCase {
    func testTombstoneProbeFromTheWebView() throws {
        // the client header comes from the workflow (TEST_RUNNER_TRAIN_PROBE_CLIENT): pwa until cutover, native after
        let client = ProcessInfo.processInfo.environment["TRAIN_PROBE_CLIENT"].flatMap { $0.isEmpty ? nil : $0 } ?? "pwa"
        let app = XCUIApplication()
        app.launchArguments = ["-trainFixture", "probe", "-trainSmoke", "-trainUITest", "-trainResetStore", "-trainProbeTombstone", "-trainProbeClient", client]
        app.launch()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 60), "web view present")
        let store = app.staticTexts["store-summary"]
        XCTAssertTrue(store.waitForExistence(timeout: 60), "store-summary label present")
        XCTAssertTrue(waitSummary(store, timeout: 90) {
            let p = ($0["bridge"] as? [String: Any])?["probe"] as? [String: Any]
            return p != nil && (p?["status"] != nil || p?["error"] != nil)
        }, "the probe answered: " + store.label)
        let probe = bridgeNote(store, "probe")
        print("PROBE_RESULT " + String(describing: probe))
        XCTAssertNil(probe["error"], "the request failed from the WebView (a CORS or network finding, reported as is): " + String(describing: probe))
        XCTAssertEqual(int(probe["status"]), 200, "status: " + String(describing: probe))
        XCTAssertEqual(probe["action"] as? String, "noop-absent", "the function wrote nothing: " + String(describing: probe))
        XCTAssertEqual(probe["client"] as? String, client, "the header the workflow asked for")
        XCTAssertEqual(probe["id"] as? String, "train-probe-unused-00000000")
        XCTAssertEqual(int(json(store.label)["sessions"]), 0, "the probe fixture has an empty log")
        let attachment = XCTAttachment(string: store.label)
        attachment.name = "probe.txt"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
