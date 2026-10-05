# Desktop capture from a Spindle worker

The first integration exposes `spindle.desktop.capture` in backend extension workers. It does not expose a frontend capture API, native IPC commands, filesystem paths, browser media streams, or raw capture bytes to extensions.

The desktop client includes an opt-in native transport and macOS/Windows adapters. On macOS 14+ or Windows 10 1903+/Windows 11, the tray's **Browser → Enable Extension Screen Capture…** connects capture to the selected local or remote instance through native OAuth. Capture is disabled by default and is not automatically restored after a restart or transport failure. Until enabled, `listDevices()` returns an empty list. The host capability `desktop-capture-worker-v1` describes protocol availability, not OS capture support or permission.

Linux still advertises no capture capability: its portal/GPU encoder integration is not implemented. There is no browser, X11, or FFmpeg capture fallback. Replay buffers are not implemented or advertised on any platform yet.

## Native macOS adapter

- An authorized worker request opens the macOS ScreenCaptureKit picker directly, without creating or showing a Lumiverse recording window. Single-display and single-window modes are both allowed, initially entering display selection. A temporary native camera/recording menu-bar item provides the extension, destination, instance/account, progress, **Stop & Discard**, optional **Review Before Sending**, and **Choose a Window…**/**Choose a Display…** entry modes. **Capture Details & Permissions…** creates recovery controls only on an explicit owner action; optional review creates a preview only when requested. Server-controlled labels cannot inject control characters or bidirectional overrides. Scoped picker authorization does not require app-wide Screen Recording access. Window selection uses the system overlay, not an extension-visible list: bring the other application's window into view and select it there. App-wide permission never bypasses local source selection.
- If the picker is restricted or cannot select the desktop, the native owner can explicitly choose **Grant Screen Recording Access…**. Only this native action calls `CGRequestScreenCaptureAccess`; startup, capability discovery, device enumeration, worker requests, and frontend IPC never request it. **Open Screen Recording Settings…** opens the macOS privacy pane when access is still unavailable. OS denial is reported as `denied`, not an undifferentiated capture failure. No audio or microphone access is requested.
- With app-wide permission granted, the same owner action offers a bounded native `SCShareableContent` list of displays and visible other-app windows. The placeholder is not a selected source: capture requires an explicit native click on **Capture Selected Source**. That action authorizes this one capture and send. Display capture constructs an explicit display filter excluding this client's windows, rather than reusing a current-window filter. Source metadata never crosses IPC. Permission is rechecked before capture, while the request is active, and before release; revocation discards the request. Returning to the system picker never silently captures a listed source. Full-display sharing may include sensitive content; **Review Before Sending** is available but not mandatory.
- Screenshots use `SCScreenshotManager` and remain in native memory until approved release. Source selection authorizes release, unless the owner requests an optional local review first. No screenshot file is created.
- Video uses `SCStream` GPU-backed capture and a VideoToolbox/AVAssetWriter H.264 encoder. The client probes for a real hardware encoder and requests `RequireHardwareAcceleratedVideoEncoder` on the writer. If unavailable or initialization fails, recording is rejected rather than silently using software. GPU capture and hardware compression are separate capabilities.
- Recording is video-only, at most 1920×1080/30fps, 1–30 seconds, with a three-frame capture queue and no accumulated frame backlog. One owner-only temporary directory holds the MP4 during encoding and native preview. File size is monitored, oversized output is discarded, and final duration/absence of audio are checked before sharing. This is a bounded, temporary per-request recording, **not** an always-on or rolling replay buffer.
- The native menu-bar countdown and macOS sharing controls expose recording without a Lumiverse popup; **Stop & Discard**, closure of an explicitly opened panel, cancellation, command expiry, session inactivity/lock notifications, source loss, desktop OAuth sign-out, instance change, and transport failure cancel it. Source selection authorizes only this request; validation still runs before automatic release. The native menu-bar item is removed on completion/cancellation. Discard before release never uploads pixels. An independent native prompt budget enforces a 10-second cooldown and at most six prompts per five minutes; direct picker presentation does not relax this budget.
- The private recording directory is removed on completion/cancellation/exit; abandoned directories belonging to terminated processes are cleaned on startup. This is ordinary file deletion, not guaranteed secure erasure on SSDs or protection against OS swap. Buffer clearing is best-effort, not a guarantee that framework/HTTP-internal copies have been erased.

`listDevices()` lists connected desktop clients, not their windows, applications, or monitors. Target selection follows the extension's **Share** action directly in the OS picker. Duplicate display names are distinct registrations, not different screens; an interrupted development process can leave an old registration for up to its 45-second lease. Refresh the extension catalog after expiration; do not automatically redirect a saved target to another device. There is no always-on screen buffer.

### One action, one capture

Source selection is the native authorization to capture and send this one image or bounded clip to the displayed instance/model. There is no mandatory post-capture Send button and no remembered approval: every request must select a source again. The immutable native menu-bar controls on macOS or HUD on Windows name the requesting extension and destination, state that source selection authorizes release, and provide **Stop & Discard**. **Review Before Sending** optionally pauses release for local inspection and **Share This Capture**, for this request only. An extension cannot choose a target, change the native controls, or enable silent capture through a request flag.

The normal flow is the extension's **Share** action → OS source picker → capture for the requested duration → validation and opaque asset return → extension generation/optional TTS. The client still enforces expiry, size/duration limits, no audio, cancellation and native prompt throttling. The broker rechecks permissions and the exact worker/account/connection revision before delivering or consuming an asset. Discard before release uploads nothing; an upload already released cannot be recalled.

This UI change does not add required fields to the private command protocol or change the published SDK request shape. Existing backend commands remain usable. Pixels, native source metadata and private recording paths remain inaccessible to the extension/frontend.

## Native Windows adapter

- A compact native Win32 HUD on a dedicated STA thread opens `GraphicsCapturePicker` immediately, initialized with its native window handle, without foregrounding a large consent window first. The HUD shows the extension and destination; **Details…** expands the full installation, purpose, instance/account and limits. Source selection authorizes this one capture and send; **Review Before Sending** is optional. There is no target enumeration, remembered source or programmatic picker bypass. The picker selects one window or display; the OS capture border is not suppressed.
- Availability requires UniversalApiContract v8 (Windows 10 1903+) and `GraphicsCaptureSession.IsSupported()`, plus a hardware D3D11 device. A free-threaded two-frame capture pool supplies GPU surfaces. Source size is validated before starting; source resize/closure cancels rather than capturing stale/padded pixels.
- Screenshots use a bounded native-memory PNG encoder and a native preview. Video uses GPU-backed `MediaStreamSource` samples and `MediaTranscoder`, with `HardwareAccelerationEnabled = true`. This is **hardware-preferred, not hardware-guaranteed**: Windows may select software H.264, and the consent panel says so. Capability probing does not prove encoder selection or codec availability; actual preparation can still reject recording. macOS's hardware-required policy is unchanged.
- Recordings omit audio and use at most 1920×1080/30fps, 4 Mbps, and the requested 1–30 seconds. The MP4 stays in `InMemoryRandomAccessStream`; its size is monitored and oversized output is discarded. The 32 MiB release limit is not a hard allocator limit on transient framework buffers. Native MediaPlayer playback checks the actual duration, dimensions, and absence of audio, and must produce a preview frame before Share is enabled. **Play / Pause** and **Replay Clip** control only that local clip, not a rolling capture buffer.
- **Stop & Discard**, panel closure, command expiry, source closure/resize, Windows session lock/logoff/disconnect, suspend, permission/worker cancellation, and transport shutdown discard native state. Session notification registration must succeed. Capture UI is excluded from screen capture where supported. Sample deferrals are completed even on cancellation, queue overflow, or native errors; callbacks/preview slots are bounded. Source selection authorizes release for this request only, and media validation still runs before delivery.
- No Windows recording file is created, but OS swap and framework copies are outside the buffer-clearing guarantee. Windows N systems may need the Media Feature Pack for H.264 recording/playback. Test on a physical Windows session; CI/cross-compilation cannot validate picker consent, drivers, encoder choice, or screen-lock behavior.

Native credentials, device leases, frames, file paths, and previews do not cross Tauri IPC. Only enable/disable/status commands exist, scoped to the bundled `main` tray window, checked again against its label and URL in Rust, and explicitly declared in the application ACL. The native transport verifies the OAuth account before registration and after token changes; a different account cannot inherit the active device lease or consent context. Local instance capture may require a separate desktop OAuth sign-in; the integrated browser's cookie is not reused.

Hardware capture, actual picker behavior, screen-lock cancellation, video playback, and byte/duration bounds require an on-device acceptance test before release. Compiling or running protocol tests does not validate those OS interactions.

### On-device acceptance

1. Enable capture for a local instance and a remote HTTPS instance separately; verify the device is listed only for the native OAuth account. Check that restart, browser cookie changes, and instance switching never silently enable capture.
2. Request an image from a permissioned worker. Verify the displayed installation, model/endpoint, purpose, and limits; select a window/display. On macOS test the scoped picker without app-wide permission, then the explicitly permissioned native list with a different application's window and each display. Verify that enumeration never happens before the owner action, the placeholder cannot capture, returning to the system picker works, and revoking OS access during selection/recording/preview discards the request. Test both Tauri development and a bundled `.app`, including OS-grant/restart recovery. Discard and verify no upload, then repeat and share into a supported raw model request. Verify the requesting extension receives an asset reference, not bytes or paths.
3. Request 1-second and 30-second recordings. Confirm the selected source, visible stop controls, playback, precise duration, dimensions, absence of audio, and GPU video-encode activity. Test unavailable/busy hardware: macOS must reject software fallback; Windows must disclose its hardware-preferred policy and fail safely if codec preparation/preview is unavailable. Test Windows N with/without its media features.
4. Cancel/close the picker, close the source, lock/switch users/sleep, revoke each extension permission, unload its worker, disable capture, sign out of desktop OAuth, change instances, and interrupt the network during selection, recording, preview, and upload. Verify capture stops and private assets are discarded. Upload already released before cancellation cannot be recalled from a provider.
5. Force expiry, byte/pixel limits, repeated prompts, malformed command labels, and forged Tauri calls from the remote frontend/widget. Verify rejection and no media IPC. Resize the Windows source during capture and verify cancellation. Kill the app during recording; Windows should leave no recording files; macOS restart should remove abandoned private files without deleting another running client's buffer. Follow `desktop/README.md` for the Windows development/test commands.
6. Verify the picker opens directly. macOS must not create/show a Lumiverse window during normal capture or finishing; menu-bar progress and Stop must remain usable. On Windows, select both another application's window and each display in the OS picker and confirm the selected item is captured; no current-window/monitor shortcut is allowed. A normal capture must reach generation without another Send click. Every subsequent request must still require source selection. Test **Review Before Sending** from the macOS capture menu or Windows HUD before source selection and during recording: release must pause until optional **Share**, and the preview must show the image/video after its lazy creation. Test Discard, native expiry, permission revocation and disconnect at each stage; no canceled request should reach a model and the macOS capture icon must disappear. Existing backend command envelopes must still work without additional runtime/revision fields.

## Extension permissions

Declare `screen_capture` for images, `screen_recording` for video, and `generation` to send approved captures to a model. Both capture permissions are privileged and never auto-granted. A grant is only permission to request capture; it is not permission to start silently or upload without local device-owner approval.

An extension must select an explicit desktop device and an owned connection profile. Captures are bound to the worker runtime, extension installation, user, and connection revision. Changing the provider, model, endpoint, or connection configuration invalidates a handle. Handles expire after two minutes and are consumed once. Unload, capture/generation permission revocation, or native device disconnect cancels pending requests and removes retained captures.

```ts
const devices = await spindle.desktop.capture.listDevices()
if (!devices.length) return

const capture = await spindle.desktop.capture.request({
  deviceId: devices[0].id,
  connectionId,
  purpose: 'Describe the selected application window',
  kind: 'image',
})

await spindle.generate.raw({
  connection_id: connectionId,
  provider,
  model,
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this screenshot.' },
      { type: 'desktop_capture', asset_id: capture.assetId },
    ],
  }],
})
```

Operator-scoped extensions must supply `userId`; user-scoped extensions cannot switch ownership by supplying a different user. Use `capture.release(assetId)` to discard an unused capture. References are supported only in raw generation and raw streaming, not batch/quiet generation or normal chat persistence.

For video, use `kind: 'video'`, `mode: 'record' | 'replay'`, and `durationSeconds` (1–30). A replay request is not an instruction to arm recording: it may export only from a buffer already explicitly armed in trusted native UI. The initial provider allowlist accepts images for Google, Google Vertex, OpenAI, Anthropic, and OpenRouter adapters; video is limited to Google and Gemini-protocol Google Vertex models (`google_vertex`). The chosen model must also support the supplied media. Unsupported providers are rejected rather than silently dropping media. Capture-backed generation rejects caller parameters that override models, routing, destinations, or message bodies.

## Native-client protocol

All routes are under `/api/desktop/v1/capture` and require the existing desktop OAuth access token, verified audience/issuer, and the `lumiverse-desktop` authorized client. Do not call them from extension/frontend JavaScript or expose the access token or lease token to a WebView.

- `POST /devices`: register `{ name, platform, capabilities: { image, video, replay } }`; returns a generated device descriptor and a private `transportToken`.
- `GET /devices/:deviceId/commands`: poll using `X-Lumiverse-Capture-Lease: <transportToken>`. Poll well within the 45-second device lease. Commands are delivered once; a transport failure must not silently repeat a consent prompt.
- `POST /devices/:deviceId/responses`: submit an approved media response or a denial/cancellation/unsupported/failure outcome, using the same lease header.
- `DELETE /devices/:deviceId`: disconnect, cancel requests, and discard retained media.

An approved response has `{ requestId, outcome: 'approved', media: { mimeType, data, width, height, durationSeconds? } }`; `data` is standard padded base64. A non-approved response has `{ requestId, outcome }`. Error text from the native client is deliberately not relayed to extensions. Allowed MIME types are PNG/JPEG/WebP images and MP4/WebM video. Images are inspected with pixel limits; video currently receives container-signature and metadata checks, not complete codec/duration inspection. The native encoder must enforce the real clip duration and omit audio.

The broker retains assets only in bounded backend memory: 8 MiB/image, 32 MiB/video, 64 MiB globally. Because release uploads to the connected instance, local approval must explicitly name both that instance and the model destination. Transport to a remote instance must use HTTPS. Request and response bodies for capture-backed model calls are excluded from request history. Model output itself still reaches the requesting extension and may disclose screen contents.

## Required native security boundary

Before advertising any capability, the native adapter must:

- Use the platform's consent-preserving picker/portal and trusted bundled UI, not extension-controlled UI.
- Show the requesting extension, selected source, purpose, connected instance, exact model destination, and retention limits. Treat server-provided labels as untrusted text.
- Require explicit local approval before capture and before releasing pixels. An OS-wide permission grant does not authorize individual extensions.
- Keep raw frames, encoder state, and replay storage native. Never send them through the shared frontend JavaScript realm.
- Keep indicators and a trusted stop control visible; stop on cancellation, expiry, screen lock, logout, instance changes, source closure, or transport loss. Expired commands cannot authorize new capture.
- Enforce the command's byte/pixel/duration limits, no audio, and a bounded private recording buffer. Never start/rearm a replay buffer from a worker request.
- Connect through a native-only authenticated transport. Do not add privileged capture commands to existing wildcard-origin Tauri capabilities.

The server protocol cannot prove that a native producer actually showed a picker or approval UI; those safeguards must be implemented and tested in the desktop adapter before capture capabilities are enabled. It does not defend against native malware, a compromised OS, or an upstream model retaining already-approved uploads.
