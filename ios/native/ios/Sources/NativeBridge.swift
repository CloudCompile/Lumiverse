import AVFoundation
import Speech
import UIKit
import WebKit

/// A small, origin-checked WebKit bridge. This does not grant remote Tauri IPC access.
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    private weak var webview: WKWebView?
    private let speech = NativeSpeech()
    private var mediaDelegate: MediaPermissionDelegate?
    private var loading: NSKeyValueObservation?

    init(webview: WKWebView) {
        self.webview = webview
        super.init()
        let delegate = MediaPermissionDelegate(forwarding: webview.uiDelegate)
        mediaDelegate = delegate
        webview.uiDelegate = delegate
        webview.configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "lumiverseNative")
        loading = webview.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            if view.isLoading { self?.speech.cancel() }
        }
        IOSNotifications.shared.attach(webview: webview)
    }

    static func origin(_ url: URL?) -> String? {
        guard let url = url, let scheme = url.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = url.host?.lowercased(), host != "tauri.localhost" else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        return "\(scheme)://\(host):\(port)"
    }

    static func trusts(_ frame: WKFrameInfo, in webview: WKWebView) -> Bool {
        guard frame.isMainFrame, let current = origin(webview.url) else { return false }
        let security = frame.securityOrigin
        let port = security.port == 0 ? (security.protocol == "https" ? 443 : 80) : security.port
        return current == "\(security.protocol.lowercased())://\(security.host.lowercased()):\(port)"
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void) {
        guard let webview = webview, Self.trusts(message.frameInfo, in: webview),
              let body = message.body as? [String: Any], let action = body["action"] as? String else {
            replyHandler(nil, "Native access is limited to the selected server's main page.")
            return
        }
        let payload = body["payload"] as? [String: Any] ?? [:]
        switch action {
        case "notifications.status": IOSNotifications.shared.status { replyHandler($0, nil) }
        case "notifications.register": IOSNotifications.shared.register { result, error in replyHandler(result, error) }
        case "speech.start":
            guard let id = payload["id"] as? String, UUID(uuidString: id) != nil,
                  let language = payload["language"] as? String, language.count <= 80 else {
                replyHandler(nil, "Invalid speech recognition request."); return
            }
            speech.start(id: id, language: language, webview: webview) { error in
                replyHandler(error == nil ? ["started": true] : nil, error)
            }
        case "speech.stop": speech.stop(id: payload["id"] as? String); replyHandler(["stopping": true], nil)
        case "speech.cancel": speech.cancel(id: payload["id"] as? String); replyHandler(["cancelled": true], nil)
        case "permissions.status":
            replyHandler(["microphone": Self.authorization(AVCaptureDevice.authorizationStatus(for: .audio)),
                "camera": Self.authorization(AVCaptureDevice.authorizationStatus(for: .video)),
                "speech": SFSpeechRecognizer.authorizationStatus().rawValue], nil)
        default: replyHandler(nil, "Unknown native action.")
        }
    }

    private static func authorization(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .notDetermined: return "default"
        default: return "denied"
        }
    }
}

/// Keep Tauri's other UI delegate methods, but let WebKit ask per-origin for capture.
private final class MediaPermissionDelegate: NSObject, WKUIDelegate {
    private let original: WKUIDelegate?
    init(forwarding original: WKUIDelegate?) { self.original = original; super.init() }
    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || (original?.responds(to: selector) ?? false)
    }
    override func forwardingTarget(for selector: Selector!) -> Any? {
        original?.responds(to: selector) == true ? original : super.forwardingTarget(for: selector)
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(NativeBridge.trusts(frame, in: webView) ? .prompt : .deny)
    }
}
