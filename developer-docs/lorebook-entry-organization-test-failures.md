# Ordinary-terminal suite failures: developer handoff

## Run provenance

- Date: October 4, 2026. User ran unelevated PowerShell outside the execution sandbox.
- Branch: codex/lorebook-entry-organization; base: upstream/staging 0284320f82c1c16287f7c0c632c6db399ce95b83; implementation unstaged.
- Command: `bun test --isolate src` from the feature worktree.
- Bun: 1.4.2; platform: Windows; frontend dependencies shared with the original checkout.
- Result: **5,296 pass, 20 fail, 1 error; 62,167 assertions; 5,316 tests across 707 files; 304.68 seconds**.
- Source log: `%TEMP%\lorebook-organization-unsandboxed.log`.
- Source log SHA-256: `979d66a12ff8a4c83c7ff1ad2f747aaa990d7fc0a5dcbe953d693c0dcda3d370`.

The log contains 19 explicit failure markers plus one separately reported unhandled module error; Bun reports 20 failures and 1 error overall. Preserve that discrepancy rather than inventing a twentieth named test. The unnamed hook failure is reported exactly as logged.

No lorebook organization tests failed. The focused suite on this base passed 461 backend/runtime tests and 28 frontend API/editor regression tests. Four current-staging failures were reproduced in a clean temporary snapshot without feature changes: one maintenance scheduler, two Edit-and-Send route cases, and one generation-history case. That comparison used the sandbox; the original evidence here is the user’s ordinary-terminal run.

The older sandboxed run had 70 failures. Its reduction cannot be attributed solely to sandbox removal: the branch was also updated by eight staging commits. Earlier clean-base comparisons demonstrate feature independence only for that older base. Do not generalize those results to every remaining failure.

## Reproduce the remaining files

Run from the same feature worktree in ordinary PowerShell. This narrows the run to affected suites; it may still reproduce unrelated passing tests in those files.

```powershell
$failedFiles = @(
  'src/db/maintenance-scheduler.test.ts'
  'src/routes/chats.routes.edit-and-send.test.ts'
  'src/services/images.service.test.ts'
  'src/spindle/ui-registry.drift.test.ts'
  'src/utils/image-pipeline.test.ts'
  'src/utils/lancedb-path.test.ts'
  'src/services/generation/request-history.test.ts'
  'frontend/src/components/chat/MessageContent.long-message.test.tsx'
  'frontend/src/components/panels/LoomBuilder.controlled.test.tsx'
  'frontend/src/components/shared/DesktopWindowChrome.contract.test.ts'
  'frontend/src/components/panels/image-gen-connections/ImageGenConnectionManager.test.tsx'
  'frontend/src/components/panels/ConnectionManager.active-profile.test.tsx'
)
bun test --isolate @failedFiles 2>&1 | Tee-Object -FilePath "$env:TEMP\lumiverse-remaining-failures.log"
```

No production data, credentials, package versions, registries, or unrelated source were changed to suppress these failures. Suggested follow-ups below are hypotheses or test-fixture repairs to review separately; they are not implemented fixes.

## Failure evidence by suite

### src/db/maintenance-scheduler.test.ts

Current clean staging reproduction: fails without feature changes. Fixture lacks edit_and_send_requests; reconcile emits a missing-table error before the expected running state. Verify scheduler isolation and populate the required minimal schema.

Reproduce: `bun test --isolate src/db/maintenance-scheduler.test.ts`

#### automatic maintenance outbox sweep > tick dispatches a never-attempted pending row once its backoff elapses  [3043.40ms]

```text
provider [14.31ms]
[db] Edit-and-send outbox reconcile failed: SQLiteError: no such table: edit_and_send_requests
      errno: 1,
 byteOffset: -1,
       code: "SQLITE_ERROR"

      at [prepareOwned] (bun:sqlite:330:37)
      at query (bun:sqlite:347:31)
      at readCommittedEditAndSendContext (<checkout>/src\services\edit-and-send-dispatcher.service.ts:209:6)
      at dispatchClaimedEditAndSendOutbox (C:\Users\eisen\Documents\Ai Tools\LumiTest\Lumiverse\.worktrees\lorebook-ent
ry-organization\src\services\edit-and-send-dispatcher.service.ts:401:30)
      at dispatchPendingEditAndSendOutbox (C:\Users\eisen\Documents\Ai Tools\LumiTest\Lumiverse\.worktrees\lorebook-ent
ry-organization\src\services\edit-and-send-dispatcher.service.ts:535:11)
      at tick (<checkout>/src\db\maintenance-scheduler.ts:143:13)

200 |     // Simulate backoff expiry; the very next tick's sweep must pick it up.
201 |     getDb()
202 |       .query("UPDATE generation_outbox SET next_attempt_at = ? WHERE id = ?")
203 |       .run(Date.now() - 1, "orphan-run");
204 |
205 |     expect(await waitFor(() => row("orphan-run")?.status === "running")).toBe(true);
                                                                               ^
error: expect(received).toBe(expected)

Expected: true
Received: false

      at <anonymous> (<checkout>/src\db\maintenance-scheduler.test.ts:205:74)
(fail) automatic maintenance outbox sweep > tick dispatches a never-attempted pending row once its backoff elapses
```

### src/routes/chats.routes.edit-and-send.test.ts

Both failures reproduced on current clean staging. Dispatch now includes editAndSendContext, while exact object expectations omit it. Audit the intended contract and update preservation expectations deliberately.

Reproduce: `bun test --isolate src/routes/chats.routes.edit-and-send.test.ts`

