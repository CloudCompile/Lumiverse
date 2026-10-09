#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# linuxdeploy follows the app's ELF dependencies and copies the build host's
# libwayland-client into the AppImage. Host Mesa/EGL drivers then load against
# that older copy and abort WebKit before the tray JavaScript can start. Keep
# the build host's GTK/WebKit libraries, but leave this display-stack boundary
# to the target system. Tauri has already downloaded the output plugin, so the
# finalizer can repack without adding another release tool or network fetch.
bundle_dir="${1:?usage: finalize-appimage.sh <bundle-directory>}"
if [[ ! -d "$bundle_dir" ]]; then
  echo "AppImage bundle directory does not exist: $bundle_dir" >&2
  exit 1
fi
bundle_dir="$(cd "$bundle_dir" && pwd)"

appimages=()
while IFS= read -r -d '' candidate; do
  appimages+=("$candidate")
done < <(find "$bundle_dir" -maxdepth 1 -type f -name '*.AppImage' -print0)

appdirs=()
while IFS= read -r -d '' candidate; do
  appdirs+=("$candidate")
done < <(find "$bundle_dir" -maxdepth 1 -type d -name '*.AppDir' -print0)

if [[ ${#appimages[@]} -ne 1 || ${#appdirs[@]} -ne 1 ]]; then
  echo "Expected one AppImage and one AppDir in $bundle_dir; found ${#appimages[@]} and ${#appdirs[@]}" >&2
  exit 1
fi

appimage="${appimages[0]}"
appdir="${appdirs[0]}"
chmod +x "$appimage"

# Tauri's GTK AppRun hook points GStreamer exclusively at the AppImage. An
# empty or partial plugin directory therefore hides working host plugins and
# can make WebKit's renderer abort on the first audio graph. Refuse to publish
# an image unless Tauri's media-framework plugin staged the complete baseline.
bash "$script_dir/verify-appimage-gstreamer.sh" "$appdir"

assert_no_bundled_wayland_client() {
  local root="$1"
  local matches=()
  while IFS= read -r -d '' candidate; do
    matches+=("$candidate")
  done < <(find "$root" \( -type f -o -type l \) -name 'libwayland-client.so*' -print0)

  if [[ ${#matches[@]} -eq 0 ]]; then
    return 0
  fi

  printf 'AppImage still bundles a host-coupled Wayland client library:\n' >&2
  printf '  %s\n' "${matches[@]}" >&2
  return 1
}

bundled_wayland=()
while IFS= read -r -d '' candidate; do
  bundled_wayland+=("$candidate")
done < <(find "$appdir/usr" \( -type f -o -type l \) -name 'libwayland-client.so*' -print0)

if [[ ${#bundled_wayland[@]} -gt 0 ]]; then
  cache_root="${XDG_CACHE_HOME:-$HOME/.cache}"
  output_plugin="${LUMIVERSE_APPIMAGE_PLUGIN:-$cache_root/tauri/linuxdeploy-plugin-appimage.AppImage}"
  if [[ ! -f "$output_plugin" ]]; then
    echo "Tauri's AppImage output plugin was not found at $output_plugin" >&2
    exit 1
  fi
  if [[ ! -x "$output_plugin" ]]; then
    chmod +x "$output_plugin"
  fi

  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/lumiverse-appimage-finalize.XXXXXX")"
  trap 'rm -rf "$work_dir"' EXIT
  runtime_file="$work_dir/runtime"
  replacement="$work_dir/$(basename "$appimage")"

  runtime_size="$("$appimage" --appimage-offset)"
  if [[ ! "$runtime_size" =~ ^[0-9]+$ ]] || [[ "$runtime_size" -le 0 ]]; then
    echo "Could not determine the AppImage runtime size" >&2
    exit 1
  fi
  head -c "$runtime_size" "$appimage" > "$runtime_file"
  chmod +x "$runtime_file"

  printf 'Removing host-coupled Wayland libraries from the AppImage:\n'
  printf '  %s\n' "${bundled_wayland[@]}"
  rm -f -- "${bundled_wayland[@]}"
  assert_no_bundled_wayland_client "$appdir/usr"

  APPIMAGE_EXTRACT_AND_RUN=1 \
    LDAI_NO_APPSTREAM=1 \
    LDAI_OUTPUT="$replacement" \
    LDAI_RUNTIME_FILE="$runtime_file" \
    "$output_plugin" --appimage-extract-and-run "--appdir=$appdir"

  if [[ ! -s "$replacement" ]]; then
    echo "AppImage output plugin did not create $replacement" >&2
    exit 1
  fi
  chmod +x "$replacement"
  mv -f "$replacement" "$appimage"
else
  echo "AppDir already uses the host Wayland client library."
fi

verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/lumiverse-appimage-verify.XXXXXX")"
if [[ -n "${work_dir:-}" ]]; then
  trap 'rm -rf "$work_dir" "$verification_dir"' EXIT
else
  trap 'rm -rf "$verification_dir"' EXIT
fi

(
  cd "$verification_dir"
  "$appimage" --appimage-extract >/dev/null
)
assert_no_bundled_wayland_client "$verification_dir/squashfs-root"
bash "$script_dir/verify-appimage-gstreamer.sh" "$verification_dir/squashfs-root"

echo "Finalized $(basename "$appimage"): host libwayland-client and bundled GStreamer media support verified."
