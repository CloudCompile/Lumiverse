import Tauri
import UIKit
import WebKit

/// UIKit controls and a narrowly scoped WebKit permission bridge.
class LumiversePlugin: Plugin, UIGestureRecognizerDelegate {
    private var nativeBridge: NativeBridge?
    private weak var webview: WKWebView?
    private var observation: NSKeyValueObservation?
    private var menuGesture: UILongPressGestureRecognizer?
    private var accessibilityButton: UIButton?
    private var connectionURL = URL(string: "tauri://localhost/index.html")!
    #if LUMIVERSE_DEBUG || LUMIVERSE_EXPERIMENTAL_HIGH_REFRESH
    private let framePacingProbe = FramePacingProbe()
    private var refreshStatus: [String: Any] = ["status": "public-promotion-opt-in-only"]
    #endif
    #if LUMIVERSE_DEBUG
    private var probeLoadObservation: NSKeyValueObservation?
    private var automaticProbeStarted = false
    #endif

    @objc public override func load(webview: WKWebView) {
        self.webview = webview
        nativeBridge = NativeBridge(webview: webview)
        #if LUMIVERSE_EXPERIMENTAL_HIGH_REFRESH
        refreshStatus = HighRefreshExperiment.apply(to: webview.configuration.preferences)
        NSLog("[Lumiverse] Experimental high refresh: %@", String(describing: refreshStatus))
        #endif
        #if LUMIVERSE_DEBUG
        if ProcessInfo.processInfo.arguments.contains("--lumiverse-frame-pacing-probe") {
            probeLoadObservation = webview.observe(\.isLoading, options: [.initial, .new]) { [weak self] webview, _ in
                guard !webview.isLoading, webview.url?.lastPathComponent == "frame-pacing.html" else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self, weak webview] in
                    guard let self = self, let webview = webview, !self.automaticProbeStarted,
                          UIApplication.shared.applicationState == .active else { return }
                    self.automaticProbeStarted = true
                    self.framePacingProbe.run(in: webview, override: self.refreshStatus, showResult: false)
                }
            }
        }
        #endif
        let gesture = UILongPressGestureRecognizer(target: self, action: #selector(openControls(_:)))
        gesture.numberOfTouchesRequired = 2
        gesture.minimumPressDuration = 0.65
        gesture.allowableMovement = 18
        gesture.delegate = self
        webview.addGestureRecognizer(gesture)
        menuGesture = gesture

        // Screen readers and Switch Control need a discoverable alternative to
        // a multitouch gesture. It is absent from the ordinary browsing UI.
        let button = UIButton(type: .system)
        var configuration = UIButton.Configuration.filled()
        configuration.title = "App controls"
        configuration.baseBackgroundColor = UIColor(red: 0.20, green: 0.15, blue: 0.30, alpha: 0.96)
        configuration.baseForegroundColor = .white
        configuration.cornerStyle = .capsule
        button.configuration = configuration
        button.accessibilityLabel = "Lumiverse app controls"
        button.accessibilityIdentifier = "lumiverse.accessibility.actions"
        button.addTarget(self, action: #selector(openAccessibleControls), for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
        webview.addSubview(button)
        NSLayoutConstraint.activate([
            button.leadingAnchor.constraint(equalTo: webview.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            button.bottomAnchor.constraint(equalTo: webview.safeAreaLayoutGuide.bottomAnchor, constant: -12)
        ])
        accessibilityButton = button
        NotificationCenter.default.addObserver(self, selector: #selector(updateAccessibility),
            name: UIAccessibility.voiceOverStatusDidChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(updateAccessibility),
            name: UIAccessibility.switchControlStatusDidChangeNotification, object: nil)
        updateAccessibility()
        observation = webview.observe(\.url, options: [.initial, .new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.rememberConnectionPage() }
        }
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func updateAccessibility() {
        let needsButton = UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning
        accessibilityButton?.isHidden = !needsButton
        menuGesture?.isEnabled = !needsButton
    }

    private func rememberConnectionPage() {
        guard let url = webview?.url else { return }
        if (url.scheme == "tauri" || url.host == "tauri.localhost") && ["/", "/index.html"].contains(url.path) {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            components.query = nil
            components.fragment = nil
            connectionURL = components.url!
        }
        if let button = accessibilityButton { webview?.bringSubviewToFront(button) }
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        // WebKit's own recognizers should keep normal scrolling and zooming.
        gestureRecognizer === menuGesture || otherGestureRecognizer === menuGesture
    }

    @objc private func openControls(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, let webview = webview else { return }
        showControls(at: gesture.location(in: webview))
    }

    @objc private func openAccessibleControls() {
        guard let button = accessibilityButton else { return }
        showControls(at: CGPoint(x: button.frame.midX, y: button.frame.midY))
    }

    private func showControls(at point: CGPoint) {
        guard let webview = webview, let controller = webview.window?.rootViewController,
              controller.presentedViewController == nil else { return }
        webview.endEditing(true)
        UISelectionFeedbackGenerator().selectionChanged()
        let sheet = UIAlertController(title: "Lumiverse", message: nil, preferredStyle: .actionSheet)
        let remote = ["https", "http"].contains(webview.url?.scheme ?? "") && webview.url?.host != "tauri.localhost"
        let share = UIAlertAction(title: "Share this page", style: .default) { [weak self, weak sheet] _ in
            sheet?.dismiss(animated: true) { [weak self] in self?.share(at: point) }
        }
        share.isEnabled = remote
        sheet.addAction(share)
        let safari = UIAlertAction(title: "Open in Safari", style: .default) { [weak self] _ in
            guard let url = self?.webview?.url else { return }
            UIApplication.shared.open(url)
        }
        safari.isEnabled = remote
        sheet.addAction(safari)
        sheet.addAction(UIAlertAction(title: "Reload", style: .default) { [weak self] _ in self?.webview?.reload() })
        sheet.addAction(UIAlertAction(title: "App permissions", style: .default) { [weak self, weak sheet] _ in
            sheet?.dismiss(animated: true) { [weak self] in self?.showPermissions() }
        })
        #if LUMIVERSE_DEBUG || LUMIVERSE_EXPERIMENTAL_HIGH_REFRESH
        let measure = UIAlertAction(title: "Check animation frame rate", style: .default) { [weak self, weak sheet] _ in
            sheet?.dismiss(animated: true) { [weak self] in
                guard let self = self, let webview = self.webview else { return }
                self.framePacingProbe.run(in: webview, override: self.refreshStatus, showResult: true)
            }
        }
        measure.isEnabled = !framePacingProbe.isRunning
        sheet.addAction(measure)
        #endif
        sheet.addAction(UIAlertAction(title: "Change server", style: .default) { [weak self] _ in
            guard let self = self else { return }
            var components = URLComponents(url: self.connectionURL, resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "changeServer", value: "1")]
            self.webview?.load(URLRequest(url: components.url!))
        })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        anchor(sheet.popoverPresentationController, at: point, in: webview)
        controller.present(sheet, animated: true)
    }

    private func anchor(_ popover: UIPopoverPresentationController?, at point: CGPoint, in webview: WKWebView) {
        popover?.sourceView = webview
        popover?.sourceRect = CGRect(x: point.x, y: point.y, width: 1, height: 1)
    }

    private func showPermissions() {
        guard let controller = webview?.window?.rootViewController else { return }
        let alert = UIAlertController(title: "App permissions",
            message: "Lumiverse asks for camera, microphone, speech recognition, and notification access when you use those features. You can change previously granted or denied permissions in iOS Settings.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Open Settings", style: .default) { _ in
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        controller.present(alert, animated: true)
    }

    private func share(at point: CGPoint) {
        guard let webview = webview, let url = webview.url,
              let controller = webview.window?.rootViewController,
              controller.presentedViewController == nil else { return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        anchor(sheet.popoverPresentationController, at: point, in: webview)
        controller.present(sheet, animated: true)
    }
}

@_cdecl("init_plugin_lumiverse_ios")
func initPlugin() -> Plugin { LumiversePlugin() }