#### POST /:chatId/edit-and-send > commits a historical branch and dispatches only the copied assistant identity  [20.76ms]

```text
172 |       }),
173 |     });
174 |
175 |     expect(response.status).toBe(200);
176 |     const body = await response.json();
177 |     expect(body).toEqual({
                       ^
error: expect(received).toEqual(expected)

  {
-   "branchChatId": Any<String>,
-   "editedMessageId": Any<String>,
+   "branchChatId": "36f9500d-dfa0-42a8-9f55-e918e36e59de",
+   "editedMessageId": "2f6ecc5d-6997-412a-9395-0a9760400f22",
    "generationCursor": {
-     "chatId": Any<String>,
-     "generationId": Any<String>,
+     "chatId": "36f9500d-dfa0-42a8-9f55-e918e36e59de",
+     "editAndSendContext": {
+       "committedRevision": 2,
+       "editedUserMessageId": "2f6ecc5d-6997-412a-9395-0a9760400f22",
+     },
+     "generationId": "81c93b74-f282-415c-9690-0b98123732ab",
      "mode": "swipe",
      "requestId": "req-1",
    },
-   "immediateAssistantId": Any<String>,
+   "immediateAssistantId": "49c3756a-e1c7-4119-a246-be7e72023c26",
  }

- Expected  - 5
+ Received  + 9

      at <anonymous> (<checkout>/src\routes\chats.routes.edit-and-send.test.ts:177:18)
(fail) POST /:chatId/edit-and-send > commits a historical branch and dispatches only the copied assistant identity
```

#### POST /:chatId/edit-and-send > accepts in-place mode and dispatches the source chat and source assistant [5.64ms]

```text
334 |         branchChatOnEditAndSend: false,
335 |       }),
336 |     });
337 |     expect(response.status).toBe(200);
338 |     const body = await response.json();
339 |     expect(body).toEqual({
                       ^
error: expect(received).toEqual(expected)

  {
    "branchChatId": "chat-1",
    "editedMessageId": "user-1",
    "generationCursor": {
      "chatId": "chat-1",
-     "generationId": Any<String>,
+     "editAndSendContext": {
+       "committedRevision": 2,
+       "editedUserMessageId": "user-1",
+     },
+     "generationId": "44a51524-b50d-4f6e-a4e3-b775a767aa11",
      "mode": "swipe",
      "requestId": "req-in-place",
    },
    "immediateAssistantId": "asst-1",
  }

- Expected  - 1
+ Received  + 5

      at <anonymous> (<checkout>/src\routes\chats.routes.edit-and-send.test.ts:339:18)
(fail) POST /:chatId/edit-and-send > accepts in-place mode and dispatches the source chat and source assistant [5.64ms]
```

### src/services/images.service.test.ts

Files exist; metadata format is heif instead of expected avif. This ordinary-terminal failure is not evidence of an unavailable codec. Check Sharp/libheif metadata semantics and codec versions before changing production code.

Reproduce: `bun test --isolate src/services/images.service.test.ts`

#### deferred image processing > uses Sharp AVIF thumbnails when the operator codec is enabled [239.21ms]

```text
[9.27ms]
569 |     const avifSmPath = join(testDataDir, "images", `${image.id}_thumb_sm_v2.avif`);
570 |     const avifLgPath = join(testDataDir, "images", `${image.id}_thumb_lg_v2.avif`);
571 |     expect(existsSync(avifSmPath)).toBe(true);
572 |     expect(existsSync(avifLgPath)).toBe(true);
573 |     expect(existsSync(join(testDataDir, "images", `${image.id}_thumb_sm_v2.webp`))).toBe(false);
574 |     expect(await readImageMetadata(avifSmPath)).toMatchObject({ format: "avif" });
                                                      ^
error: expect(received).toMatchObject(expected)

  {
-   "format": "avif",
+   "format": "heif",
+   "height": 1,
+   "width": 1,
  }

- Expected  - 1
+ Received  + 3

      at <anonymous> (<checkout>/src\services\images.service.test.ts:574:49)
(fail) deferred image processing > uses Sharp AVIF thumbnails when the operator codec is enabled [239.21ms]
```

### src/spindle/ui-registry.drift.test.ts

Frontend/backend arrays have matching members but different positions for ooc and feedback. Decide whether this contract is ordering-sensitive before changing either registry or assertion.

Reproduce: `bun test --isolate src/spindle/ui-registry.drift.test.ts`

#### frontend/backend H4 registry mirror > built-in drawer ids stay in sync [1.77ms]

```text
8 | }
 9 |
10 | describe('frontend/backend H4 registry mirror', () => {
11 |   test('built-in drawer ids stay in sync', async () => {
12 |     const source = await readFile(join(import.meta.dir, '../../frontend/src/lib/drawer-tab-registry.tsx'), 'utf8')
13 |     expect(BUILT_IN_DRAWER_TABS.map((tab) => tab.id)).toEqual(frontendIds(source))
                                                           ^
error: expect(received).toEqual(expected)

  [
    "profile",
    "presets",
    "loom",
    "weaver",
    "connections",
    "browser",
    "characters",
    "personas",
    "multiplayer",
    "lorebook",
    "cortex",
    "databank",
    "create",
+   "ooc",
    "prompt",
    "council",
    "summary",
+   "feedback",
    "worldinfo",
    "imagegen",
    "wallpaper",
    "regex",
    "branches",
    "theme",
    "spindle",
-   "ooc",
-   "feedback",
  ]

- Expected  - 2
+ Received  + 2

      at <anonymous> (<checkout>/src\spindle\ui-registry.drift.test.ts:13:55)
(fail) frontend/backend H4 registry mirror > built-in drawer ids stay in sync [1.77ms]
```

