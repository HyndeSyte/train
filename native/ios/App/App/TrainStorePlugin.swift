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
        CAPPluginMethod(name: "launchOptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendLog", returnType: CAPPluginReturnPromise),
        // parity (build order 3): the idle timer behind navigator.wakeLock, the native cues, the sound key
        CAPPluginMethod(name: "wakeAcquire", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wakeRelease", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSoundOff", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testNote", returnType: CAPPluginReturnPromise),
        // cutover build (plan section 5): the Import's verification record
        CAPPluginMethod(name: "setVerified", returnType: CAPPluginReturnPromise)
    ]
    private(set) var lastReport: String?
    private let store = TrainStore()
    private let wake = TrainWake()      // main thread only
    private let audio = TrainAudio()    // main thread only
    private var testNotes: [String: Any] = [:]   // bridge-side state the UI tests read through the summary (Debug + -trainUITest)
    private var observing = false
    // The forced-failure drill (Debug + -trainUITest only): -trainFailSaveOnSessions <n> refuses, once, the
    // first save whose log holds n entries (the finalize of the nth session) with reason "write".
    private var failSaveOnSessions: Int? = {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if TrainStorePlugin.uiTest, let i = args.firstIndex(of: "-trainFailSaveOnSessions"), i + 1 < args.count { return Int(args[i + 1]) }
        #endif
        return nil
    }()
    // The CI UI tests launch the app with -trainUITest (Debug builds only): the two report labels exist and
    // the store summary is published after every commit. A real launch has neither.
    static let uiTest: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-trainUITest")
        #else
        return false
        #endif
    }()

    override public func load() {
        super.load()
        store.parity = { [weak self] in self?.paritySnapshot() ?? [:] }
        audio.onChange = { [weak self] in self?.publishSummaryFromMain() }
        guard !observing else { return }
        observing = true
        NotificationCenter.default.addObserver(self, selector: #selector(appDidEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    // The idle timer is released when the app backgrounds; the page hears about it (its sentinel gets the
    // 'release' event, and the PT list re-acquires on the next visible).
    @objc private func appDidEnterBackground() {
        guard wake.held else { return }
        wake.release(token: nil, reason: "background")
        notifyListeners("wakeReleased", data: ["token": wake.token, "reason": "background"])
        publishSummaryFromMain()
    }

    // Wake and audio live on main; the store queue asks for a snapshot when it builds status or summary.
    private func paritySnapshot() -> [String: Any] {
        let build: () -> [String: Any] = { ["wake": self.wake.status, "audio": self.audio.status(), "bridge": self.testNotes] }
        if Thread.isMainThread { return build() }
        return DispatchQueue.main.sync(execute: build)
    }

    // MARK: gate 0 (kept until the smoke test replaces the label)

    @objc func ping(_ call: CAPPluginCall) {
        let echo = call.getString("echo") ?? ""
        let store = self.store
        store.queue.async {
            call.resolve(["pong": echo, "rev": store.control.rev])
        }
    }

    // bridge.js's gate 0 report lands in the test summary (bridge.gate0); the separate label is gone.
    @objc func report(_ call: CAPPluginCall) {
        let json = call.getString("json") ?? ""
        lastReport = json
        #if DEBUG
        if TrainStorePlugin.uiTest, let data = json.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.testNotes["gate0"] = obj
                self.publishSummaryFromMain()
            }
        }
        #endif
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
        let bytes = call.getString("bytes")
        let base = call.getInt("base")
        let generation = call.getInt("generation") ?? -1
        let store = self.store
        store.queue.async { [weak self] in
            guard let bytes = bytes, let base = base else {
                call.resolve(["accepted": false, "reason": "invalid", "rev": store.control.rev, "generation": store.control.generation])
                return
            }
            if let refusal = self?.drillRefusal(bytes: bytes, base: base, generation: generation) {
                call.resolve(refusal)
                return
            }
            let r = store.save(base: base, bytes: bytes, generation: generation)
            self?.publishSummary()
            call.resolve(r)
        }
    }

    // On the store queue. The drill's one refusal, recorded in the test notes. It simulates a failed write,
    // so it answers only where the compare-and-swap would have passed: a stale base or another generation
    // gets the store's real answer (and its lineage marker on the page).
    private func drillRefusal(bytes: String, base: Int, generation: Int) -> [String: Any]? {
        guard let n = failSaveOnSessions else { return nil }
        guard base == store.control.rev, generation == store.control.generation else { return nil }
        guard let obj = try? JSONSerialization.jsonObject(with: Data(bytes.utf8)) as? [String: Any], let log = obj["log"] as? [[String: Any]], log.count == n else { return nil }
        failSaveOnSessions = nil
        let rev = store.control.rev
        let generation = store.control.generation
        let lastId: Any = (log.last?["sessionId"] as? String).map { $0 as Any } ?? (NSNull() as Any)
        let record: [String: Any] = ["sessions": n, "rev": rev, "lastSessionId": lastId]
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.testNotes["failedSave"] = record
            self.publishSummaryFromMain()
        }
        return ["accepted": false, "reason": "write", "rev": rev, "generation": generation, "drill": true]
    }

    @objc func importState(_ call: CAPPluginCall) {
        let bytes = call.getString("bytes")
        let base = call.getInt("base")
        let store = self.store
        store.queue.async { [weak self] in
            guard let bytes = bytes else {
                call.resolve(["accepted": false, "reason": "invalid", "rev": store.control.rev, "generation": store.control.generation])
                return
            }
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

    // Test and smoke hooks from the process arguments, Debug builds only: `-trainResetStore` empties the
    // WebView storage and the store for this launch (the UI tests share one simulator install),
    // `-trainFixture <name>` imports a bundled synthetic fixture on an empty store, `-trainSmoke` marks a
    // smoke run. A Release build, and any real launch, gets { fixture: null, smoke: false, reset: false }.
    @objc func launchOptions(_ call: CAPPluginCall) {
        var fixture: Any = NSNull()
        var smoke = false
        var reset = false
        var probe = false
        var probeClient = "pwa"
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-trainFixture"), i + 1 < args.count { fixture = args[i + 1] }
        smoke = args.contains("-trainSmoke")
        reset = args.contains("-trainResetStore")
        probe = TrainStorePlugin.uiTest && args.contains("-trainProbeTombstone")   // the one live call a CI run may make
        if let i = args.firstIndex(of: "-trainProbeClient"), i + 1 < args.count { probeClient = args[i + 1] }   // the X-Train-Client the probe sends
        #endif
        call.resolve(["fixture": fixture, "smoke": smoke, "reset": reset, "uiTest": TrainStorePlugin.uiTest, "probeTombstone": probe, "probeClient": probeClient])
    }

    // bridge.js writes its log ring here when a banner shows or a save is refused.
    @objc func appendLog(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        let store = self.store
        store.queue.async {
            call.resolve(["ok": store.appendLog(text)])
        }
    }

    // MARK: parity

    @objc func wakeAcquire(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { call.resolve(["ok": false]); return }
            let token = self.wake.acquire()
            call.resolve(["ok": true, "token": token, "held": true])
            self.publishSummaryFromMain()
        }
    }

    @objc func wakeRelease(_ call: CAPPluginCall) {
        let token = call.getInt("token")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { call.resolve(["ok": false]); return }
            let released = self.wake.release(token: token, reason: token == nil ? "all" : "sentinel")
            call.resolve(["ok": true, "released": released, "held": self.wake.held, "token": self.wake.token])
            self.publishSummaryFromMain()
        }
    }

    @objc func cue(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? ""
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { call.resolve(["ok": false]); return }
            call.resolve(self.audio.play(name))
            self.publishSummaryFromMain()
        }
    }

    @objc func setSoundOff(_ call: CAPPluginCall) {
        let off = call.getBool("off") ?? false
        let store = self.store
        store.queue.async {
            let ok = store.setSoundOff(off)
            call.resolve(["ok": ok, "soundOff": store.control.soundOff ?? NSNull()])
        }
    }

    // The Import's verification record (fingerprint, synced ids, count, digest, time), kept in the sidecar
    // so "verified" survives a kill and is recomputed on every boot.
    @objc func setVerified(_ call: CAPPluginCall) {
        let json = call.getString("json")
        let store = self.store
        store.queue.async {
            guard let json = json, let data = json.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                call.resolve(["ok": false])
                return
            }
            call.resolve(["ok": store.setVerified(obj)])
        }
    }

    // Debug + -trainUITest only: merges bridge-side state into the summary the UI tests read.
    @objc func testNote(_ call: CAPPluginCall) {
        #if DEBUG
        if TrainStorePlugin.uiTest, let json = call.getString("json"), let data = json.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                for (k, v) in obj { self.testNotes[k] = v }
                self.publishSummaryFromMain()
            }
            call.resolve(["ok": true])
            return
        }
        #endif
        call.resolve(["ok": false])
    }

    private func publishSummaryFromMain() {
        #if DEBUG
        guard TrainStorePlugin.uiTest else { return }
        let store = self.store
        store.queue.async { [weak self] in self?.publishSummary() }
        #endif
    }

    private func publishSummary() {
        #if DEBUG
        guard TrainStorePlugin.uiTest else { return }
        let s = store.summary()
        DispatchQueue.main.async { [weak self] in
            (self?.bridge?.viewController as? TrainBridgeViewController)?.showStoreSummary(s)
        }
        #endif
    }
}

