import UIKit
import Capacitor

// The scene's root. Registers the one in-app plugin (TrainStore) before the web view loads, so its
// JS proxies are injected at document start along with the Capacitor plugins from packageClassList.
final class TrainBridgeViewController: CAPBridgeViewController {
    // One tiny report surface for the CI UI tests, which cannot reach into the DOM. It exists only in a
    // Debug build launched with -trainUITest (TrainStorePlugin.uiTest); a real launch has no label.
    //   store-summary  the durable store's committed state, parsed from the file after every commit
    //                  ({ rev, generation, sessions, lastSessionId, ... }), plus wake, audio and the
    //                  bridge's test notes (gate 0's report among them).
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
        let store = UILabel()
        store.accessibilityIdentifier = "store-summary"
        store.isAccessibilityElement = true
        store.font = .systemFont(ofSize: 5)
        store.textColor = UIColor.secondaryLabel
        store.numberOfLines = 1
        store.lineBreakMode = .byTruncatingTail
        store.text = "store: pending"
        store.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(store)
        NSLayoutConstraint.activate([
            store.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 4),
            store.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -4),
            store.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            store.heightAnchor.constraint(equalToConstant: 12)
        ])
        storeLabel = store
    }
    #endif

    func showStoreSummary(_ summary: [String: Any]) {
        guard let label = storeLabel,
              let data = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return }
        label.text = json
        label.accessibilityLabel = json
        label.accessibilityValue = json
    }
}
