# Lumiverse Desktop (Experimental)

An experimental Tauri-powered Lumiverse desktop app for macOS, Windows, and
Linux. It opens Lumiverse in an integrated native WebView and keeps a tray
icon available for server controls, status, and updates.

Signed bundled updates restore the session after the app restarts. A local
server that was running (or starting) starts again,
even if **Auto-start Server** is disabled. A stopped server stays stopped for
that restart. The integrated browser reopens only if it was visible at the
installer handoff; a hidden browser stays hidden. These one-time choices also
apply to a fallback relaunch if installation fails, and do not change saved
auto-start preferences. Remote browsers reopen on the selected remote instance;
externally managed local servers are not restarted by Desktop.

The integrated browser is the primary experience: when Lumiverse Desktop starts
its local server, it opens the native Lumiverse window. The tray menu can hide,
reopen, or reload that window, and can still open the same address in your
default browser when needed.

On Windows, Desktop explicitly hides each WebView2 rendering surface while its
window is hidden or minimized, or the session's display is off. Rendering returns
when both the display and that window are visible; waking the display does not
restore hidden or minimized windows. Dimmed displays and unfocused visible
windows continue rendering. This applies to the browser, floating widgets, and
desktop dialogs without reloading pages or explicitly suspending scripts.

The built-in instance uses the packaged Bun server. Existing checkouts use the
headless source runner (`bun scripts/runner.ts --headless`). Both communicate
with the tray over a private stdio channel, and exiting the desktop stops the
server processes it owns.

## Menu

- **Status line** — running / stopped / starting / crashed, or
  "running (external)" when a server started from a terminal is detected
  on the configured port.
- **Start Server / Stop Server**
- **Browser** — opens or closes the integrated Tauri browser. Its submenu also
  reloads it or opens the current address in your default browser. Closing the
  integrated browser also closes its active floating widgets.
  For a remote instance, this submenu also provides sign-in and sign-out.
- **Floating Widgets** — lists live extension widgets registered by Lumiverse
  (for example, SpotifyControls). Selecting one starts that extension in a
  widget-only native window.
- **Serving Stats** — port, PID, uptime, branch, version.
- **Check for Updates / Apply Update** — the runner's existing git-based
  update flow, available when using an existing checkout.
- **Desktop Updates** — check the selected stable/nightly channel and install a
  signed release of the entire app, including its built-in server. Available
  when using a remote instance too. The app checks on launch and every six hours;
  download and installation require choosing **Update and restart**. Debug
  profiles and builds without the release signing public key disable installation.
- **Start Local Server at Launch** — start the local server automatically when the
  tray app opens (on by default).