### src/utils/image-pipeline.test.ts

AVIF output is produced, but metadata reports heif. Same mismatch as the images-service test; record Sharp/libheif versions and verify actual encoding separately from container naming.

Reproduce: `bun test --isolate src/utils/image-pipeline.test.ts`

#### Bun-native image pipeline > writes AVIF output through Sharp [12.85ms]

```text
54 |   test("writes AVIF output through Sharp", async () => {
55 |     const destination = join(workDir, "thumbnail.avif");
56 |     await writeInsideAvif(onePixelPng, destination, 32, 32, 54, {
57 |       withoutEnlargement: true,
58 |     });
59 |     expect(await readImageMetadata(destination)).toMatchObject({
                                                      ^
error: expect(received).toMatchObject(expected)

  {
-   "format": "avif",
+   "format": "heif",
    "height": 1,
    "width": 1,
  }

- Expected  - 1
+ Received  + 1

      at <anonymous> (<checkout>/src\utils\image-pipeline.test.ts:59:50)
(fail) Bun-native image pipeline > writes AVIF output through Sharp [12.85ms]
```

### src/utils/lancedb-path.test.ts

Seven Termux path expectations fail on Windows. Windows resolution introduces drive/backslash behavior. Reproduce on the supported Termux platform and isolate path semantics explicitly in tests.

Reproduce: `bun test --isolate src/utils/lancedb-path.test.ts`

#### resolveLanceDbConnectUri > uses a cwd-relative path for Termux workspaces [1.01ms]

```text
11 |
12 |   test("uses a cwd-relative path for Termux workspaces", () => {
13 |     expect(resolveLanceDbConnectUri("/data/data/com.termux/files/home/Lumiverse/data/lancedb", {
14 |       cwd: "/data/data/com.termux/files/home/Lumiverse",
15 |       env: { PREFIX: "/data/data/com.termux/files/usr" },
16 |     })).toBe("data/lancedb");
             ^
error: expect(received).toBe(expected)

Expected: "data/lancedb"
Received: "data\lancedb"

      at <anonymous> (<checkout>/src\utils\lancedb-path.test.ts:16:9)
(fail) resolveLanceDbConnectUri > uses a cwd-relative path for Termux workspaces [1.01ms]
```

#### resolveLanceDbConnectUri > does not manufacture a stripped Termux path when cwd is root [0.21ms]

```text
18 |
19 |   test("does not manufacture a stripped Termux path when cwd is root", () => {
20 |     expect(resolveLanceDbConnectUri("/data/data/com.termux/files/home/Lumiverse/data/lancedb", {
21 |       cwd: "/",
22 |       env: { PREFIX: "/data/data/com.termux/files/usr" },
23 |     })).toBe("/data/data/com.termux/files/home/Lumiverse/data/lancedb");
             ^
error: expect(received).toBe(expected)

Expected: "/data/data/com.termux/files/home/Lumiverse/data/lancedb"
Received: "data\data\com.termux\files\home\Lumiverse\data\lancedb"

      at <anonymous> (<checkout>/src\utils\lancedb-path.test.ts:23:9)
(fail) resolveLanceDbConnectUri > does not manufacture a stripped Termux path when cwd is root [0.21ms]
```

#### resolveLanceDbConnectUri > uses a parent-relative path when the database is outside the cwd [0.15ms]

```text
25 |
26 |   test("uses a parent-relative path when the database is outside the cwd", () => {
27 |     expect(resolveLanceDbConnectUri("/data/data/com.termux/files/home/shared/lancedb", {
28 |       cwd: "/data/data/com.termux/files/home/Lumiverse",
29 |       env: { TERMUX_VERSION: "0.119.0" },
30 |     })).toBe("../shared/lancedb");
             ^
error: expect(received).toBe(expected)

Expected: "../shared/lancedb"
Received: "..\shared\lancedb"

      at <anonymous> (<checkout>/src\utils\lancedb-path.test.ts:30:9)
(fail) resolveLanceDbConnectUri > uses a parent-relative path when the database is outside the cwd [0.15ms]
```

#### resolveLanceDbConnectUri > uses a parent-relative path for Termux data dirs outside the repo [0.11ms]

```text
32 |
33 |   test("uses a parent-relative path for Termux data dirs outside the repo", () => {
34 |     expect(resolveLanceDbConnectUri("/data/data/com.termux/files/home/data/lancedb", {
35 |       cwd: "/data/data/com.termux/files/home/Lumiverse",
36 |       env: { TERMUX_VERSION: "0.119.0" },
37 |     })).toBe("../data/lancedb");
             ^
error: expect(received).toBe(expected)

Expected: "../data/lancedb"
Received: "..\data\lancedb"

      at <anonymous> (<checkout>/src\utils\lancedb-path.test.ts:37:9)
(fail) resolveLanceDbConnectUri > uses a parent-relative path for Termux data dirs outside the repo [0.11ms]
```

#### resolveLanceDbConnectUri > uses a parent-relative path when running in proot-distro [0.13ms]

```text
39 |
40 |   test("uses a parent-relative path when running in proot-distro", () => {
41 |     expect(resolveLanceDbConnectUri("/home/darren/data/lancedb", {
42 |       cwd: "/home/darren/Lumiverse-Backend",
43 |       env: { LUMIVERSE_IS_PROOT: "true" },
44 |     })).toBe("../data/lancedb");
             ^
error: expect(received).toBe(expected)

Expected: "../data/lancedb"
Received: "..\data\lancedb"

      at <anonymous> (<checkout>/src\utils\lancedb-path.test.ts:44:9)
(fail) resolveLanceDbConnectUri > uses a parent-relative path when running in proot-distro [0.13ms]
```

