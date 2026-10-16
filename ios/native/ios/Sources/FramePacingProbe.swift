import UIKit
import WebKit

/// Measures WebKit requestAnimationFrame callbacks, not native display-link ticks.
/// Runs only on an explicit native-menu action or a debug launch argument.
final class FramePacingProbe {
    private(set) var isRunning = false
    #if LUMIVERSE_DEBUG
    private var nativeDemand: NativeFrameDemand?
    #endif

    func run(in webview: WKWebView, override: [String: Any], showResult: Bool) {
        guard !isRunning, UIApplication.shared.applicationState == .active else { return }
        isRunning = true
        let startedAt = ISO8601DateFormatter().string(from: Date())
        let runID = ProcessInfo.processInfo.arguments.first(where: {
            $0.hasPrefix("--lumiverse-frame-pacing-id=")
        }).map { String($0.dropFirst("--lumiverse-frame-pacing-id=".count)) }
        #if LUMIVERSE_DEBUG
        // A diagnostic-only comparison with the native display-link technique.
        // It is never kept alive during ordinary use, and its ticks are reported
        // separately from WebKit callbacks.
        if ProcessInfo.processInfo.arguments.contains("--lumiverse-frame-pacing-native-demand") {
            nativeDemand = NativeFrameDemand(screen: webview.window?.screen ?? UIScreen.main)
        }
        #endif
        let script = """
        return await new Promise((resolve, reject) => {
          if (document.visibilityState !== 'visible') { reject(new Error('Page is hidden')); return; }
          const marker = document.createElement('div');
          marker.textContent = 'Measuring animation…';
          Object.assign(marker.style, {position:'fixed',left:'16px',top:'80px',zIndex:'2147483647',
            padding:'12px',borderRadius:'12px',background:'#7759b4',color:'white',pointerEvents:'none'});
          document.documentElement.appendChild(marker);
          let frame = 0, start, last;
          const intervals = [];
          const cleanup = () => {
            cancelAnimationFrame(frame); clearTimeout(timeout);
            document.removeEventListener('visibilitychange', visibility); marker.remove();
          };
          const visibility = () => {
            if (document.visibilityState !== 'visible') { cleanup(); reject(new Error('Page became hidden')); }
          };
          const timeout = setTimeout(() => { cleanup(); reject(new Error('Animation check timed out')); }, 12000);
          document.addEventListener('visibilitychange', visibility);
          const tick = time => {
            start ??= time;
            // Keep the page visibly changing; discard the first second of warmup.
            marker.style.transform = `translate3d(${(Math.sin(time / 300) + 1) * 48}px,0,0)`;
            if (time - start >= 1000) {
              if (last !== undefined && time > last) intervals.push(time - last);
              last = time;
            }
            if (time - start < 6000) frame = requestAnimationFrame(tick);
            else { cleanup(); resolve({intervalsMs: intervals, userAgent: navigator.userAgent}); }
          };
          frame = requestAnimationFrame(tick);
        });
        """
        // An isolated world avoids depending on a server's JS globals or exposing
        // a native message handler to remote content. No URL or cookies are saved.
        webview.callAsyncJavaScript(script, arguments: [:], in: nil, in: .defaultClient) { [weak self, weak webview] result in
            guard let self = self else { return }
            self.isRunning = false
            var report: [String: Any] = [
                "startedAt": startedAt, "override": override,
                "maximumDisplayHz": webview?.window?.screen.maximumFramesPerSecond ?? UIScreen.main.maximumFramesPerSecond,
                "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
                "thermalState": ProcessInfo.processInfo.thermalState.rawValue,
                "osVersion": UIDevice.current.systemVersion,
                "measurement": "requestAnimationFrame with a moving DOM element; 1s warmup, 5s sample",
            ]
            report["runID"] = runID
            #if LUMIVERSE_DEBUG
            report["nativeDisplayLink"] = self.nativeDemand?.stop()
            self.nativeDemand = nil
            #endif
            var message: String
            switch result {
            case .success(let value):
                if let values = value as? [String: Any], let intervals = values["intervalsMs"] as? [Double],
                   !intervals.isEmpty {
                    let sorted = intervals.sorted()
                    let duration = intervals.reduce(0, +)
                    let fps = Double(intervals.count) * 1000 / duration
                    let p50 = sorted[(sorted.count - 1) / 2]
                    let p95 = sorted[Int(Double(sorted.count - 1) * 0.95)]
                    report["javascript"] = ["fps": fps, "frameCount": intervals.count,
                        "durationMs": duration, "p50IntervalMs": p50, "p95IntervalMs": p95,
                        "intervalsMs": intervals]
                    report["userAgent"] = values["userAgent"]
                    report["passed"] = true
                    message = String(format: "JavaScript: %.1f fps\nMedian frame: %.2f ms\n95th percentile: %.2f ms\nDisplay maximum: %d Hz",
                        fps, p50, p95, report["maximumDisplayHz"] as? Int ?? 0)
                } else {
                    report["passed"] = false
                    message = "The page returned no animation samples."
                    report["error"] = message
                }
            case .failure(let error):
                report["passed"] = false
                message = "Could not measure animation timing: \(error.localizedDescription)"
                report["error"] = message
            }
            do {
                let cache = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask,
                    appropriateFor: nil, create: true)
                let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: cache.appendingPathComponent("lumiverse-frame-pacing.json"), options: .atomic)
            } catch { NSLog("[Lumiverse] Could not save frame timing: %@", error.localizedDescription) }
            NSLog("[Lumiverse] Animation check: %@", message)
            guard showResult, let controller = webview?.window?.rootViewController,
                  controller.presentedViewController == nil else { return }
            let alert = UIAlertController(title: "Animation frame rate", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            controller.present(alert, animated: true)
        }
    }
}

#if LUMIVERSE_DEBUG
private final class NativeFrameDemand {
    private final class Target: NSObject {
        weak var owner: NativeFrameDemand?
        @objc func tick(_ link: CADisplayLink) { owner?.timestamps.append(link.timestamp) }
    }
    private let target = Target()
    private var link: CADisplayLink?
    private var timestamps: [Double] = []
    private let requestedHz: Int

    init(screen: UIScreen) {
        requestedHz = screen.maximumFramesPerSecond
        target.owner = self
        let link = CADisplayLink(target: target, selector: #selector(Target.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: Float(min(60, requestedHz)),
            maximum: Float(requestedHz), preferred: Float(requestedHz))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func stop() -> [String: Any] {
        link?.invalidate()
        link = nil
        let elapsed = (timestamps.last ?? 0) - (timestamps.first ?? 0)
        return ["requestedHz": requestedHz, "callbackHz": elapsed > 0 ? Double(timestamps.count - 1) / elapsed : 0,
                "callbackCount": timestamps.count, "measurement": "native CADisplayLink callbacks; not WebKit frames"]
    }

    deinit { link?.invalidate() }
}
#endif
