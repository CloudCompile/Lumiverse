import AVFoundation
import Speech
import UIKit
import WebKit

/// Apple speech recognition for WKWebView, which does not expose Safari's Web Speech API.
final class NativeSpeech {
    private var id: String?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var engine: AVAudioEngine?
    private var recognizer: SFSpeechRecognizer?
    private weak var webview: WKWebView?
    private var origin: String?
    private var transcript = ""
    private var stopping = false
    private var ownsAudioSession = false
    private var hasAudioTap = false
    private var stopTimeout: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []

    init() {
        for name in [UIApplication.didEnterBackgroundNotification, AVAudioSession.interruptionNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self = self, self.id != nil else { return }
                self.emit(["type": "error", "message": "Dictation was interrupted."])
                self.cancel()
            })
        }
    }
    deinit { cancel(); for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    func start(id: String, language: String, webview: WKWebView, completion: @escaping (String?) -> Void) {
        guard self.id == nil else { completion("Dictation is already running."); return }
        guard UIApplication.shared.applicationState == .active else { completion("Open Lumiverse to start dictation."); return }
        self.id = id; self.webview = webview; origin = NativeBridge.origin(webview.url)
        transcript = ""; stopping = false
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self = self, self.id == id, !self.stopping else { completion("Dictation was cancelled."); return }
                guard status == .authorized else {
                    self.cancel(); completion("Allow Speech Recognition for Lumiverse in iOS Settings."); return
                }
                AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                    DispatchQueue.main.async {
                        guard let self = self, self.id == id, !self.stopping else { completion("Dictation was cancelled."); return }
                        guard granted else { self.cancel(); completion("Allow Microphone access for Lumiverse in iOS Settings."); return }
                        guard UIApplication.shared.applicationState == .active, self.origin == NativeBridge.origin(webview.url) else {
                            self.cancel(); completion("Dictation was cancelled."); return
                        }
                        do { try self.begin(language: language); completion(nil) }
                        catch { self.cancel(); completion(error.localizedDescription) }
                    }
                }
            }
        }
    }

    private func begin(language: String) throws {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)), recognizer.isAvailable else {
            throw NSError(domain: "Lumiverse", code: 1, userInfo: [NSLocalizedDescriptionKey: "Apple speech recognition is unavailable for this language or network."])
        }
        self.recognizer = recognizer
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true)
        ownsAudioSession = true
        let engine = AVAudioEngine(), request = SFSpeechAudioBufferRecognitionRequest()
        self.engine = engine; self.request = request
        request.shouldReportPartialResults = true
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "Lumiverse", code: 2, userInfo: [NSLocalizedDescriptionKey: "No microphone input is available."])
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        hasAudioTap = true
        let sessionID = id
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self, self.id == sessionID else { return }
                if let result = result {
                    self.transcript = result.bestTranscription.formattedString
                    self.emit(["type": "result", "text": self.transcript, "isFinal": result.isFinal])
                    if result.isFinal { self.complete(); return }
                }
                if let error = error {
                    if self.stopping { self.complete(finalize: true) }
                    else { self.emit(["type": "error", "message": error.localizedDescription]); self.cancel() }
                }
            }
        }
        engine.prepare()
        try engine.start()
    }

    func stop(id: String?) {
        guard id == self.id, self.id != nil, !stopping else { return }
        stopping = true
        stopAudio()
        request?.endAudio()
        let timeout = DispatchWorkItem { [weak self] in self?.complete(finalize: true) }
        stopTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: timeout)
    }

    func cancel(id: String? = nil) {
        if let id = id, id != self.id { return }
        stopTimeout?.cancel(); stopTimeout = nil
        self.id = nil
        stopAudio(); request?.endAudio(); task?.cancel()
        request = nil; task = nil; recognizer = nil; webview = nil; origin = nil
        stopping = false
    }

    private func stopAudio() {
        if let engine = engine {
            engine.stop()
            if hasAudioTap { engine.inputNode.removeTap(onBus: 0); hasAudioTap = false }
            self.engine = nil
        }
        if ownsAudioSession {
            ownsAudioSession = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private func complete(finalize: Bool = false) {
        guard id != nil else { return }
        if finalize && !transcript.isEmpty { emit(["type": "result", "text": transcript, "isFinal": true]) }
        emit(["type": "end"])
        cancel()
    }

    private func emit(_ value: [String: Any]) {
        guard let id = id, let webview = webview, origin == NativeBridge.origin(webview.url) else { return }
        var detail = value; detail["id"] = id
        webview.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('lumiverse:ios-speech', {detail: detail}))",
            arguments: ["detail": detail], in: nil, in: .page, completionHandler: nil)
    }
}