struct TrainControl {
    var generation: Int = 0
    var rev: Int = 0
    var syncArmed: Bool = false
    var recoveredFrom: String? = nil
    var committedAt: String? = nil
    var soundOff: Bool? = nil        // the app's train_sound_off key, mirrored here so it survives a WebView eviction
    var verified: [String: Any]? = nil   // the last Import's verification record (bridge.js computes and checks it)

    var dictionary: [String: Any] {
        var d: [String: Any] = ["generation": generation, "rev": rev, "syncArmed": syncArmed]
        if let r = recoveredFrom { d["recoveredFrom"] = r }
        if let c = committedAt { d["committedAt"] = c }
        if let s = soundOff { d["soundOff"] = s }
        if let v = verified { d["verified"] = v }
        return d
    }

    static func from(_ d: [String: Any]) -> TrainControl {
        var c = TrainControl()
        c.generation = (d["generation"] as? NSNumber)?.intValue ?? 0
        c.rev = (d["rev"] as? NSNumber)?.intValue ?? 0
        c.syncArmed = (d["syncArmed"] as? NSNumber)?.boolValue ?? false
        c.recoveredFrom = d["recoveredFrom"] as? String
        c.committedAt = d["committedAt"] as? String
        c.soundOff = (d["soundOff"] as? NSNumber)?.boolValue
        c.verified = d["verified"] as? [String: Any]
        return c
    }
}