- **Launch at Login** — register the tray app as a login item.
- **Let Extensions Analyse System Audio** — off by default (Windows, macOS 14.2+, and
  Linux with `parec`). Lets extensions
  you have granted the `system_audio` permission see levels and a frequency
  spectrum of what the computer is playing, never the audio itself. The item
  and the tray tooltip show when an extension is listening; unchecking it ends
  every session. See [System audio](../developer-docs/docs/frontend-api/system-audio.md#native-adapters).
- **Open Lumiverse Data Folder** — open the active local server's data directory
  in Finder, Explorer, or the system file manager. Available only in local mode,
  including when the server is stopped; follows custom paths and debug profiles.
- **Instance Connection…** — use the local server or connect to a remote
  Lumiverse origin.

## Remote instances

Choose **Instance Connection…**, enter the remote Lumiverse origin, and sign in
in the system browser. Remote origins require HTTPS; plain HTTP is accepted only
for loopback development. Add the public HTTPS origin under **Settings →
Operator → Trusted Hostnames**, then restart the server so it can advertise that
origin as its OAuth issuer. `AUTH_BASE_URL` remains available as an optional
single-origin override, but it is not required. Desktop uses authorization-code PKCE and stores only
the refresh credential in the operating system credential store. Access tokens
remain in native memory and are never exposed to the remote WebView.

When Lumiverse terminates TLS directly with `LUMIVERSE_TLS_CERT_FILE` or
`LUMIVERSE_TLS_CONFIG_FILE`, forwarded headers are not needed. When TLS
terminates at a reverse proxy, preserve `Host`. If the proxy replaces
it, send `X-Forwarded-Host` and `X-Forwarded-Proto` and list the proxy IP or
CIDR in `TRUSTED_PROXIES`. Lumiverse ignores those identity-sensitive headers
from unlisted peers.

All signed-in accounts can see the instance identity and their own role. Serving
status remains restricted to Lumiverse administrators and owners. Local server,
checkout, and update controls are disabled while a remote instance is selected.

## Extension screen capture

The capture device named **Lumiverse Desktop** represents this client, not a
restriction to its own window. On macOS, requests open the system picker directly,
initially in **Entire Display** mode, with both displays and windows allowed.
The capture menu-bar icon also offers **Choose a Window…** and **Choose a Display…**.
For Window, bring the other application's window into view and select it using the
macOS overlay. Any explicitly opened capture controls and
Lumiverse windows are excluded from window selection. Full-display capture can
include visible Lumiverse windows and other sensitive content: use **Review Before
Sending** when local inspection is needed. There is no always-on screen buffer.

The macOS development executable embeds `src-tauri/Info.plist` to retain the
packaged application's bundle identifier. Restart `bun run tauri dev` after
changes to this metadata.

On macOS 14+ or Windows 10 1903+/Windows 11, choose
**Browser → Enable Extension Screen Capture…**. This signs
the native client into the selected local or remote instance if necessary; it
does not reuse browser cookies. An extension still needs explicitly granted
`screen_capture`/`screen_recording` and `generation` permissions.

Every request opens the OS source picker directly. On macOS there is no Lumiverse
recording popup: a temporary camera/recording menu-bar item provides the request
identity, destination, countdown and **Stop & Discard**, alongside macOS's sharing
controls. **Capture Details & Permissions…** opens recovery controls only on an
explicit owner action; optional review likewise opens a preview only when requested.
Windows uses its system picker for either an application window or display, with
a compact native identity/destination and stop HUD. Full Windows consent details
live under **Details…**. Recording does not foreground the main app window. Selecting
a source authorizes this one image or bounded clip and its release to the displayed
instance/model. After capture and validation, the extension receives an opaque
asset for processing automatically; no second Send click is needed. Every request
still requires native source selection; no approval or target is remembered.
**Review Before Sending** optionally pauses release for a compact local preview
and **Share This Capture**, for this request only. **Stop & Discard** or closing
an explicitly opened capture window before release uploads nothing. Capture stays disabled
at launch, and must be re-enabled after transport failure. Instance changes and
desktop OAuth sign-out stop it.

Images stay in native memory. Both adapters record video-only H.264 MP4, at most
1080p/30fps and 30 seconds; oversized output is discarded before sharing.

- **macOS:** ScreenCaptureKit plus hardware-required VideoToolbox/AVAssetWriter
  encoding. An owner-only temporary MP4 is removed after preview/share/discard.
  If a hardware encoder is unavailable, only screenshots are advertised; software
  fallback is forbidden. Building requires a macOS 15+ SDK; runtime requires macOS 14+.
- **Windows:** Windows Graphics Capture's system picker and hardware D3D11
  surfaces, with a two-frame pool. MediaTranscoder requests hardware acceleration
  and stores the MP4 in memory, including native playback preview. Windows may
  choose a software encoder; the consent panel discloses this rather than claiming
  a verified hardware-only encoder. Source closure/resizing, screen lock/logoff,
  session disconnect, sleep, and transport cancellation discard the request.
- **Linux and rolling replay buffers:** not implemented or advertised. Windows
  **Replay Clip** only replays the already-recorded local preview; it does not
  arm an always-on capture buffer.

Tokens, media, and capture paths never cross WebView IPC. See
`developer-docs/docs/getting-started/desktop-capture.md` for the protocol,
security boundaries, and on-device acceptance checks.

### macOS permission recovery

The system sharing picker remains the default; it authorizes the selected source
without requiring app-wide Screen Recording access. If it only offers Lumiverse's
window, use the capture menu-bar icon → **Capture Details & Permissions… → Grant
Screen Recording Access…**. This
is a local owner action, never an extension or frontend permission request.
If needed, **Open Screen Recording Settings…** opens **System Settings → Privacy &
Security → Screen & System Audio Recording**. Enable the requesting app, restart
the desktop client if macOS asks, and start a new request; capture never resumes
automatically. Despite the privacy pane's name, system audio and microphone capture
remain disabled.

With app-wide access granted, **Choose From Permissioned Source List…** offers
entire displays and other applications' visible windows in a native dropdown.
Nothing is selected automatically: choose a target and press **Capture Selected
Source** to authorize that one capture and send. **Review Before Sending** is
optional, not a mandatory release step. The permission is
checked before capture, during the request, and before sharing; revocation discards
the capture. Source names and IDs never reach the extension. **Use macOS Picker
Instead** returns to scoped OS selection without using app-wide access.

Tauri development runs a plain executable, not a `.app` bundle. Embedding the
bundle identifier does not guarantee that macOS will list this executable as
Lumiverse Desktop in its privacy pane; a development launcher can be attributed
instead. Prefer testing a bundled debug app rather than granting broader access
to Terminal or your editor:

```bash
cd desktop
bun run tauri build --debug --bundles app -- --offline --locked
```

Quit the development client before opening
`src-tauri/target/debug/bundle/macos/Lumiverse Desktop.app`, and explicitly re-enable
extension capture there. Native diagnostic lines prefixed `[Lumiverse capture]`
report app identity, permission state, selected source style, and error domain/code,
not window names, screen contents, credentials, or model prompts.

The extension's **Desktop device** dropdown lists native client registrations,
not screens or windows. Target selection happens only in the native OS picker
after **Share**. Rebuilding/restarting can briefly leave an old registration until
its 45-second lease expires; refresh the extension's configuration after that.
Two active clients can also have the same display name, so registrations must not
be merged just because both are called Lumiverse Desktop.

### Windows live testing

From an x64 Visual Studio Developer PowerShell with the Windows SDK, Rust/MSVC,
Bun, and WebView2 installed, run from the repository root:

```powershell
bun install --frozen-lockfile
cd desktop
bun install --frozen-lockfile
bun run build
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml capture::
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml webview_visibility::
bun run tauri dev
```

Enable capture in the tray, grant the test extension `screen_capture`,
`screen_recording`, and `generation`, then request an image and 1–30-second clips
against a model that supports the selected media type. Confirm picker selection,
native preview/playback, explicit Share versus Discard, and cancellation on lock,
permission revocation, and instance/transport changes. A Windows N edition may
need the Media Feature Pack for recording/playback. Check GPU video-encode
activity on the actual device; enabling hardware acceleration does not prove
that Windows selected a hardware encoder. No recording file is written by this
adapter; memory may still be paged by the OS. Full on-device acceptance remains
required before release.

For WebView rendering, compare idle GPU activity before and after display sleep,
then repeat with the browser minimized and hidden. Confirm that restoring or
reopening it paints immediately, and that waking the display leaves hidden or
minimized windows in their existing state. Include floating widgets, a streaming
reply, page reloads, and closing/recreating the browser in this check.

## Translucent frontend themes

The Tauri frontend window is transparent, so a theme can tint the document
with an alpha color and optionally request the native material behind it:

```json
{
  "desktopBackground": {
    "color": "rgb(16 12 28 / 72%)",
    "blur": true
  }
}
```

`blur` uses macOS vibrancy and the supported Desktop Acrylic system backdrop on
current Windows 11 builds. Older Windows releases retain the legacy DWM blur
fallback. On other platforms, or when native material is unavailable, the theme
keeps its regular translucent CSS surface. Browser and PWA rendering ignore this
desktop-only setting.

## Run a prebuilt Linux AppImage

The release AppImage already contains the compiled Rust shell, its GTK 3 /
WebKitGTK 4.1 libraries, and the GStreamer plugins used for browser audio.
Running it does **not** require Cargo, a Rust toolchain, a system WebKitGTK
package, or system GStreamer plugins. Lumiverse Desktop still requires
[Bun](https://bun.sh) ≥ 1.4.2 and a Lumiverse checkout because the desktop
companion does not bundle the server.

Download the artifact matching the machine (`amd64`/`x86_64` for most PCs or
`aarch64` for ARM64), then run it from a terminal once so startup errors remain
visible:

```bash
chmod +x Lumiverse*.AppImage
./Lumiverse*.AppImage
```

The app starts as a tray application. KDE Plasma exposes its StatusNotifier
item in the system tray; it does not open a normal taskbar window until the
server is ready. Use `pgrep -af lumiverse-tray` to distinguish a hidden running
process from an early startup failure.

If the AppImage reports a FUSE error, either install Arch's `fuse2` package or
use the AppImage runtime's extract-and-run fallback:

```bash
sudo pacman -S --needed fuse2
APPIMAGE_EXTRACT_AND_RUN=1 ./Lumiverse*.AppImage
```

On Wayland, Lumiverse automatically selects the native GTK backend when no X11
display is available. If KDE advertises an XWayland display but that path still
fails, force native Wayland without relying on the `GDK_BACKEND` value that
older Tauri AppImage launchers overwrite:

```bash
LUMIVERSE_GDK_BACKEND=wayland ./Lumiverse*.AppImage
```

WebKitGTK 6.0 is the GTK 4 API and does not replace WebKitGTK 4.1/GTK 3. Neither
needs to be installed separately for the AppImage; source builds require the
4.1 package shown below.

## Source-build prerequisites

Run `bun run desktop:doctor` from the repository root to check all build
requirements at once. It reports what is missing and the exact command to
install it.

- [Bun](https://bun.sh) ≥ 1.4.2 (also required by the server itself)
- [Rust](https://rustup.rs) stable (Tauri v2 builds the native shell)

Platform-specific build requirements:

- **macOS:** Xcode Command Line Tools.
- **Windows:** WebView2 Runtime (preinstalled on Windows 11) and Visual Studio
  Build Tools with **Desktop development with C++**, including the MSVC C++
  compiler and Windows SDK. The scripted build locates the installed toolset
  and initializes its linker environment; a normal PowerShell window is fine.
  If the MSVC check fails, verify the C++ workload in Visual Studio Installer
  or run `where link.exe` from the x64 Native Tools Command Prompt. In
  PowerShell, use `where.exe link.exe` (`where` is a PowerShell alias).
- **Linux:** GTK/WebKitGTK development libraries plus an AppIndicator
  implementation. The helper publishes its tray icon through the
  StatusNotifierItem/AppIndicator D-Bus protocol.

  Debian/Ubuntu:

  ```bash
  sudo apt install build-essential curl wget file libssl-dev \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
    librsvg2-dev libxdo-dev gstreamer1.0-tools \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good squashfs-tools
  ```

  Fedora:

  ```bash
  sudo dnf install gcc gcc-c++ make curl wget file openssl-devel \
    webkit2gtk4.1-devel libappindicator-gtk3-devel \
    librsvg2-devel libxdo-devel gstreamer1 \
    gstreamer1-plugins-base gstreamer1-plugins-good squashfs-tools
  ```

  Arch Linux:

  ```bash
  sudo pacman -S --needed base-devel curl wget file openssl \
    webkit2gtk-4.1 libappindicator-gtk3 librsvg libxdo \
    gstreamer gst-plugins-base gst-plugins-good squashfs-tools
  ```

  Package names vary by distribution. `libayatana-appindicator3-dev` may be
  substituted with the distribution's `libappindicator` development package.
  The GStreamer plugin sets are copied into AppImage builds so WebKit's audio
  support does not depend on host plugins hidden by the AppImage launcher.
  `unsquashfs` from `squashfs-tools` verifies the finished AppImage's stored
  permissions; the runtime's extraction command creates private directories
  and does not preserve their packaged modes.
  The other packages are build dependencies; a machine running an unpackaged
  Linux binary also needs the matching AppIndicator runtime library.

  Optional at runtime: extension system-audio analysis on Linux uses `parec`
  (`pulseaudio-utils`, or `pipewire-pulse` on PipeWire systems). Without it the
  feature reports "unsupported" and nothing else changes.

  GNOME Shell does not show StatusNotifier items by default, so install and
  enable an AppIndicator/KStatusNotifier extension (for example,
  **AppIndicator and KStatusNotifierItem Support**).

## Develop

```bash
cd desktop
bun install
bun run tauri dev
```

The app discovers the checkout it lives in at runtime (dev builds run
from `desktop/src-tauri/target/…`, so the repo above them is found
automatically — no path is baked into the binary). An installed copy
outside a checkout starts unconfigured and opens the instance selector; use
**Browser → Instance Connection… → Existing checkout** to change the folder.

Each backend start or restart gets a timestamped `server-*.log` in the platform
app-log directory (macOS: `~/Library/Logs/chat.lumiverse.tray/`; Windows:
`%LOCALAPPDATA%\\chat.lumiverse.tray\\logs\\`; Linux:
`${XDG_DATA_HOME:-~/.local/share}/chat.lumiverse.tray/logs/`). Launcher output
before the first server start is kept in a timestamped `launcher-*.log`. Each
file is capped at 10 MiB and only the 12 newest launcher/server logs are
retained. In a development build, `bun run tauri dev` also mirrors output to
its terminal, including server startup failures.

## Build

For a normal scripted install from the repository root, use:

```bash
./start.sh --install-desktop
```

On Windows, run `.\start.ps1 -InstallDesktop` instead. The launcher checks the
native toolchain, builds the Tauri bundle, installs it in the platform's normal
application location, and creates the platform launcher plus a desktop
shortcut when that folder is available. `--desktop` and `-Desktop` are shorter
aliases.

An existing Lumiverse Desktop process is stopped immediately before the new
bundle is installed. The shutdown includes its runner/server process tree and
the install aborts instead of overwriting files if that process cannot be
stopped.

On macOS, the app is installed in `/Applications` so Spotlight and the system
Applications interface discover it normally. macOS may request administrator
approval while staging the app there. The installer also removes the obsolete
`~/Applications/Lumiverse Desktop.app` location used by early builds so
LaunchServices cannot reopen a stale duplicate after an update.

On Windows, this command also downloads the official architecture-matched
`rustup-init.exe` and installs the minimal stable Rust toolchain automatically
when `cargo` is missing. `bun run desktop:doctor` remains available when you
only want to inspect prerequisites or follow the manual installation path.

To build bundles without installing them:

```bash
cd desktop
bun install
bun run tauri:finalized build
```

On Windows, run these manual commands from the appropriate Visual Studio
Developer Command Prompt (x64 Native Tools for an x64 build), so `link.exe`
and the SDK are available. `\.\start.ps1 -InstallDesktop` configures the
installed toolchain automatically when run from an ordinary PowerShell window.

On Linux, Tauri bundles the GStreamer media framework needed by WebKit audio.
The finalizer verifies the audio plugins and their AppRun search paths, removes
the build runner's `libwayland-client` so Mesa and EGL use the host display
stack, then extracts and checks the finished image before the build succeeds.
Other bundle formats and platforms pass through unchanged.

Bundles land in `desktop/src-tauri/target/release/bundle/` (`.app`/`.dmg`
on macOS, `.exe` installers on Windows, and `.AppImage` on Linux).

## Automated releases

Bundled releases support Windows x64/ARM64 (NSIS `.exe`), Linux x64/ARM64
(`.AppImage` only), and macOS Apple Silicon/Intel (`.dmg`, plus the signed
`.app.tar.gz` used by the updater). Each includes the tested standalone server.

- **`desktop-nightly-scheduler.yml`** runs on `main` daily at 05:23 UTC and
  dispatches **`desktop-build.yml`** on `staging` with `bundled_nightly=true`.
  GitHub only evaluates cron on the default branch, so keep the scheduler on
  `main` and merge that change back into `staging`.
- **`desktop-nightly.yml`** prepares the bundled release from `staging`. It skips
  the build if bundled source matches the last successful nightly. A new build
  gets the next desktop patch version with `-nightly.<date>.<run>` appended.
- **`desktop-release.yml`** publishes stable `desktop-vX.Y.Z` tags from `main`;
  manual dispatch publishes the committed version from `main`. The tag must
  match the desktop manifests and stable versions must increase, including
  releases with only bundled server changes.
- Both call **`server-bundle.yml`**, which builds/tests all six native targets,
  uploads signed assets directly to a draft GitHub Release, and advances the
  selected channel feed only after every platform passes. Release payloads
  use version-pinned URLs. Existing published payloads are not replaced.
- **`desktop-build.yml`** retains checkout-based feature-branch installer tests
  and keeps their workflow artifacts for three days. `main` and `staging` use
  the bundled release cycle instead of running duplicate installer builds.
- Desktop versioning is independent of server release tags. One command keeps
  the four version-bearing files in sync:

  ```bash
  bun run desktop:version 0.3.0
  ```

  This rewrites `desktop/package.json`, `src-tauri/Cargo.toml`, and
  `src-tauri/tauri.conf.json`, then refreshes `src-tauri/Cargo.lock` through
  `bun run desktop:lock` — cargo is the lockfile's only writer, never edit it
  by hand. Commit the four changed files together; CI checks the locked
  dependency resolution and version agreement before starting any platform
  builds.

Configure the updater signing key before activating releases. The public key is
the repository variable or secret `LUMIVERSE_UPDATER_PUBLIC_KEY`; the private key and its
password belong in `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. The public key is
compiled into the app. See [desktop updates](../developer-docs/docs/getting-started/desktop-updates.md)
for key setup, channel behavior, publication recovery, and storage policy.

## License

Lumiverse Desktop is covered by the project's
[Lumiverse Community License 2.1](../LICENSE.md). Cargo and the installer
configuration reference that canonical file; desktop bundles include it as
`LICENSE.md`. Third-party dependencies retain their own licenses.

## Self-contained staging build

The experimental bundled-server installer includes its own Bun server and
first offers a built-in server, an existing checkout, or a remote connection.
Choosing the built-in server
opens a three-step first-run wizard in a local Tauri window. Account,
server/storage, and review steps support Back navigation; Save and the folder
picker use native IPC callbacks. The tray owns the packaged server process.

After installing the repository, frontend, and desktop build dependencies:

```sh
bun run build:desktop-server
```

Intel Mac builds require the version-matched native engine first:

```sh
# Requires Xcode command-line tools and rustup.
brew install protobuf cmake
bun run build:lancedb:macos
bun run build:desktop-server
```

Staging CI builds and tests the engine and bundled app on `macos-15-intel`.
The Intel installer includes LanceDB; end users do not need a Rust toolchain
or a separate database installation. Bundled macOS apps require macOS 13 or later.

For a clean debug run that preserves your regular desktop settings and remote
session, build the separate **Lumiverse Desktop Debug** app:

```sh
APPLE_SIGNING_IDENTITY=- bun run build:desktop-server --reuse-server --debug --bundles app -- --locked
open -n "desktop/src-tauri/target/debug/bundle/macos/Lumiverse Desktop Debug.app" --args --profile setup-test-1
```

Quit the debug app before restarting it with another profile. Reusing the name
resumes that test profile; a new name starts fresh without deleting anything.
Names accept 1–48 lowercase letters, digits, or hyphens. Debug builds have their
own app identity even without `--profile`; named profiles additionally isolate
settings, WebView storage, native OAuth credentials, and local server files.
The debug local server defaults to port 17860 and a data directory inside the
profile's app data. Its setup wizard can change those settings.

Use **Browser → Instance Connection…** to switch between remote and local.
Switching retains the last remote address and its saved credentials. Only the
explicit remote sign-out action removes the saved credential.

**Existing checkout** uses the folder's source runner, configuration, account,
and data, with the existing update and desktop rebuild controls. Browse to the
checkout and choose **Use existing checkout**; this path requires an installed
Bun runtime and the checkout's normal dependencies. It bypasses the built-in
owner setup wizard. If that checkout is already serving its configured port,
the app opens it instead of starting another server. Externally started servers
remain owned by their terminal or service.

Existing saved checkout selections continue automatically after installing a
bundled app. An explicit choice of the built-in server takes precedence, while
the saved checkout folder remains available for switching back. Select or change
a checkout through **Browser → Instance Connection…** in the tray. A clean debug
profile asks you to select its checkout explicitly; checkout reuse runs against
that folder's actual data, while built-in debug servers use isolated profile data.

To transfer a checkout's data to the built-in server, stop both servers and use
**Open Lumiverse Data Folder** in local mode to open the destination. Back up
the destination, then replace its contents with the entire old data folder,
including hidden files, `lumiverse.identity`, databases, and owner credentials.
Start the built-in server again and sign in with the old instance's account.
This action opens storage; it does not change the selected instance or checkout.

See the [bundled server guide](../developer-docs/docs/getting-started/bundled-server.md)
for staging downloads, supported architectures, storage, and acceptance tests.
