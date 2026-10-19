import Foundation
import UIKit
import Capacitor
import CryptoKit

// The one in-app plugin: the durable store (plan v4, R2 build order 1) plus the gate 0 methods.
//
// Source of truth on the device is one JSON file in Library/Application Support/Train/state.json,
// written one save at a time, atomically, inside a background task, on one serial queue, with
// rotating snapshots. Swift stores the bytes it receives byte for byte (it parses `_rev` out of
// them but never re-serializes), so the content hash (SHA-256 of exactly those bytes) means the
// same thing on both sides. No engine logic lives here.
//
// control.json (sidecar): { generation, rev, syncArmed, recoveredFrom, committedAt }. The store
// generation changes on Import, Erase and snapshot recovery, so queued saves from before them are
// dropped. syncArmed is native control metadata, never exported or imported; Import and Erase
// persist it false (read back) before they touch the state file.
@objc(TrainStorePlugin)
public class TrainStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TrainStorePlugin"
    public let jsName = "TrainStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ping", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "report", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "erase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "summary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSyncArmed", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "launchOptions", returnType: CAPPluginReturnPromise)
    ]
    private(set) var lastReport: String?
    private let store = TrainStore()

    // MARK: gate 0 (kept until the smoke test replaces the label)

    @objc func ping(_ call: CAPPluginCall) {
        let echo = call.getString("echo") ?? ""
        let store = self.store
        store.queue.async {
            call.resolve(["pong": echo, "rev": store.control.rev])
        }
    }

    @objc func report(_ call: CAPPluginCall) {
        let json = call.getString("json") ?? ""
        lastReport = json
        DispatchQueue.main.async { [weak self] in
            (self?.bridge?.viewController as? TrainBridgeViewController)?.showGate0(json)
        }
        call.resolve(["stored": true, "length": json.count])
    }

    // MARK: durable store

    @objc func read(_ call: CAPPluginCall) {
        let store = self.store
        store.queue.async { [weak self] in
            let r = store.read()
            self?.publishSummary()
            call.resolve(r)
        }
    }

    @objc func save(_ call: CAPPluginCall) {
        guard let bytes = call.getString("bytes"), let base = call.getInt("base") else {
            call.resolve(["accepted": false, "reason": "invalid", "rev": self.store.control.rev, "generation": self.store.control.generation])
            return
        }
        let generation = call.getInt("generation") ?? -1
        let store = self.store
        store.queue.async { [weak self] in
            let r = store.save(base: base, bytes: bytes, generation: generation)
            self?.publishSummary()
            call.resolve(r)
        }
    }

    @objc func importState(_ call: CAPPluginCall) {
        guard let bytes = call.getString("bytes") else {
            call.resolve(["accepted": false, "reason": "invalid", "rev": self.store.control.rev, "generation": self.store.control.generation])
            return
        }
        let base = call.getInt("base")
        let store = self.store
        store.queue.async { [weak self] in
            let r = store.importState(bytes: bytes, base: base)
            self?.publishSummary()
            call.resolve(r)
        }
    }

    @objc func erase(_ call: CAPPluginCall) {
        let store = self.store
        store.queue.async { [weak self] in
            let r = store.erase()
            self?.publishSummary()
            call.resolve(r)
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        let store = self.store
        store.queue.async {
            call.resolve(store.status())
        }
    }

    @objc func summary(_ call: CAPPluginCall) {
        let store = self.store
        store.queue.async {
            call.resolve(store.summary())
        }
    }

    @objc func setSyncArmed(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        let store = self.store
        store.queue.async {
            let ok = store.setSyncArmed(on)
            call.resolve(["ok": ok, "syncArmed": store.control.syncArmed])
        }
    }

    // Test and smoke hooks from the process arguments: `-trainResetStore` empties the WebView storage
    // and the store for this launch (the UI tests share one simulator install), `-trainFixture <name>`
    // imports a bundled synthetic fixture on an empty store, `-trainSmoke` marks a smoke run. Never set
    // in a real launch, so a real launch gets { fixture: null, smoke: false, reset: false }.
    @objc func launchOptions(_ call: CAPPluginCall) {
        let args = ProcessInfo.processInfo.arguments
        var fixture: String? = nil
        if let i = args.firstIndex(of: "-trainFixture"), i + 1 < args.count { fixture = args[i + 1] }
        let fixtureValue: Any = fixture.map { $0 as Any } ?? (NSNull() as Any)
        call.resolve(["fixture": fixtureValue, "smoke": args.contains("-trainSmoke"), "reset": args.contains("-trainResetStore")])
    }

    private func publishSummary() {
        let s = store.summary()
        DispatchQueue.main.async { [weak self] in
            (self?.bridge?.viewController as? TrainBridgeViewController)?.showStoreSummary(s)
        }
    }
}

