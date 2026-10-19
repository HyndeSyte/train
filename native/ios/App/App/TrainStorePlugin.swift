import Foundation
import Capacitor

// The one in-app plugin. Gate 0 exposes two methods: ping (round trip with data) and report (the
// web side hands its gate result to native). The durable store's methods come after gate 0 passes.
@objc(TrainStorePlugin)
public class TrainStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TrainStorePlugin"
    public let jsName = "TrainStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ping", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "report", returnType: CAPPluginReturnPromise)
    ]
    private(set) var lastReport: String?

    @objc func ping(_ call: CAPPluginCall) {
        let echo = call.getString("echo") ?? ""
        call.resolve(["pong": echo, "rev": 0])
    }

    @objc func report(_ call: CAPPluginCall) {
        let json = call.getString("json") ?? ""
        lastReport = json
        DispatchQueue.main.async { [weak self] in
            (self?.bridge?.viewController as? TrainBridgeViewController)?.showGate0(json)
        }
        call.resolve(["stored": true, "length": json.count])
    }
}
