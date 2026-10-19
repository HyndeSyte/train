import XCTest

// Gate 0: the shell launches, bridge.js reaches one in-app plugin (TrainStore.ping) and one Capacitor
// plugin (Filesystem.getUri) through the injected bridge, in a secure context at capacitor://localhost.
// bridge.js hands its JSON report to TrainStore.report, which the view controller shows in a label with
// the accessibility identifier gate0-result; this test reads that label.
final class Gate0UITests: XCTestCase {
    func testGate0BridgeAnswers() throws {
        let app = XCUIApplication()
        app.launch()

        let label = app.staticTexts["gate0-result"]
        XCTAssertTrue(label.waitForExistence(timeout: 90), "gate0 label is in the view")
        let reported = expectation(for: NSPredicate(format: "label BEGINSWITH '{'"), evaluatedWith: label, handler: nil)
        wait(for: [reported], timeout: 90)

        let json = label.label
        print("GATE0_RESULT " + json)
        let attachment = XCTAttachment(string: json)
        attachment.name = "gate0.json"
        attachment.lifetime = .keepAlways
        add(attachment)

        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any], "report is JSON: " + json)
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