struct TrainControl {
    var generation: Int = 0
    var rev: Int = 0
    var syncArmed: Bool = false
    var recoveredFrom: String? = nil
    var committedAt: String? = nil

    var dictionary: [String: Any] {
        var d: [String: Any] = ["generation": generation, "rev": rev, "syncArmed": syncArmed]
        if let r = recoveredFrom { d["recoveredFrom"] = r }
        if let c = committedAt { d["committedAt"] = c }
        return d
    }

    static func from(_ d: [String: Any]) -> TrainControl {
        var c = TrainControl()
        c.generation = (d["generation"] as? NSNumber)?.intValue ?? 0
        c.rev = (d["rev"] as? NSNumber)?.intValue ?? 0
        c.syncArmed = (d["syncArmed"] as? NSNumber)?.boolValue ?? false
        c.recoveredFrom = d["recoveredFrom"] as? String
        c.committedAt = d["committedAt"] as? String
        return c
    }
}

// All file work runs on `queue`; every public method below assumes it is on it.
final class TrainStore {
    let queue = DispatchQueue(label: "com.hyndesyte.train.store", qos: .userInitiated)
    static let keepSnapshots = 5
    private let fm = FileManager.default
    private let dir: URL
    private let stateURL: URL
    private let controlURL: URL
    private let snapshotsURL: URL
    private(set) var control = TrainControl()