#### resolveLanceDbConnectUri > resolves the broken Termux mirror path created by a stripped leading slash [0.17ms]

```text
46 |
47 |   test("resolves the broken Termux mirror path created by a stripped leading slash", () => {
48 |     expect(resolveBrokenTermuxLanceDbMirrorPath("/data/data/com.termux/files/home/Lumiverse/data/lancedb", {
49 |       cwd: "/data/data/com.termux/files/home/Lumiverse",
50 |       env: { TERMUX_VERSION: "0.119.0" },
51 |     })).toBe("/data/data/com.termux/files/home/Lumiverse/data/data/com.termux/files/home/Lumiverse/data/lancedb");
             ^
error: expect(received).toBe(expected)

Expected: "/data/data/com.termux/files/home/Lumiverse/data/data/com.termux/files/home/Lumiverse/data/lancedb"
Received: "C:\data\data\com.termux\files\home\Lumiverse\data\data\com.termux\files\home\Lumiverse\data\lancedb"

      at <anonymous> (<checkout>/src\utils\lancedb-path.test.ts:51:9)
(fail) resolveLanceDbConnectUri > resolves the broken Termux mirror path created by a stripped leading slash [0.17ms]
```

#### resolveLanceDbConnectUri > resolves the broken Termux mirror path for parent-relative data dirs [0.14ms]

```text
53 |
54 |   test("resolves the broken Termux mirror path for parent-relative data dirs", () => {
55 |     expect(resolveBrokenTermuxLanceDbMirrorPath("/data/data/com.termux/files/home/data/lancedb", {
56 |       cwd: "/data/data/com.termux/files/home/Lumiverse",
57 |       env: { TERMUX_VERSION: "0.119.0" },
58 |     })).toBe("/data/data/com.termux/files/home/Lumiverse/data/data/com.termux/files/home/data/lancedb");
             ^
error: expect(received).toBe(expected)

Expected: "/data/data/com.termux/files/home/Lumiverse/data/data/com.termux/files/home/data/lancedb"
Received: "C:\data\data\com.termux\files\home\Lumiverse\data\data\com.termux\files\home\data\lancedb"

      at <anonymous> (<checkout>/src\utils\lancedb-path.test.ts:58:9)
(fail) resolveLanceDbConnectUri > resolves the broken Termux mirror path for parent-relative data dirs [0.14ms]
```

### src/services/generation/request-history.test.ts

Reproduced on current clean staging. Worker-host fixture lacks captureGenerationRequests, causing .delete in finally to throw. Expand the minimally viable mock instead of hiding runtime cleanup failures.

Reproduce: `bun test --isolate src/services/generation/request-history.test.ts`

#### Spindle generation records the host's extension identity instead of input claims [8.15ms] [identity] AUTH_SECRET derived from identity file (not set in .env).

```text
3210 |         requestId,
3211 |         error: aborted ? "AbortError: Generation aborted" : err?.message ?? String(err),
3212 |       });
3213 |     } finally {
3214 |       this.generationAbortControllers.delete(requestId);
3215 |       this.captureGenerationRequests.delete(requestId);
                  ^
TypeError: undefined is not an object (evaluating 'this.captureGenerationRequests.delete')
      at handleGeneration (<checkout>/src\spindle\worker-host.ts:3215:12)
      at <anonymous> (<checkout>/src\services\generation\request-history.test.ts:98:14)
(fail) Spindle generation records the host's extension identity instead of input claims [8.15ms]
```

### frontend/src/components/chat/MessageContent.long-message.test.tsx

A beforeEach/afterEach hook times out at roughly 7.35 seconds. The log does not identify which hook; rerun alone to separate setup/cleanup flakiness from the rendering behavior.

Reproduce: `bun test --isolate frontend/src/components/chat/MessageContent.long-message.test.tsx`

#### (unnamed) [7349.71ms]

```text
(fail) (unnamed) [7349.71ms]
  ^ a beforeEach/afterEach hook timed out for this test.
```

### frontend/src/components/panels/LoomBuilder.controlled.test.tsx

Wrapper reports child exit code 1, but the assertion fails before printing child stdout/stderr. Run the child test directly to obtain the actual failure; root cause remains unclassified.

Reproduce: `bun test --isolate frontend/src/components/panels/LoomBuilder.controlled.test.tsx`

#### controlled Loom cases pass in an isolated module graph [3422.93ms]

```text
23 |     child.exited,
24 |   ])
25 |   clearTimeout(watchdog)
26 |   const summary = `${stdout}\n${stderr}`
27 |   expect(timedOut).toBe(false)
28 |   expect(exitCode).toBe(0)
                        ^
error: expect(received).toBe(expected)

Expected: 0
Received: 1

      at <anonymous> (<checkout>/front
end\src\components\panels\LoomBuilder.controlled.test.tsx:28:20)
(fail) controlled Loom cases pass in an isolated module graph [3422.93ms]
```

### frontend/src/components/shared/DesktopWindowChrome.contract.test.ts

Two multiline source-string assertions fail in this CRLF checkout; reproduced on the earlier clean baseline with matching checkout line endings. Inspect logical content and normalize source matching in memory rather than changing all checkout newlines.

Reproduce: `bun test --isolate frontend/src/components/shared/DesktopWindowChrome.contract.test.ts`

#### desktop window chrome contract > uses the complete Window Controls Overlay rectangle as the safe boundary  [1.86ms]

