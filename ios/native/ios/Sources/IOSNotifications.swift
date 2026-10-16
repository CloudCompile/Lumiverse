import ObjectiveC
import UIKit
import UserNotifications
import WebKit

final class IOSNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = IOSNotifications()
    private weak var webview: WKWebView?
    private var token: String?
    private var pending: [((([String: Any])?, String?) -> Void)] = []
    private var timeout: DispatchWorkItem?
    private var urlObservation: NSKeyValueObservation?
    private var pendingTap: [AnyHashable: Any]?
    private var callbackError: String?
    private var installedCallbacks = false

    private var enabled: Bool { Bundle.main.object(forInfoDictionaryKey: "LumiversePushEnabled") as? Bool == true }
    private var bundleId: String { Bundle.main.bundleIdentifier ?? "chat.lumiverse.ios" }
    private var deviceId: String {
        let key = "lumiverse.push.deviceID"
        if let saved = UserDefaults.standard.string(forKey: key) { return saved }
        let value = UUID().uuidString
        UserDefaults.standard.set(value, forKey: key)
        return value
    }
    private var environment: String {
        // Development/ad-hoc exports include the actual signing environment here.
        // App Store installations have no embedded provisioning profile and use production.
        if let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
           let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .isoLatin1),
           let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>"),
           let plist = String(text[start.lowerBound..<end.upperBound]).data(using: .utf8),
           let profile = (try? PropertyListSerialization.propertyList(from: plist, format: nil)) as? [String: Any],
           let entitlements = profile["Entitlements"] as? [String: Any],
           let environment = entitlements["aps-environment"] as? String { return environment }
        #if targetEnvironment(simulator)
        return "development"
        #else
        return "production"
        #endif
    }

    func attach(webview: WKWebView) {
        self.webview = webview
        UNUserNotificationCenter.current().delegate = self
        if enabled { installCallbacks() }
        urlObservation = webview.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            if !view.isLoading { self?.openPendingTap() }
        }
        // Re-request the current token each launch, without presenting an authorization prompt.
        if enabled { status { [weak self] status in
            if status["permission"] as? String == "granted", self?.callbackError == nil {
                UIApplication.shared.registerForRemoteNotifications()
            }
        } }
    }

    func status(_ completion: @escaping ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let permission: String
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral: permission = "granted"
                case .denied: permission = "denied"
                default: permission = "default"
                }
                completion(["available": self.enabled && self.callbackError == nil, "permission": permission,
                    "deviceId": self.deviceId, "bundleId": self.bundleId, "environment": self.environment,
                    "reason": !self.enabled ? "This IPA was built without Push Notifications. Build and sign with the push capability enabled."
                        : (self.callbackError as Any? ?? NSNull())])
            }
        }
    }

    func register(_ completion: @escaping ([String: Any]?, String?) -> Void) {
        guard enabled else { completion(nil, "This IPA is not configured for APNs. Rebuild with --push-notifications and an APNs-capable signing team."); return }
        guard callbackError == nil else { completion(nil, callbackError); return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard error == nil, granted else { completion(nil, error?.localizedDescription ?? "Notifications are disabled. Enable them in iOS Settings → Lumiverse."); return }
                self.pending.append(completion)
                if self.pending.count == 1 {
                    let timeout = DispatchWorkItem { [weak self] in self?.finish(error: "APNs registration timed out. Check the network and this app's signing entitlement.") }
                    self.timeout = timeout
                    DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeout)
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    private func finish(error: String? = nil) {
        timeout?.cancel(); timeout = nil
        let callbacks = pending; pending.removeAll()
        let result: [String: Any]? = token.map { ["deviceId": deviceId, "deviceToken": $0, "bundleId": bundleId, "environment": environment] }
        for callback in callbacks { callback(error == nil ? result : nil, error) }
    }

    private func received(token: Data) {
        let value = token.map { String(format: "%02x", $0) }.joined()
        let changed = self.token != value
        self.token = value
        finish()
        if changed { webview?.callAsyncJavaScript("window.dispatchEvent(new Event('lumiverse:ios-push-token'))", arguments: [:], in: nil, in: .page, completionHandler: nil) }
    }

    private func installCallbacks() {
        guard !installedCallbacks else { return }
        installedCallbacks = true
        guard let delegate = UIApplication.shared.delegate, let cls = object_getClass(delegate) else {
            callbackError = "The app delegate is unavailable for APNs registration."; return
        }
        // Add the two optional public callbacks without replacing Tauri's app delegate
        // or swizzling existing lifecycle methods. Fail closed if another owner exists.
        let success = NSSelectorFromString("application:didRegisterForRemoteNotificationsWithDeviceToken:")
        let failure = NSSelectorFromString("application:didFailToRegisterForRemoteNotificationsWithError:")
        guard !delegate.responds(to: success), !delegate.responds(to: failure) else {
            callbackError = "Another plugin already owns APNs registration callbacks."; return
        }
        let onSuccess: @convention(block) (AnyObject, UIApplication, NSData) -> Void = { _, _, data in
            DispatchQueue.main.async { IOSNotifications.shared.received(token: data as Data) }
        }
        let onFailure: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { _, _, error in
            DispatchQueue.main.async { IOSNotifications.shared.finish(error: error.localizedDescription) }
        }
        let addedSuccess = class_addMethod(cls, success, imp_implementationWithBlock(onSuccess), "v@:@@")
        let addedFailure = class_addMethod(cls, failure, imp_implementationWithBlock(onFailure), "v@:@@")
        if !addedSuccess || !addedFailure { callbackError = "Could not install APNs registration callbacks." }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void) {
        let data = response.notification.request.content.userInfo
        DispatchQueue.main.async { [weak self] in self?.pendingTap = data; self?.openPendingTap() }
        completionHandler()
    }

    private func openPendingTap() {
        guard let data = pendingTap, let view = webview, !view.isLoading,
              let current = NativeBridge.origin(view.url) else { return }
        pendingTap = nil
        guard let server = data["serverOrigin"] as? String, NativeBridge.origin(URL(string: server)) == current,
              let chatId = data["chatId"] as? String, chatId.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
              let url = URL(string: "/chat/\(chatId)", relativeTo: view.url)?.absoluteURL else { return }
        view.load(URLRequest(url: url))
    }
}