    init() {
        let manager = FileManager.default
        let base = (try? manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("Train", isDirectory: true)
        dir = d
        stateURL = d.appendingPathComponent("state.json")
        controlURL = d.appendingPathComponent("control.json")
        snapshotsURL = d.appendingPathComponent("snapshots", isDirectory: true)
        try? manager.createDirectory(at: d, withIntermediateDirectories: true)
        try? manager.createDirectory(at: d.appendingPathComponent("snapshots", isDirectory: true), withIntermediateDirectories: true)
        control = loadControl()
    }

    // MARK: control sidecar

    private func loadControl() -> TrainControl {
        guard let data = try? Data(contentsOf: controlURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return TrainControl() }
        return TrainControl.from(obj)
    }

    @discardableResult
    private func writeControl(_ c: TrainControl) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: c.dictionary, options: [.sortedKeys]) else { return false }
        do { try data.write(to: controlURL, options: .atomic) } catch { return false }
        // read back: the sidecar is what the next launch trusts
        let back = loadControl()
        guard back.generation == c.generation, back.rev == c.rev, back.syncArmed == c.syncArmed else { return false }
        control = back
        return true
    }

    // MARK: helpers

    private func orNull(_ s: String?) -> Any { s.map { $0 as Any } ?? (NSNull() as Any) }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func stateData() -> Data? { try? Data(contentsOf: stateURL) }

    // Parses the bytes as JSON and returns the object and its `_rev` (nil when not a JSON object).
    private func parse(_ data: Data) -> (obj: [String: Any], rev: Int?)? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return (obj, (obj["_rev"] as? NSNumber)?.intValue)
    }

    private func nowISO() -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date())
    }

    private func snapshotCurrent(reason: String) {
        guard fm.fileExists(atPath: stateURL.path) else { return }
        let ms = Int(Date().timeIntervalSince1970 * 1000)
        let name = "state-r\(control.rev)-\(ms)-\(reason).json"
        try? fm.copyItem(at: stateURL, to: snapshotsURL.appendingPathComponent(name))
        pruneSnapshots()
    }

    private func snapshotNames() -> [String] {
        ((try? fm.contentsOfDirectory(atPath: snapshotsURL.path)) ?? [])
            .filter { $0.hasPrefix("state-") && $0.hasSuffix(".json") }
            .sorted { a, b in
                // newest first by the millisecond stamp (third dash-separated field)
                func ms(_ s: String) -> Int { let parts = s.split(separator: "-"); return parts.count > 2 ? Int(parts[2]) ?? 0 : 0 }
                return ms(a) > ms(b)
            }
    }

    private func pruneSnapshots() {
        let names = snapshotNames()
        guard names.count > TrainStore.keepSnapshots else { return }
        for name in names[TrainStore.keepSnapshots...] { try? fm.removeItem(at: snapshotsURL.appendingPathComponent(name)) }
    }

    // Writes the state bytes atomically inside a background task, so a save started just before the
    // app is backgrounded still finishes.
    private func writeState(_ data: Data) -> Bool {
        // UIApplication is main-actor bound; the task bracket is taken and released on main, the write
        // itself stays on the store queue.
        var task = UIBackgroundTaskIdentifier.invalid
        DispatchQueue.main.sync {
            task = UIApplication.shared.beginBackgroundTask(withName: "train.store.write") {
                UIApplication.shared.endBackgroundTask(task); task = .invalid
            }
        }
        defer { DispatchQueue.main.sync { if task != .invalid { UIApplication.shared.endBackgroundTask(task); task = .invalid } } }
        do { try data.write(to: stateURL, options: .atomic); return true } catch { return false }
    }

    // MARK: read (with explicit snapshot recovery)

    func read() -> [String: Any] {
        guard let data = stateData() else {
            // a missing file is a completed read at rev 0 (first launch, or after Erase)
            if control.rev != 0 { var c = control; c.rev = 0; writeControl(c) }
            return ["rev": 0, "generation": control.generation, "hasFile": false, "hash": NSNull(), "recoveredFrom": orNull(control.recoveredFrom), "syncArmed": control.syncArmed]
        }
        if let parsed = parse(data) {
            let rev = parsed.rev ?? 0
            if rev != control.rev { var c = control; c.rev = rev; writeControl(c) }   // the bytes are the truth
            return ["rev": control.rev, "generation": control.generation, "hasFile": true, "hash": TrainStore.sha256Hex(data), "bytes": String(decoding: data, as: UTF8.self), "recoveredFrom": orNull(control.recoveredFrom), "syncArmed": control.syncArmed]
        }
        // Snapshot recovery, an explicit event: keep the corrupt file, load the newest valid
        // snapshot, record where it came from, bump the generation.
        let ms = Int(Date().timeIntervalSince1970 * 1000)
        try? fm.moveItem(at: stateURL, to: dir.appendingPathComponent("state-corrupt-\(ms).json"))
        var recoveredName = "none"
        var recoveredRev = 0
        var recoveredData: Data? = nil
        for name in snapshotNames() {
            let url = snapshotsURL.appendingPathComponent(name)
            if let d = try? Data(contentsOf: url), let p = parse(d) { recoveredName = name; recoveredRev = p.rev ?? 0; recoveredData = d; break }
        }
        var c = control
        c.generation += 1
        c.recoveredFrom = recoveredName
        c.rev = recoveredRev
        c.committedAt = nowISO()
        if let d = recoveredData { _ = writeState(d) }
        writeControl(c)
        if let d = recoveredData {
            return ["rev": control.rev, "generation": control.generation, "hasFile": true, "hash": TrainStore.sha256Hex(d), "bytes": String(decoding: d, as: UTF8.self), "recoveredFrom": orNull(control.recoveredFrom), "syncArmed": control.syncArmed, "recovered": true]
        }
        return ["rev": 0, "generation": control.generation, "hasFile": false, "hash": NSNull(), "recoveredFrom": orNull(control.recoveredFrom), "syncArmed": control.syncArmed, "recovered": true]
    }

    // MARK: compare-and-swap save

    func save(base: Int, bytes: String, generation: Int) -> [String: Any] {
        let current = stateData()
        let currentHash: Any = current.map { TrainStore.sha256Hex($0) as Any } ?? (NSNull() as Any)
        func refuse(_ reason: String) -> [String: Any] { ["accepted": false, "reason": reason, "rev": control.rev, "generation": control.generation, "hash": currentHash] }
        if generation != control.generation { return refuse("generation") }
        let data = Data(bytes.utf8)
        guard let parsed = parse(data), let newRev = parsed.rev, newRev > base else { return refuse("invalid") }
        if base != control.rev { return refuse("stale") }
        snapshotCurrent(reason: "save")
        guard writeState(data) else { return refuse("write") }
        var c = control
        c.rev = newRev
        c.committedAt = nowISO()
        guard writeControl(c) else { return refuse("write") }
        return ["accepted": true, "rev": control.rev, "generation": control.generation, "hash": TrainStore.sha256Hex(data)]
    }

    // MARK: transactions (Import, Erase): snapshot, disarm, bump the generation, commit

    func importState(bytes: String, base: Int?) -> [String: Any] {
        let data = Data(bytes.utf8)
        func refuse(_ reason: String) -> [String: Any] { ["accepted": false, "reason": reason, "rev": control.rev, "generation": control.generation] }
        guard let parsed = parse(data), let newRev = parsed.rev else { return refuse("invalid") }
        if let b = base, b != control.rev { return refuse("stale") }
        if newRev != control.rev + 1 { return refuse("invalid") }
        snapshotCurrent(reason: "import")
        // disarm first, read back, abort if it does not stick
        var disarmed = control
        disarmed.syncArmed = false
        guard writeControl(disarmed) else { return refuse("disarm") }
        guard writeState(data) else { return refuse("write") }
        var c = control
        c.generation += 1
        c.rev = newRev
        c.committedAt = nowISO()
        guard writeControl(c) else { return refuse("write") }
        return ["accepted": true, "rev": control.rev, "generation": control.generation, "hash": TrainStore.sha256Hex(data)]
    }

    func erase() -> [String: Any] {
        func refuse(_ reason: String) -> [String: Any] { ["accepted": false, "reason": reason, "rev": control.rev, "generation": control.generation] }
        snapshotCurrent(reason: "erase")
        var disarmed = control
        disarmed.syncArmed = false
        guard writeControl(disarmed) else { return refuse("disarm") }
        if fm.fileExists(atPath: stateURL.path) {
            do { try fm.removeItem(at: stateURL) } catch { return refuse("write") }
        }
        var c = control
        c.generation += 1
        c.rev = 0
        c.committedAt = nowISO()
        guard writeControl(c) else { return refuse("write") }
        return ["accepted": true, "rev": 0, "generation": control.generation, "hash": NSNull()]
    }

    func setSyncArmed(_ on: Bool) -> Bool {
        var c = control
        c.syncArmed = on
        return writeControl(c)
    }

    // MARK: status and summary (parsed, never re-serialized)

    func status() -> [String: Any] {
        ["rev": control.rev, "generation": control.generation, "committedAt": orNull(control.committedAt), "syncArmed": control.syncArmed,
         "recoveredFrom": orNull(control.recoveredFrom), "hasFile": fm.fileExists(atPath: stateURL.path), "snapshots": snapshotNames().count]
    }

    func summary() -> [String: Any] {
        var out: [String: Any] = ["rev": control.rev, "generation": control.generation, "hasFile": false, "sessions": 0]
        guard let data = stateData(), let parsed = parse(data) else { return out }
        out["hasFile"] = true
        out["hash"] = TrainStore.sha256Hex(data)
        let log = parsed.obj["log"] as? [[String: Any]] ?? []
        out["sessions"] = log.count
        out["sessionIds"] = log.compactMap { $0["sessionId"] as? String }
        if let last = log.last {
            out["lastSessionId"] = orNull(last["sessionId"] as? String)
            out["lastSessionType"] = orNull(last["sessionType"] as? String)
            out["lastDate"] = orNull(last["date"] as? String)
            out["lastStatus"] = orNull(last["sessionStatus"] as? String)
        }
        return out
    }
}