// All file work runs on `queue`; every public method below assumes it is on it.
final class TrainStore {
    let queue = DispatchQueue(label: "com.hyndesyte.train.store", qos: .userInitiated)
    static let keepSnapshots = 5              // the last five save snapshots
    static let keepTransactionSnapshots = 3   // the last three import/erase snapshots, untouched by saves
    static let logLimitBytes = 200 * 1024
    private let fm = FileManager.default
    private let dir: URL
    private let stateURL: URL
    private let controlURL: URL
    private let snapshotsURL: URL
    private let logURL: URL
    private(set) var control = TrainControl()
    var parity: (() -> [String: Any])?      // set by the plugin: wake, audio and test notes, read on main

    init() {
        let manager = FileManager.default
        let base = (try? manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("Train", isDirectory: true)
        dir = d
        stateURL = d.appendingPathComponent("state.json")
        controlURL = d.appendingPathComponent("control.json")
        snapshotsURL = d.appendingPathComponent("snapshots", isDirectory: true)
        let logs = manager.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("Logs", isDirectory: true)
        logURL = logs.appendingPathComponent("train.log")
        try? manager.createDirectory(at: d, withIntermediateDirectories: true)
        try? manager.createDirectory(at: d.appendingPathComponent("snapshots", isDirectory: true), withIntermediateDirectories: true)
        try? manager.createDirectory(at: logs, withIntermediateDirectories: true)
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
    private var soundOffValue: Any { control.soundOff.map { $0 as Any } ?? (NSNull() as Any) }
    private var verifiedValue: Any { control.verified.map { $0 as Any } ?? (NSNull() as Any) }

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

    // Save snapshots and transaction (import, erase) snapshots are pruned separately, so a day of
    // training cannot push out the copy taken before an Import or Erase.
    private func pruneSnapshots() {
        let names = snapshotNames()   // newest first
        func isTransaction(_ n: String) -> Bool { n.hasSuffix("-import.json") || n.hasSuffix("-erase.json") }
        let transactions = names.filter(isTransaction)
        let saves = names.filter { !isTransaction($0) }
        let stale = Array(transactions.dropFirst(TrainStore.keepTransactionSnapshots)) + Array(saves.dropFirst(TrainStore.keepSnapshots))
        for name in stale { try? fm.removeItem(at: snapshotsURL.appendingPathComponent(name)) }
    }

    // Runs a commit (state write and control write together) inside one UIKit background task, so a
    // commit started just before the app is backgrounded still finishes whole. UIApplication is
    // main-actor bound: the bracket is taken and released on main, the writes stay on the store queue.
    private func inBackgroundTask<T>(_ name: String, _ body: () -> T) -> T {
        var task = UIBackgroundTaskIdentifier.invalid
        DispatchQueue.main.sync {
            task = UIApplication.shared.beginBackgroundTask(withName: name) {
                UIApplication.shared.endBackgroundTask(task); task = .invalid
            }
        }
        let result = body()
        DispatchQueue.main.sync { if task != .invalid { UIApplication.shared.endBackgroundTask(task); task = .invalid } }
        return result
    }

    private func writeState(_ data: Data) -> Bool {
        do { try data.write(to: stateURL, options: .atomic); return true } catch { return false }
    }

    // MARK: read (with explicit snapshot recovery)

    // `healed` is set when the sidecar's rev disagreed with the bytes (a kill between a state write and
    // its control write) and was filled from the bytes; bridge.js notes it.
    func read() -> [String: Any] {
        guard let data = stateData() else {
            // a missing file is a completed read at rev 0 (first launch, or after Erase)
            var out: [String: Any] = ["rev": 0, "generation": control.generation, "hasFile": false, "hash": NSNull(), "recoveredFrom": orNull(control.recoveredFrom), "syncArmed": control.syncArmed, "soundOff": soundOffValue, "verified": verifiedValue]
            if control.rev != 0 { var c = control; c.rev = 0; writeControl(c); out["healed"] = true }
            return out
        }
        if let parsed = parse(data) {
            let rev = parsed.rev ?? 0
            var out: [String: Any] = ["generation": control.generation, "hasFile": true, "hash": TrainStore.sha256Hex(data), "bytes": String(decoding: data, as: UTF8.self), "recoveredFrom": orNull(control.recoveredFrom), "syncArmed": control.syncArmed, "soundOff": soundOffValue, "verified": verifiedValue]
            if rev != control.rev { var c = control; c.rev = rev; writeControl(c); out["healed"] = true }   // the bytes are the truth
            out["rev"] = control.rev
            return out
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
        inBackgroundTask("train.store.recover") { () -> Void in
            if let d = recoveredData { _ = writeState(d) }
            _ = writeControl(c)
        }
        if let d = recoveredData {
            return ["rev": control.rev, "generation": control.generation, "hasFile": true, "hash": TrainStore.sha256Hex(d), "bytes": String(decoding: d, as: UTF8.self), "recoveredFrom": orNull(control.recoveredFrom), "syncArmed": control.syncArmed, "soundOff": soundOffValue, "verified": verifiedValue, "recovered": true]
        }
        return ["rev": 0, "generation": control.generation, "hasFile": false, "hash": NSNull(), "recoveredFrom": orNull(control.recoveredFrom), "syncArmed": control.syncArmed, "soundOff": soundOffValue, "verified": verifiedValue, "recovered": true]
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
        return inBackgroundTask("train.store.save") { () -> [String: Any] in
            snapshotCurrent(reason: "save")
            guard writeState(data) else { return refuse("write") }          // 1. the state
            var c = control
            c.rev = newRev
            c.committedAt = nowISO()
            guard writeControl(c) else { return refuse("write") }            // 2. the control rev
            return ["accepted": true, "rev": control.rev, "generation": control.generation, "hash": TrainStore.sha256Hex(data)]
        }
    }

    // MARK: transactions (Import, Erase)
    //
    // Write order, so a kill between the writes is conservative: (1) one control write with syncArmed
    // false and the generation bumped, rev unchanged (read back; abort if it does not stick); (2) the
    // state at rev + 1 (or its removal); (3) the control rev. A kill after (1) or (2) leaves a store whose
    // generation the page does not know: the next read heals the rev from the bytes and the page's
    // generation rule keeps both copies with a banner, instead of silently committing an aborted Import,
    // and an interrupted Erase cannot come back through write-through. A refusal after (1) reports the
    // new generation with the old data; bridge.js adopts it.

    func importState(bytes: String, base: Int?) -> [String: Any] {
        let data = Data(bytes.utf8)
        func refuse(_ reason: String) -> [String: Any] { ["accepted": false, "reason": reason, "rev": control.rev, "generation": control.generation] }
        guard let parsed = parse(data), let newRev = parsed.rev else { return refuse("invalid") }
        if let b = base, b != control.rev { return refuse("stale") }
        if newRev != control.rev + 1 { return refuse("invalid") }
        return inBackgroundTask("train.store.import") { () -> [String: Any] in
            snapshotCurrent(reason: "import")
            var first = control
            first.syncArmed = false
            first.generation += 1
            first.verified = nil              // the previous Import's record never outlives its state
            guard writeControl(first) else { return refuse("disarm") }
            guard writeState(data) else { return refuse("write") }
            var c = control
            c.rev = newRev
            c.committedAt = nowISO()
            guard writeControl(c) else { return refuse("write") }
            return ["accepted": true, "rev": control.rev, "generation": control.generation, "hash": TrainStore.sha256Hex(data)]
        }
    }

    func erase() -> [String: Any] {
        func refuse(_ reason: String) -> [String: Any] { ["accepted": false, "reason": reason, "rev": control.rev, "generation": control.generation] }
        return inBackgroundTask("train.store.erase") { () -> [String: Any] in
            snapshotCurrent(reason: "erase")
            var first = control
            first.syncArmed = false
            first.generation += 1
            first.verified = nil
            guard writeControl(first) else { return refuse("disarm") }
            if fm.fileExists(atPath: stateURL.path) {
                do { try fm.removeItem(at: stateURL) } catch { return refuse("write") }
            }
            var c = control
            c.rev = 0
            c.committedAt = nowISO()
            guard writeControl(c) else { return refuse("write") }
            return ["accepted": true, "rev": 0, "generation": control.generation, "hash": NSNull()]
        }
    }

    func setSyncArmed(_ on: Bool) -> Bool {
        var c = control
        c.syncArmed = on
        return writeControl(c)
    }

    func setSoundOff(_ off: Bool) -> Bool {
        var c = control
        c.soundOff = off
        return writeControl(c)
    }

    func setVerified(_ record: [String: Any]) -> Bool {
        guard JSONSerialization.isValidJSONObject(record) else { return false }
        var c = control
        c.verified = record
        return writeControl(c)
    }

    // MARK: status and summary (parsed, never re-serialized)

    func status() -> [String: Any] {
        var out: [String: Any] = ["rev": control.rev, "generation": control.generation, "committedAt": orNull(control.committedAt), "syncArmed": control.syncArmed,
                                  "recoveredFrom": orNull(control.recoveredFrom), "hasFile": fm.fileExists(atPath: stateURL.path), "snapshots": snapshotNames().count, "soundOff": soundOffValue, "verified": verifiedValue]
        if let p = parity { for (k, v) in p() { out[k] = v } }
        return out
    }

    func summary() -> [String: Any] {
        var out: [String: Any] = ["rev": control.rev, "generation": control.generation, "hasFile": false, "sessions": 0, "syncArmed": control.syncArmed]
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
        out["logTail"] = logTail(3)
        if let p = parity { for (k, v) in p() { out[k] = v } }
        return out
    }

    // MARK: the app log (Library/Logs/train.log, appended, rotated at 200 KB)

    func appendLog(_ text: String) -> Bool {
        if let attrs = try? fm.attributesOfItem(atPath: logURL.path), let size = attrs[.size] as? NSNumber, size.intValue > TrainStore.logLimitBytes {
            let rotated = logURL.deletingLastPathComponent().appendingPathComponent("train.log.1")
            try? fm.removeItem(at: rotated)
            try? fm.moveItem(at: logURL, to: rotated)
        }
        let line = text.hasSuffix("\n") ? text : text + "\n"
        let data = Data(line.utf8)
        if let handle = try? FileHandle(forWritingTo: logURL) {
            defer { try? handle.close() }
            do { try handle.seekToEnd(); try handle.write(contentsOf: data); return true } catch { return false }
        }
        do { try data.write(to: logURL, options: .atomic); return true } catch { return false }
    }

    func logTail(_ n: Int) -> [String] {
        guard let data = try? Data(contentsOf: logURL) else { return [] }
        let text = String(decoding: data, as: UTF8.self)
        return text.split(separator: "\n").suffix(n).map { String($0.prefix(200)) }
    }
}