```text
their rounded clipping below. WKWebView must not clip the root element ΓÇö\r\n     doing so can discard the entire
promoted document canvas. */\r\n  --desktop-window-corner-radius: 12px;\r\n  background: transparent;\r\n
border-radius: var(--desktop-window-corner-radius);\r\n  overflow:
hidden;\r\n}\r\n\r\nhtml[data-tauri-desktop][data-desktop-windows-corners=\"rounded\"] {\r\n
--desktop-window-corner-radius: 8px;\r\n}\r\n\r\nhtml[data-tauri-desktop][data-desktop-windows-corners=\"square\"]
{\r\n  --desktop-window-corner-radius: 0px;\r\n}\r\n\r\nhtml {\r\n  height: 100%;\r\n  /* `overflow: clip` (vs
`hidden`) is strictly non-scrollable ΓÇö it cannot be\r\n     scrolled programmatically, by keyboard (PgUp/PgDn),
wheel, or touch. The\r\n     ViewportDrawer wrapper is position:fixed and uses transform:translateX to\r\n     slide
off-screen when closed, which leaves its bounding rect extending\r\n     past the right edge of the viewport. With
`overflow: hidden`, Chromium's\r\n     \"alternate axis\" wheel/keyboard heuristic could redirect vertical scroll\r\n
   attempts inside textareas (chat input, character description, greetings,\r\n     etc.) into a horizontal scrollLeft
on body, making the whole UI slide\r\n     sideways. `clip` shuts that path down entirely. */\r\n  overflow: clip;\r\n
 overscroll-behavior: none;\r\n  overscroll-behavior-x: none;\r\n  -webkit-text-size-adjust: 100%;\r\n  /* Let the
browser choose optimal font rendering. On macOS Big Sur+,\r\n     subpixel AA is disabled system-wide so `antialiased`
only disables\r\n     stem darkening ΓÇö making all text thinner/dimmer on dark backgrounds.\r\n     `auto` preserves
stem darkening for bolder, more readable text. */\r\n  -webkit-font-smoothing: auto;\r\n  -moz-osx-font-smoothing:
auto;\r\n}\r\n\r\nbody {\r\n  overflow: clip;\r\n  overscroll-behavior: none;\r\n  overscroll-behavior-x: none;\r\n
font-family: var(--lumiverse-font-family);\r\n  font-size: calc(14px * var(--lumiverse-font-scale, 1));\r\n  color:
var(--lumiverse-text);\r\n  background: var(--lumiverse-bg-deep);\r\n  line-height: 1.5;\r\n  touch-action: pan-x
pan-y;\r\n}\r\n\r\n/* The native frontend host is transparent. A theme can opt into a translucent\r\n   document
surface without changing browser/PWA rendering.
*/\r\nhtml[data-tauri-desktop][data-desktop-background]:not([data-desktop-background-blur]) body {\r\n  background:
transparent;\r\n}\r\n\r\n/* Keep the document transparent so the native window material can show through\r\n   the
translucent app shell. */\r\nhtml[data-tauri-desktop][data-desktop-background][data-desktop-background-blur] body
{\r\n  background: transparent;\r\n}\r\n\r\n/* A body background is otherwise promoted to the WebView canvas by
WebKit,\r\n   which defeats the transparent host above. The app shell supplies the actual\r\n   theme surface, while
these bounds clip every web-rendered layer to it. */\r\nhtml[data-tauri-desktop] body,\r\nhtml[data-tauri-desktop]
#root {\r\n  background: transparent;\r\n  border-radius: inherit;\r\n  overflow:
hidden;\r\n}\r\n\r\nimg,\r\npicture,\r\nvideo,\r\ncanvas,\r\nsvg {\r\n  display: block;\r\n  max-width: 100%;\r\n  /*
Suppress the iOS Safari long-press image lift / callout so custom\r\n     hold-to-action handlers (see useLongPress)
win the gesture. Opt back in\r\n     per-element with data-allow-lift / explicit -webkit-touch-callout styles. */\r\n
-webkit-touch-callout: none;\r\n  -webkit-user-select: none;\r\n  user-select: none;\r\n  -webkit-user-drag:
none;\r\n}\r\n\r\n[data-allow-lift] {\r\n  -webkit-touch-callout: default;\r\n  -webkit-user-select: auto;\r\n
user-select: auto;\r\n  -webkit-user-drag: auto;\r\n}\r\n\r\ninput,\r\nbutton,\r\ntextarea,\r\nselect {\r\n  font:
inherit;\r\n  color: inherit;\r\n}\r\n\r\n/* Prevent iOS Safari auto-zoom on input focus ΓÇö iOS zooms when font-size
< 16px.\r\n   !important is intentional: this is a hard platform constraint that must override\r\n   all CSS Module
class selectors (which have higher specificity than element selectors). */\r\n@media screen and (max-width: 600px)
{\r\n  input,\r\n  textarea,\r\n  select {\r\n    font-size: max(16px, 1em) !important;\r\n
}\r\n}\r\n\r\nbutton,\r\na,\r\n[role=\"button\"] {\r\n  /* Interactive elements: suppress the iOS long-press
text-selection magnifier\r\n     and callout. Cards (rendered as <button>) on the landing page were the\r\n
primary offender ΓÇö holding selected their inner h3/p text. */\r\n  -webkit-user-select: none;\r\n  user-select:
none;\r\n  -webkit-touch-callout: none;\r\n}\r\n\r\nbutton {\r\n  cursor: pointer;\r\n  border: none;\r\n  background:
none;\r\n}\r\n\r\na {\r\n  color: inherit;\r\n  text-decoration: none;\r\n}\r\n\r\nul,\r\nol {\r\n  list-style:
none;\r\n}\r\n\r\n/* ΓöÇΓöÇ Touch-friendly range inputs ΓöÇΓöÇ\r\n   44px is the minimum recommended touch target
(Apple HIG / WCAG 2.5.8).\r\n   The visual track stays thin ΓÇö the extra height is transparent hit area.\r\n
touch-action:none prevents the page from scrolling while dragging. */\r\ninput[type=\"range\"] {\r\n
-webkit-appearance: none;\r\n  appearance: none;\r\n  min-height: 44px;\r\n  background: transparent;\r\n  cursor:
pointer;\r\n  touch-action: none;\r\n}\r\n\r\ninput[type=\"range\"]::-webkit-slider-runnable-track {\r\n  height:
4px;\r\n  border-radius: 2px;\r\n  background: var(--lumiverse-fill-medium, rgba(0, 0, 0,
0.15));\r\n}\r\n\r\ninput[type=\"range\"]::-moz-range-track {\r\n  height: 4px;\r\n  border-radius: 2px;\r\n
background: var(--lumiverse-fill-medium, rgba(0, 0, 0, 0.15));\r\n  border:
none;\r\n}\r\n\r\ninput[type=\"range\"]::-webkit-slider-thumb {\r\n  -webkit-appearance: none;\r\n  width: 22px;\r\n
height: 22px;\r\n  border-radius: 50%;\r\n  background: var(--lumiverse-primary, #8c82ff);\r\n  border: 2px solid
var(--lumiverse-bg, #1c1826);\r\n  box-shadow: 0 0 0 1px var(--lumiverse-primary-020, rgba(140, 130, 255, 0.2)),\r\n
           0 1px 4px rgba(0, 0, 0, 0.3);\r\n  margin-top: -9px; /* vertically center on 4px track */\r\n  cursor:
pointer;\r\n}\r\n\r\ninput[type=\"range\"]::-moz-range-thumb {\r\n  width: 22px;\r\n  height: 22px;\r\n
border-radius: 50%;\r\n  background: var(--lumiverse-primary, #8c82ff);\r\n  border: 2px solid var(--lumiverse-bg,
#1c1826);\r\n  box-shadow: 0 0 0 1px var(--lumiverse-primary-020, rgba(140, 130, 255, 0.2)),\r\n              0 1px
4px rgba(0, 0, 0, 0.3);\r\n  cursor: pointer;\r\n}\r\n\r\n/* One scaling boundary for the application, body portals,
and extension\r\n   portal wrappers. Explicit lengths compensate once for zoom; percentage\r\n   widths on
individually zoomed children already account for their parent's\r\n   zoom, so dividing those percentages again
shrinks #root twice. */\r\nbody {\r\n  zoom: var(--lumiverse-ui-scale, 1);\r\n  width:
var(--app-scaled-viewport-width);\r\n  height: calc(var(--app-shell-height) / var(--lumiverse-ui-scale,
1));\r\n}\r\n\r\n/* WebKitGTK's CSS zoom either is unavailable (on older distro runtimes) or\r\n   lays out fixed
descendants incorrectly below 100%. Transform the same\r\n   viewport-sized body, so ALL fixed descendants share its
containing block.\r\n   Transforming each portal separately moves right/bottom anchored surfaces\r\n   off-screen and
gives nested portal wrappers a different origin. */\r\nhtml[data-tauri-desktop][data-platform='linux'] body {\r\n
zoom: 1;\r\n  scale: var(--lumiverse-ui-scale, 1);\r\n  transform-origin: top left;\r\n}\r\n\r\n@supports not (zoom:
1) {\r\n  body {\r\n    scale: var(--lumiverse-ui-scale, 1);\r\n    transform-origin: top left;\r\n
}\r\n}\r\n\r\n#root {\r\n  width: 100%;\r\n  height: 100%;\r\n  display: flex;\r\n  flex-direction:
column;\r\n}\r\n\r\nhtml[data-pwa] {\r\n  width: var(--app-viewport-width);\r\n  height:
var(--app-shell-height);\r\n}\r\n"

      at <anonymous> (<checkout>/front
end\src\components\shared\DesktopWindowChrome.contract.test.ts:38:22)
(fail) desktop window chrome contract > uses the complete Window Controls Overlay rectangle as the safe boundary
```

