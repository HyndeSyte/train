import UIKit
import Capacitor

// The scene's root. Registers the one in-app plugin (TrainStore) before the web view loads, so its
// JS proxies are injected at document start along with the Capacitor plugins from packageClassList.
final class TrainBridgeViewController: CAPBridgeViewController {
    // Two tiny report surfaces for the CI UI tests, which cannot reach into the DOM:
    //   gate0-result   bridge.js's gate 0 JSON (TrainStore.report)
    //   store-summary  the durable store's committed state, parsed from the file after every commit
    //                  ({ rev, generation, sessions, lastSessionId, ... }); the smoke test reads it
    //                  after a session and again after a relaunch.
    private let gateLabel = UILabel()
    private let storeLabel = UILabel()

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TrainStorePlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        for (label, id, initial) in [(gateLabel, "gate0-result", "gate0: pending"), (storeLabel, "store-summary", "store: pending")] {
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
            gateLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 4),
            gateLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -4),
            gateLabel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            gateLabel.heightAnchor.constraint(equalToConstant: 12),
            storeLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 4),
            storeLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -4),
            storeLabel.bottomAnchor.constraint(equalTo: gateLabel.topAnchor),
            storeLabel.heightAnchor.constraint(equalToConstant: 12)
        ])
    }

    func showGate0(_ json: String) {
        gateLabel.text = json
        gateLabel.accessibilityLabel = json
        gateLabel.accessibilityValue = json
    }

    func showStoreSummary(_ summary: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return }
        storeLabel.text = json
        storeLabel.accessibilityLabel = json
        storeLabel.accessibilityValue = json
    }
}
