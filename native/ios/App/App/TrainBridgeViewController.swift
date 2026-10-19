import UIKit
import Capacitor

// The scene's root. Registers the one in-app plugin (TrainStore) before the web view loads, so its
// JS proxies are injected at document start along with the Capacitor plugins from packageClassList.
final class TrainBridgeViewController: CAPBridgeViewController {
    // Two tiny report surfaces for the CI UI tests, which cannot reach into the DOM. They exist only in a
    // Debug build launched with -trainUITest (TrainStorePlugin.uiTest); a real launch has no labels.
    //   gate0-result   bridge.js's gate 0 JSON (TrainStore.report)
    //   store-summary  the durable store's committed state, parsed from the file after every commit
    //                  ({ rev, generation, sessions, lastSessionId, ... }); the smoke test reads it
    //                  after a session and again after a relaunch.
    private var gateLabel: UILabel?
    private var storeLabel: UILabel?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TrainStorePlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        #if DEBUG
        if TrainStorePlugin.uiTest { installTestLabels() }
        #endif
    }

    #if DEBUG
    private func installTestLabels() {
        let gate = UILabel()
        let store = UILabel()
        for (label, id, initial) in [(gate, "gate0-result", "gate0: pending"), (store, "store-summary", "store: pending")] {
            label.accessibilityIdentifier = id
            label.isAccessibilityElement = true
            label.font = .systemFont(ofSize: 5)
            label.textColor = UIColor.secondaryLabel
            label.numberOfLines = 1
            label.lineBreakMode = .byTruncatingTail
            label.text = initial
            label.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(label)
        }
        NSLayoutConstraint.activate([
            gate.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 4),
            gate.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -4),
            gate.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            gate.heightAnchor.constraint(equalToConstant: 12),
            store.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 4),
            store.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -4),
            store.bottomAnchor.constraint(equalTo: gate.topAnchor),
            store.heightAnchor.constraint(equalToConstant: 12)
        ])
        gateLabel = gate
        storeLabel = store
    }
    #endif

    func showGate0(_ json: String) {
        guard let label = gateLabel else { return }
        label.text = json
        label.accessibilityLabel = json
        label.accessibilityValue = json
    }

    func showStoreSummary(_ summary: [String: Any]) {
        guard let label = storeLabel,
              let data = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return }
        label.text = json
        label.accessibilityLabel = json
        label.accessibilityValue = json
    }
}