#### desktop window chrome contract > rounds only the top of the Tauri titlebar and matches Windows window corners  [1.80ms]

```text
Some(NSVisualEffectState::Active),\r\n                        None,\r\n                    ) {\r\n
   eprintln!(\"[desktop-appearance] failed to apply macOS material: {error}\");\r\n                    }\r\n
     }\r\n            })\r\n            .map_err(|error| error.to_string())?;\r\n    }\r\n\r\n    #[cfg(target_os =
\"windows\")]\r\n    {\r\n        use tauri::window::{Effect, EffectsBuilder};\r\n\r\n        // Windows system
backdrops do not expose a blur-radius selection.\r\n        let _ = (dark, blur_intensity);\r\n        if blur {\r\n
         let windows_build = windows_version::OsVersion::current().build;\r\n            let effect = if
supports_windows_system_backdrop(windows_build) {\r\n                // On current Windows 11, Acrylic maps to the
supported\r\n                // DWMSBT_TRANSIENTWINDOW backdrop. The previous Blur effect\r\n                // uses
the legacy ACCENT_ENABLE_BLURBEHIND path, which flickers\r\n                // badly while a window is dragged or
resized on build 22621+.\r\n                Effect::Acrylic\r\n            } else {\r\n                // Older
Windows releases do not have the system-backdrop API.\r\n                // Keep the existing frosted blur there;
Acrylic would also use\r\n                // a legacy accent policy and performs worse on Windows 10.\r\n
  Effect::Blur\r\n            };\r\n            window\r\n
.set_effects(EffectsBuilder::new().effect(effect).build())\r\n                .map_err(|error|
error.to_string())?;\r\n        } else {\r\n            window\r\n                .set_effects(None)\r\n
 .map_err(|error| error.to_string())?;\r\n        }\r\n    }\r\n\r\n    #[cfg(target_os = \"linux\")]\r\n    {\r\n
   // The protocol deliberately leaves the blur algorithm/intensity to the\r\n        // compositor. The page
continues to provide Lumiverse's tint.\r\n        let _ = (dark, blur_intensity);\r\n
crate::wayland_background_effect::set_background_effect(window, blur)?;\r\n    }\r\n\r\n    #[cfg(not(any(target_os =
\"macos\", target_os = \"windows\", target_os = \"linux\")))]\r\n    {\r\n        let _ = (window, blur, dark,
blur_intensity);\r\n    }\r\n\r\n    Ok(())\r\n}\r\n\r\n/// Apply the native material behind an opt-in translucent
frontend theme.\r\n///\r\n/// The document provides the color/tint itself, while the native effect\r\n/// supplies the
platform blur. Unsupported platforms deliberately no-op so\r\n/// the same theme remains usable as a regular
translucent CSS surface.\r\n#[tauri::command]\r\npub fn configure_frontend_appearance(\r\n    app: AppHandle,\r\n
blur: bool,\r\n    dark: bool,\r\n    blur_intensity: Option<String>,\r\n) -> Result<(), String> {\r\n
#[cfg(debug_assertions)]\r\n    eprintln!(\r\n        \"[desktop-appearance] native-effect request: blur={blur},
dark={dark}, intensity={blur_intensity:?}\"\r\n    );\r\n\r\n    let window = app\r\n
.get_webview_window(FRONTEND_LABEL)\r\n        .ok_or(\"Frontend is not open\")?;\r\n
apply_frontend_native_appearance(\r\n        &window,\r\n        blur,\r\n        dark,\r\n
blur_intensity.as_deref().unwrap_or(\"balanced\"),\r\n    )\r\n}\r\n\r\n/// Persist the last resolved page surface and
titlebar palette. It is limited\r\n/// to simple CSS token values and is only used as a non-interactive launch\r\n///
shell before the actual frontend is ready.\r\n#[tauri::command]\r\npub fn cache_frontend_startup_appearance(\r\n
app: AppHandle,\r\n    appearance: FrontendStartupAppearance,\r\n) -> Result<(), String> {\r\n    if
!valid_startup_appearance(&appearance) {\r\n        return Err(\"Invalid frontend startup appearance\".into());\r\n
}\r\n    save_frontend_startup_appearance(&app, &appearance)\r\n}\r\n\r\n#[cfg(test)]\r\nmod tests {\r\n    use
std::path::Path;\r\n\r\n    use super::{\r\n        download_file_name, frontend_startup_shell_script,
is_frontend_popup_label,\r\n        supports_windows_rounded_corners, supports_windows_system_backdrop,
valid_widget_size,\r\n        FrontendStartupAppearance,\r\n    };\r\n\r\n    #[test]\r\n    fn
rounds_only_supported_windows_frames() {\r\n        assert!(!supports_windows_rounded_corners(19_045));\r\n
assert!(!supports_windows_rounded_corners(21_999));\r\n
assert!(supports_windows_rounded_corners(22_000));\r\n\r\n        let appearance =
FrontendStartupAppearance::default();\r\n        let rounded = frontend_startup_shell_script(&appearance,
\"rounded\");\r\n        let square = frontend_startup_shell_script(&appearance, \"square\");\r\n
assert!(rounded.contains(\"border-radius:8px 8px 0 0;overflow:hidden\"));\r\n
assert!(square.contains(\"border-radius:0px 0px 0 0;overflow:hidden\"));\r\n    }\r\n\r\n    #[test]\r\n    fn
selects_system_backdrops_at_window_vibrancy_cutoff() {\r\n
assert!(!supports_windows_system_backdrop(22_522));\r\n        assert!(supports_windows_system_backdrop(22_523));\r\n
      assert!(supports_windows_system_backdrop(26_200));\r\n    }\r\n\r\n    #[test]\r\n    fn
recognizes_only_generated_frontend_popup_labels() {\r\n
assert!(is_frontend_popup_label(\"frontend-popup-1\"));\r\n
assert!(is_frontend_popup_label(\"frontend-popup-2048\"));\r\n
assert!(!is_frontend_popup_label(\"frontend\"));\r\n
assert!(!is_frontend_popup_label(\"frontend-popup-\"));\r\n
assert!(!is_frontend_popup_label(\"frontend-popup-settings\"));\r\n
assert!(!is_frontend_popup_label(\"frontend-popup-1-other\"));\r\n    }\r\n\r\n    #[test]\r\n    fn
download_name_prefers_the_native_destination() {\r\n        let url =
\"http://localhost:3000/characters/123/export\"\r\n            .parse()\r\n            .unwrap();\r\n
assert_eq!(\r\n            download_file_name(&url, Some(Path::new(\"/tmp/Alice.charx\"))),\r\n
\"Alice.charx\"\r\n        );\r\n        assert_eq!(download_file_name(&url, None), \"export\");\r\n    }\r\n\r\n
#[test]\r\n    fn chromeless_widgets_can_contract_to_their_visible_surface() {\r\n
assert!(valid_widget_size(true, 48, 48));\r\n        assert!(!valid_widget_size(false, 48, 48));\r\n
assert!(valid_widget_size(false, 160, 100));\r\n        assert!(!valid_widget_size(true, 23, 48));\r\n
}\r\n}\r\n\r\n/// Show the small native settings window used to configure a cloud frontend.\r\n#[cfg_attr(windows,
tauri::command(async))]\r\n#[cfg_attr(not(windows), tauri::command)]\r\npub fn show_frontend_url_settings(app:
AppHandle) -> Result<(), String> {\r\n    const LABEL: &str = \"frontend-url-settings\";\r\n    if let Some(window) =
app.get_webview_window(LABEL) {\r\n        window.show().map_err(|e| e.to_string())?;\r\n        return
window.set_focus().map_err(|e| e.to_string());\r\n    }\r\n\r\n    let window =
configure_webview_runtime(WebviewWindowBuilder::new(\r\n        &app,\r\n        LABEL,\r\n
WebviewUrl::App(\"custom-url.html\".into()),\r\n    ))\r\n    .title(\"Instance Connection\")\r\n
.inner_size(560.0, 480.0)\r\n    .min_inner_size(560.0, 480.0)\r\n    .max_inner_size(560.0, 480.0)\r\n
.resizable(false)\r\n    .center()\r\n    .build()\r\n    .map_err(|e| e.to_string())?;\r\n
window.set_focus().map_err(|e| e.to_string())\r\n}\r\n"

      at <anonymous> (<checkout>/front
end\src\components\shared\DesktopWindowChrome.contract.test.ts:70:29)
(fail) desktop window chrome contract > rounds only the top of the Tauri titlebar and matches Windows window corners
```

