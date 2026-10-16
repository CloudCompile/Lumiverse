#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bundle_dir="${1:?usage: smoke-test-appimage.sh <bundle-directory>}"
if [[ ! -d "$bundle_dir" ]]; then
  echo "AppImage bundle directory does not exist: $bundle_dir" >&2
  exit 1
fi
bundle_dir="$(cd "$bundle_dir" && pwd)"

appimages=()
while IFS= read -r -d '' candidate; do
  appimages+=("$candidate")
done < <(find "$bundle_dir" -maxdepth 1 -type f -name '*.AppImage' -print0)

if [[ ${#appimages[@]} -eq 0 ]]; then
  echo "No AppImage found in $bundle_dir" >&2
  exit 1
fi

appimage="${appimages[0]}"
for candidate in "${appimages[@]:1}"; do
  if [[ "$candidate" -nt "$appimage" ]]; then
    appimage="$candidate"
  fi
done
chmod +x "$appimage"

log_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
log_file="$log_root/lumiverse-appimage-smoke.log"
# Use /tmp so the test user can traverse the parent directories independently
# of permissions on the checkout or the runner's home directory.
inspection_dir="$(mktemp -d /tmp/lumiverse-appimage-inspect.XXXXXX)"
smoke_home="$(mktemp -d /tmp/lumiverse-appimage-home.XXXXXX)"
trap 'rm -rf "$inspection_dir"; sudo -n rm -rf -- "$smoke_home"' EXIT
chmod a+rx "$inspection_dir"

# Preserve the SquashFS permission bits for the cross-user launch check.
# The runtime's --appimage-extract creates private (0700) directories instead.
if ! command -v unsquashfs >/dev/null 2>&1; then
  echo "unsquashfs is required for the AppImage smoke test (install squashfs-tools)." >&2
  exit 1
fi
runtime_size="$("$appimage" --appimage-offset)"
if [[ ! "$runtime_size" =~ ^[0-9]+$ ]] || [[ "$runtime_size" -le 0 ]]; then
  echo "Could not determine the AppImage runtime size" >&2
  exit 1
fi
unsquashfs -no-progress -offset "$runtime_size" \
  -dest "$inspection_dir/squashfs-root" "$appimage" >/dev/null
bash "$script_dir/verify-appimage-permissions.sh" "$inspection_dir/squashfs-root"
bundled_wayland=()
while IFS= read -r -d '' candidate; do
  bundled_wayland+=("$candidate")
done < <(find "$inspection_dir/squashfs-root" \( -type f -o -type l \) -name 'libwayland-client.so*' -print0)
if [[ ${#bundled_wayland[@]} -gt 0 ]]; then
  printf 'AppImage bundles libwayland-client and can conflict with the host Mesa/EGL stack:\n' >&2
  printf '  %s\n' "${bundled_wayland[@]}" >&2
  exit 1
fi
bash "$script_dir/verify-appimage-gstreamer.sh" "$inspection_dir/squashfs-root"

mkdir -p "$smoke_home/config" "$smoke_home/cache" "$smoke_home/data" "$smoke_home/runtime"
sudo -n chown -R "nobody:$(id -gn nobody)" "$smoke_home"
sudo -n chmod 700 "$smoke_home/runtime"

# linuxdeploy must retain the exact tested Bun executable. Its ARM64 RPATH
# rewrite can break the server even when the desktop itself still starts.
server="$inspection_dir/squashfs-root/usr/bin/lumiverse-server"
if [[ -f "$server" ]]; then
  case "$(uname -m)" in
    x86_64) server_arch=x64 ;;
    aarch64) server_arch=arm64 ;;
    *) echo "Unsupported bundled server architecture" >&2; exit 1 ;;
  esac
  original_server="$script_dir/../dist/server/lumiverse-server-linux-$server_arch"
  if ! cmp -s "$original_server" "$server"; then
    echo "AppImage changed the tested Bun server executable" >&2
    exit 1
  fi
  server_log="$log_root/lumiverse-appimage-server-smoke.log"
  if ! sudo -n unshare --net -- runuser -u nobody -- env -i \
    HOME="$smoke_home" PATH=/usr/bin:/bin LANG=C.UTF-8 TMPDIR="$smoke_home" \
    XDG_CONFIG_HOME="$smoke_home/config" XDG_CACHE_HOME="$smoke_home/cache" \
    XDG_DATA_HOME="$smoke_home/data" \
    timeout --kill-after=5s 180s "$server" --check >"$server_log" 2>&1; then
    cat "$server_log" >&2
    echo "Packaged server failed its offline native and subprocess checks" >&2
    exit 1
  fi
  echo "Packaged Bun server is unchanged and passes offline checks as another user."
fi

set +e
(
  cd /
  # A separate network namespace has no external connectivity. Execute the
  # extracted launcher as a different user to preserve the mounted-image
  # ownership boundary: extract-and-run as the owner would hide mode 0770.
  # A fresh HOME and system-only PATH also exercise first launch without Bun,
  # a checkout, saved authorization, or the build user's settings.
  sudo -n unshare --net -- runuser -u nobody -- env -i \
    HOME="$smoke_home" PATH=/usr/bin:/bin LANG=C.UTF-8 TMPDIR="$smoke_home" \
    XDG_CONFIG_HOME="$smoke_home/config" XDG_CACHE_HOME="$smoke_home/cache" \
    XDG_DATA_HOME="$smoke_home/data" XDG_RUNTIME_DIR="$smoke_home/runtime" \
    timeout --kill-after=5s 15s dbus-run-session -- xvfb-run -a \
    "$inspection_dir/squashfs-root/AppRun"
) >"$log_file" 2>&1
status=$?
set -e

# A healthy tray app remains in Tauri's event loop until timeout terminates it.
# Loader, GTK, WebKit and JavaScript bootstrap failures exit before that point.
if [[ $status -ne 124 ]] || ! grep -Fq '[desktop-startup] tray ready' "$log_file"; then
  sed -n '1,240p' "$log_file" >&2
  echo "AppImage did not reach a healthy tray startup (status $status)" >&2
  exit 1
fi

echo "AppImage reached a healthy tray startup offline as another user without Bun or a checkout."
