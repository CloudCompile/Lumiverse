# Lumiverse Desktop (Experimental)

An experimental Tauri-powered Lumiverse desktop app for macOS, Windows, and
Linux. It opens Lumiverse in an integrated native WebView and keeps a tray
icon available for server controls, status, and updates.

The integrated browser is the primary experience: when Lumiverse Desktop starts
its local server, it opens the native Lumiverse window. The tray menu can hide,
reopen, or reload that window, and can still open the same address in your
default browser when needed.

Under the hood it spawns the existing runner in a headless mode
(`bun scripts/runner.ts --headless`) and drives it over stdio with the same
message shapes the web Operator panel uses. No extra ports or sockets are
opened; when the tray app exits, the runner sees its stdin close and shuts
the server down gracefully.

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
  update flow.
- **Start Local Server at Launch** — start the local server automatically when the
  tray app opens (on by default).
- **Launch at Login** — register the tray app as a login item.
- **Set Lumiverse Folder…** — point the app at a different checkout.
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
- **Windows:** WebView2 Runtime (preinstalled on Windows 11) and the MSVC
  build tools.
- **Linux:** GTK/WebKitGTK development libraries plus an AppIndicator
  implementation. The helper publishes its tray icon through the
  StatusNotifierItem/AppIndicator D-Bus protocol.

  Debian/Ubuntu:

  ```bash
  sudo apt install build-essential curl wget file libssl-dev \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
    librsvg2-dev libxdo-dev gstreamer1.0-tools \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good
  ```

  Fedora:

  ```bash
  sudo dnf install gcc gcc-c++ make curl wget file openssl-devel \
    webkit2gtk4.1-devel libappindicator-gtk3-devel \
    librsvg2-devel libxdo-devel gstreamer1 \
    gstreamer1-plugins-base gstreamer1-plugins-good
  ```

  Arch Linux:

  ```bash
  sudo pacman -S --needed base-devel curl wget file openssl \
    webkit2gtk-4.1 libappindicator-gtk3 librsvg libxdo \
    gstreamer gst-plugins-base gst-plugins-good
  ```

  Package names vary by distribution. `libayatana-appindicator3-dev` may be
  substituted with the distribution's `libappindicator` development package.
  The GStreamer plugin sets are copied into AppImage builds so WebKit's audio
  support does not depend on host plugins hidden by the AppImage launcher.
  The other packages are build dependencies; a machine running an unpackaged
  Linux binary also needs the matching AppIndicator runtime library.

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
outside a checkout starts unconfigured and prompts for the folder; use
"Set Lumiverse Folder…" in the menu to change it at any time.

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

On Linux, Tauri bundles the GStreamer media framework needed by WebKit audio.
The finalizer verifies the audio plugins and their AppRun search paths, removes
the build runner's `libwayland-client` so Mesa and EGL use the host display
stack, then extracts and checks the finished image before the build succeeds.
Other bundle formats and platforms pass through unchanged.

Bundles land in `desktop/src-tauri/target/release/bundle/` (`.app`/`.dmg`
on macOS, `.msi`/`.exe` installers on Windows, and Linux packages such as
`.deb`, `.rpm`, or `.AppImage` when built on Linux).

## Automated releases

Installers are built for Windows x64 (`.exe`/`.msi`), Windows ARM64
(`.exe`, NSIS-only — WiX/MSI has no ARM64 support, cross-compiled on the x64
Windows runner), Linux x64 and ARM64 (`.AppImage`/`.deb`, built natively on
Ubuntu 22.04), and separate macOS Apple Silicon and Intel (`.dmg`).

- **`desktop-build.yml` — version-bump builds.** Pushes to any branch other
  than `main` trigger a build when a desktop version manifest or `Cargo.lock`
  changes. Results are downloadable workflow artifacts; no release is created.
  Manual dispatch works the same way.
- **`desktop-release.yml` — staging → main merges.** Merging a `staging` PR
  that touches `desktop/**` into `main` builds fresh installers from the merge
  commit and attaches them to a `desktop-v<version>` release on GitHub,
  creating it if missing and pinning it to the merge commit. Reruns replace
  matching assets; if any platform build fails, nothing is attached.
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

## License

Lumiverse Desktop is covered by the project's
[Lumiverse Community License 2.1](../LICENSE.md). Cargo and the installer
configuration reference that canonical file; desktop bundles include it as
`LICENSE.md`. Third-party dependencies retain their own licenses.
