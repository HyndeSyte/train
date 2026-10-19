import UIKit
import Capacitor

// The scene's root. Registers the one in-app plugin (TrainStore) before the web view loads, so its
// JS proxies are injected at document start along with the Capacitor plugins from packageClassList.
final class TrainBridgeViewController: CAPBridgeViewController {
    // Gate 0 report surface: bridge.js hands its result to TrainStore.report, which shows it here so an
    // XCUITest can read it without reaching into the DOM. Removed when the durable store lands.
    private let gateLabel = UILabel()

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TrainStorePlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        gateLabel.accessibilityIdentifier = "gate0-result"
        gateLabel.isAccessibilityElement = true
        gateLabel.font = .systemFont(ofSize: 5)
        gateLabel.textColor = UIColor.secondaryLabel
        gateLabel.numberOfLines = 1
        gateLabel.lineBreakMode = .byTruncatingTail
        gateLabel.text = "gate0: pending"
        gateLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(gateLabel)
        NSLayoutConstraint.activate([
            gateLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 4),
            gateLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -4),
            gateLabel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            gateLabel.heightAnchor.constraint(equalToConstant: 12)
        ])
    }

    func showGate0(_ json: String) {
        gateLabel.text = json
        gateLabel.accessibilityLabel = json
        gateLabel.accessibilityValue = json
    }
}
