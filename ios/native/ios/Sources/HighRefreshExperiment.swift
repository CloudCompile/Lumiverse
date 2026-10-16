import ObjectiveC
import WebKit

/// Private WebKit API. SwiftPM excludes this file from ordinary builds.
enum HighRefreshExperiment {
    static func apply(to preferences: WKPreferences) -> [String: Any] {
        #if LUMIVERSE_DEBUG
        if ProcessInfo.processInfo.arguments.contains("--lumiverse-disable-high-refresh") {
            return ["status": "disabled-for-comparison"]
        }
        #endif
        let listSelector = NSSelectorFromString("_features")
        let setSelector = NSSelectorFromString("_setEnabled:forFeature:")
        let getSelector = NSSelectorFromString("_isEnabledForFeature:")
        let keySelector = NSSelectorFromString("key")
        guard let listMethod = class_getClassMethod(WKPreferences.self, listSelector),
              let setMethod = class_getInstanceMethod(WKPreferences.self, setSelector),
              let getMethod = class_getInstanceMethod(WKPreferences.self, getSelector) else {
            return ["status": "unavailable-selectors"]
        }
        typealias List = @convention(c) (AnyClass, Selector) -> Unmanaged<NSArray>
        typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        typealias IsEnabled = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
        let list = unsafeBitCast(method_getImplementation(listMethod), to: List.self)
        let setEnabled = unsafeBitCast(method_getImplementation(setMethod), to: SetEnabled.self)
        let isEnabled = unsafeBitCast(method_getImplementation(getMethod), to: IsEnabled.self)
        // Object selectors can use perform; the BOOL setter must use a typed IMP,
        // since passing NSNumber(false) would pass an object pointer as BOOL.
        for case let feature as NSObject in list(WKPreferences.self, listSelector).takeUnretainedValue() {
            guard feature.responds(to: keySelector),
                  let key = feature.perform(keySelector)?.takeUnretainedValue() as? String,
                  key == "PreferPageRenderingUpdatesNear60FPSEnabled" else { continue }
            let before = isEnabled(preferences, getSelector, feature)
            setEnabled(preferences, setSelector, false, feature)
            let after = isEnabled(preferences, getSelector, feature)
            return ["status": after ? "override-not-applied" : "override-applied",
                    "preferenceBefore": before, "preferenceAfter": after]
        }
        return ["status": "unavailable-feature"]
    }
}
