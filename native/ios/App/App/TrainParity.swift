import Foundation
import UIKit
import AVFoundation

// Parity (plan v4, R2 build order 3): the idle timer behind the web app's wake lock, and the six cues
// played natively. Both are driven from TrainStorePlugin and live on the main thread.

// The idle timer with a generation token. acquire() hands out a new token and disables the idle timer;
// release(token:) applies only when the token is the current one (a stale release from an older
// sentinel never clears a newer lock); release(token: nil) releases unconditionally (background,
// hydration). Every release bumps the token.
final class TrainWake {
    private(set) var token = 0
    private(set) var held = false
    private(set) var acquires = 0
    private(set) var releases = 0
    private(set) var lastRelease: String?

    func acquire() -> Int {
        token += 1
        held = true
        acquires += 1
        UIApplication.shared.isIdleTimerDisabled = true
        return token
    }

    @discardableResult
    func release(token t: Int?, reason: String) -> Bool {
        if let t = t, t != token { return false }
        guard held else { return false }
        held = false
        releases += 1
        lastRelease = reason
        token += 1
        UIApplication.shared.isIdleTimerDisabled = false
        return true
    }

    var status: [String: Any] {
        ["held": held, "token": token, "acquires": acquires, "releases": releases,
         "idleTimerDisabled": UIApplication.shared.isIdleTimerDisabled, "lastRelease": lastRelease ?? NSNull()]
    }
}

// Native cues. The audio session is playback with .mixWithOthers so his music keeps playing; while a
// cue sounds the category also carries .duckOthers; when the last cue finishes the category goes back
// to mix-only and the session deactivates with .notifyOthersOnDeactivation, so the music comes back at
// full volume. A fallback timer restores the session if the player never reports finishing.
final class TrainAudio: NSObject, AVAudioPlayerDelegate {
    private let session = AVAudioSession.sharedInstance()
    private var players: [String: AVAudioPlayer] = [:]
    private var playing = 0
    private var restoreTimer: Timer?
    private(set) var plays = 0
    private(set) var failures = 0
    private(set) var deactivations = 0
    private(set) var lastCue: String?
    private(set) var lastError: String?
    private(set) var active = false
    var onChange: (() -> Void)?        // the plugin republishes the test summary when the session is restored

    static let cueNames: Set<String> = ["cueGo", "cueRelease", "cueStarted", "cueLogged", "cueSessionDone", "cueNoted"]

    func play(_ name: String) -> [String: Any] {
        guard TrainAudio.cueNames.contains(name), let url = Bundle.main.url(forResource: name, withExtension: "wav") else {
            failures += 1
            lastError = "no cue \(name)"
            return status(ok: false)
        }
        do {
            // the category and its options first: a player created or prepared before this would activate
            // the session under the launch category (solo ambient) and stop his music instead of ducking it
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers, .duckOthers])
            try session.setActive(true)
            active = true
            let player: AVAudioPlayer
            if let p = players[name] { player = p } else { player = try AVAudioPlayer(contentsOf: url); players[name] = player }
            player.delegate = self
            player.currentTime = 0
            guard player.play() else {       // play() prepares the player itself, under the category set above
                players[name] = nil           // never reuse a player that failed
                throw NSError(domain: "train.audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "play() returned false"])
            }
            playing += 1                      // counted only once the cue is actually playing
            plays += 1
            lastCue = name
            scheduleRestore(after: player.duration + 0.5)
            return status(ok: true)
        } catch {
            failures += 1
            lastError = error.localizedDescription
            players[name] = nil
            if playing == 0 { restore() }     // nothing else is playing: put the session back
            return status(ok: false)
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        finished()
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        lastError = error?.localizedDescription ?? "decode error"
        finished()
    }

    private func finished() {
        playing = max(0, playing - 1)
        if playing == 0 { restore() }
    }

    private func scheduleRestore(after seconds: TimeInterval) {
        restoreTimer?.invalidate()
        restoreTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            guard let self = self, self.active else { return }
            self.playing = 0
            self.restore()
        }
    }

    private func restore() {
        restoreTimer?.invalidate()
        restoreTimer = nil
        do {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(false, options: .notifyOthersOnDeactivation)
            deactivations += 1
        } catch {
            lastError = error.localizedDescription
        }
        active = false
        onChange?()
    }

    // the two options the shell sets, by name; the raw mask carries anything else
    private func optionNames(_ o: AVAudioSession.CategoryOptions) -> [String] {
        var names: [String] = []
        if o.contains(.mixWithOthers) { names.append("mixWithOthers") }
        if o.contains(.duckOthers) { names.append("duckOthers") }
        return names
    }

    func status(ok: Bool? = nil) -> [String: Any] {
        var d: [String: Any] = ["category": session.category.rawValue, "options": optionNames(session.categoryOptions), "optionsRaw": session.categoryOptions.rawValue, "active": active,
                                "playing": playing, "plays": plays, "failures": failures, "deactivations": deactivations,
                                "lastCue": lastCue ?? NSNull(), "lastError": lastError ?? NSNull()]
        if let ok = ok { d["ok"] = ok }
        return d
    }
}