### frontend/src/components/panels/image-gen-connections/ImageGenConnectionManager.test.tsx

Module loading fails before test execution: @dnd-kit/core getClientRect named export is unavailable. Check installed dependency resolution and Bun ESM/CJS interop; the same error affects ConnectionManager.active-profile.test.tsx.

Reproduce: `bun test --isolate frontend/src/components/panels/image-gen-connections/ImageGenConnectionManager.test.tsx`

#### (unnamed) [8.44ms]

```text
SyntaxError: Export named 'getClientRect' not found in module '<frontend-node_modules>/@dnd-kit\core\dist\index.js'.
(fail) (unnamed) [8.44ms]
```

### frontend/src/components/panels/ConnectionManager.active-profile.test.tsx

Same DnD module-loading error described below; no test body executes.

Reproduce: `bun test --isolate frontend/src/components/panels/ConnectionManager.active-profile.test.tsx`

```text
# Unhandled error between tests
-------------------------------
SyntaxError: Export named 'getClientRect' not found in module '<frontend-node_modules>/@dnd-kit\core\dist\index.js'.
-------------------------------


```

## Raw reported summary

```text
20 tests failed:
(fail) automatic maintenance outbox sweep > tick dispatches a never-attempted pending row once its backoff elapses
[3043.40ms]
(fail) POST /:chatId/edit-and-send > commits a historical branch and dispatches only the copied assistant identity
[20.76ms]
(fail) POST /:chatId/edit-and-send > accepts in-place mode and dispatches the source chat and source assistant [5.64ms]
(fail) deferred image processing > uses Sharp AVIF thumbnails when the operator codec is enabled [239.21ms]
(fail) frontend/backend H4 registry mirror > built-in drawer ids stay in sync [1.77ms]
(fail) Bun-native image pipeline > writes AVIF output through Sharp [12.85ms]
(fail) resolveLanceDbConnectUri > uses a cwd-relative path for Termux workspaces [1.01ms]
(fail) resolveLanceDbConnectUri > does not manufacture a stripped Termux path when cwd is root [0.21ms]
(fail) resolveLanceDbConnectUri > uses a parent-relative path when the database is outside the cwd [0.15ms]
(fail) resolveLanceDbConnectUri > uses a parent-relative path for Termux data dirs outside the repo [0.11ms]
(fail) resolveLanceDbConnectUri > uses a parent-relative path when running in proot-distro [0.13ms]
(fail) resolveLanceDbConnectUri > resolves the broken Termux mirror path created by a stripped leading slash [0.17ms]
(fail) resolveLanceDbConnectUri > resolves the broken Termux mirror path for parent-relative data dirs [0.14ms]
(fail) Spindle generation records the host's extension identity instead of input claims [8.15ms]
(fail) (unnamed) [7349.71ms]
  ^ a beforeEach/afterEach hook timed out for this test.
(fail) controlled Loom cases pass in an isolated module graph [3422.93ms]
(fail) desktop window chrome contract > uses the complete Window Controls Overlay rectangle as the safe boundary
[1.86ms]
(fail) desktop window chrome contract > rounds only the top of the Tauri titlebar and matches Windows window corners
[1.80ms]
(fail) (unnamed) [8.44ms]

 5296 pass
 20 fail
 1 error
 62167 expect() calls
Ran 5316 tests across 707 files. [304.68s]
```

## Investigation limits

- Remaining ordinary-terminal failures have not all been individually rerun on current clean staging outside the sandbox.
- Loom wrapper hides its child diagnostics, so its actual child failure is still unknown.
- Hook timeout does not prove an application defect; inspect setup and teardown independently.
- AVIF metadata mismatch does not establish invalid output or codec absence.
- Native folder/tag modal UI is not implemented at the time of this run; this run validates backend/API additions and existing UI regressions. Desktop/mobile organization acceptance requires the forthcoming UI and controlled runtime fixtures.
