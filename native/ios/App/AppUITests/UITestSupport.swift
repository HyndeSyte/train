import XCTest

// Shared helpers for the CI UI tests: the summary label, JSON parsing, a stable read, the session trail.
extension XCTestCase {
    func json(_ s: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any]) ?? [:]
    }
    func waitLabel(_ e: XCUIElement, contains needle: String, timeout: TimeInterval = 60) -> Bool {
        let p = NSPredicate(format: "label CONTAINS %@", needle)
        let exp = expectation(for: p, evaluatedWith: e, handler: nil)
        return XCTWaiter().wait(for: [exp], timeout: timeout) == .completed
    }
    // polls the parsed summary until the condition holds (the label can jump past a value between reads)
    func waitSummary(_ store: XCUIElement, timeout: TimeInterval = 30, _ cond: ([String: Any]) -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if cond(json(store.label)) { return true }
            usleep(400_000)
        }
        return cond(json(store.label))
    }
    // chained saves can still be committing when a wait returns: read until two reads a second apart agree
    func stableLabel(_ e: XCUIElement, tries: Int = 20) -> String {
        var last = e.label
        for _ in 0..<tries {
            sleep(1)
            let now = e.label
            if now == last { return now }
            last = now
        }
        return last
    }
    func int(_ v: Any?) -> Int { (v as? NSNumber)?.intValue ?? -1 }
    func bridgeNote(_ store: XCUIElement, _ key: String) -> [String: Any] { (json(store.label)["bridge"] as? [String: Any])?[key] as? [String: Any] ?? [:] }
    // one snapshot of the hierarchy (allElementsBoundByIndex re-resolves each element while the page re-renders)
    func labelsOf(_ app: XCUIApplication) -> String {
        let lines = app.debugDescription.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("Button,") || $0.hasPrefix("StaticText,") }
            .prefix(40)
        return String(lines.joined(separator: " | ").prefix(1800))
    }
    @discardableResult
    func tapIfExists(_ e: XCUIElement) -> Bool {
        if e.exists && e.isHittable { e.tap(); return true }
        return false
    }
    // Drives one recovery ring session from Home to Complete Session through the real UI. Returns the trail.
    func runSessionToComplete(_ app: XCUIApplication, _ web: XCUIElement) -> (completed: Bool, trail: [String]) {
        let start = web.buttons["Start Today's Session"]
        XCTAssertTrue(start.waitForExistence(timeout: 60), "Home is writable; " + labelsOf(app))
        start.tap()
        let same = web.buttons["Same"]                 // the day's arm check
        if same.waitForExistence(timeout: 5) { same.tap() }
        sleep(1)
        var completed = false
        var trail: [String] = []
        for _ in 0..<120 {
            if tapIfExists(web.buttons["Complete Session"]) { trail.append("Complete Session"); completed = true; break }
            if tapIfExists(web.buttons["Finish"]) { trail.append("Finish"); continue }
            if tapIfExists(web.buttons["Start Next Set"]) { trail.append("Start Next Set"); continue }
            let skipRest = web.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Skip rest'")).firstMatch
            if tapIfExists(skipRest) { trail.append("Skip rest"); continue }
            if tapIfExists(web.buttons["Log set"]) { trail.append("Log set"); continue }
            if tapIfExists(web.buttons["End set early"]) { trail.append("End set early"); continue }
            if tapIfExists(web.buttons["Start hold"]) { trail.append("Start hold"); continue }
            if tapIfExists(web.buttons["Begin Training"]) { trail.append("Begin Training"); continue }
            if tapIfExists(web.buttons["Continue"]) { trail.append("Continue"); continue }
            if tapIfExists(web.buttons["Close"]) { trail.append("Close"); continue }
            if tapIfExists(web.buttons["Skip Form"]) { trail.append("Skip Form"); continue }
            if tapIfExists(web.buttons["Skip this step"]) { trail.append("Skip this step"); continue }
            let avoid = ["Stop", "Discard", "Skip", "Today", "History", "Settings", "Exercises", "Pick", "Reset", "Cancel", "preview", "Preview", "rules", "Rules", "Note", "Redo", "Pause", "Reference", "Demo", "Dismiss", "Export"]
            let format = "label != '' AND NOT (" + avoid.map { _ in "label CONTAINS %@" }.joined(separator: " OR ") + ")"
            let other = web.buttons.matching(NSPredicate(format: format, argumentArray: avoid)).firstMatch
            if other.exists && other.isHittable { let l = other.label; trail.append("tap:" + l); other.tap(); continue }
            sleep(1)
        }
        return (completed, trail)
    }
}
