import XCTest

// Gate 0: the shell launches, bridge.js reaches one in-app plugin (TrainStore.ping) and one Capacitor
// plugin (Filesystem.getUri) through the injected bridge, in a secure context at capacitor://localhost.
// bridge.js hands its JSON report to TrainStore.report, which lands in the test summary (store-summary,
// bridge.gate0); this test reads it there.
final class Gate0UITests: XCTestCase {
    func testGate0BridgeAnswers() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-trainUITest"]      // the report labels exist only under this argument (Debug builds)
        app.launch()

        let store = app.staticTexts["store-summary"]
        XCTAssertTrue(store.waitForExistence(timeout: 90), "store-summary label is in the view")
        XCTAssertTrue(waitSummary(store, timeout: 90) { ($0["bridge"] as? [String: Any])?["gate0"] != nil }, "the gate 0 report reached the summary: " + store.label)
        let json = store.label
        print("GATE0_RESULT " + json)
        let attachment = XCTAttachment(string: json)
        attachment.name = "gate0.json"
        attachment.lifetime = .keepAlways
        add(attachment)

        let obj = bridgeNote(store, "gate0")
        XCTAssertFalse(obj.isEmpty, "report in the summary: " + json)
        let errors = obj["errors"] as? [Any] ?? ["missing"]
        XCTAssertEqual(errors.count, 0, "no bridge errors: " + json)
        XCTAssertEqual(obj["isSecureContext"] as? Bool, true, "secure context")
        XCTAssertEqual(obj["origin"] as? String, "capacitor://localhost", "origin")

        let trainStore = try XCTUnwrap(obj["trainStore"] as? [String: Any], "TrainStore answered: " + json)
        let pong = try XCTUnwrap(trainStore["value"] as? [String: Any])
        XCTAssertEqual(pong["pong"] as? String, "gate0")
        XCTAssertNotNil(pong["rev"] as? Int, "ping reports the store rev")

        let capPlugin = try XCTUnwrap(obj["capPlugin"] as? [String: Any], "Filesystem answered: " + json)
        let uri = try XCTUnwrap((capPlugin["value"] as? [String: Any])?["uri"] as? String)
        XCTAssertTrue(uri.hasPrefix("file://"), "getUri returned a file URL: " + uri)
        XCTAssertTrue(uri.hasSuffix("gate0.txt"), "getUri resolved the requested path: " + uri)

        XCTAssertEqual(obj["ok"] as? Bool, true, "bridge.js judged gate 0 ok: " + json)
    }
}
