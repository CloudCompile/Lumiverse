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
inspection_dir="$(mktemp -d "$log_root/lumiverse-appimage-inspect.XXXXXX")"
trap 'rm -rf "$inspection_dir"' EXIT

(
  cd "$inspection_dir"
  "$appimage" --appimage-extract >/dev/null
)
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

set +e
timeout 15s dbus-run-session -- xvfb-run -a \
  env APPIMAGE_EXTRACT_AND_RUN=1 "$appimage" >"$log_file" 2>&1
status=$?
set -e

# A healthy tray app remains in Tauri's event loop until timeout terminates it.
# Loader, GTK, WebKit and JavaScript bootstrap failures exit before that point.
if [[ $status -ne 124 ]] || ! grep -Fq '[desktop-startup] tray ready' "$log_file"; then
  sed -n '1,240p' "$log_file" >&2
  echo "AppImage did not reach a healthy tray startup (status $status)" >&2
  exit 1
fi

echo "AppImage remained healthy through the 15-second startup smoke test."
