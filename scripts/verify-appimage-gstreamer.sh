#!/usr/bin/env bash

set -euo pipefail

appdir="${1:?usage: verify-appimage-gstreamer.sh <AppDir-or-extracted-AppImage>}"
if [[ ! -d "$appdir" ]]; then
  echo "AppImage root does not exist: $appdir" >&2
  exit 1
fi
appdir="$(cd "$appdir" && pwd)"

plugin_dir="$appdir/usr/lib/gstreamer-1.0"
required_plugins=(
  # WebKit feeds browser-owned media into GStreamer through appsrc.
  libgstapp.so
  # The Web Audio and HTMLAudio graphs require format conversion/resampling.
  libgstaudioconvert.so
  libgstaudioparsers.so
  libgstaudioresample.so
  # autoaudiosink selects a real output backend; Pulse also covers PipeWire's
  # widely deployed PulseAudio compatibility service.
  libgstautodetect.so
  libgstpulseaudio.so
  # Core playbin/type detection plus the decoder used by Lumiverse's bundled
  # silent primer and notification ping MP3 files.
  libgstcoreelements.so
  libgstmpg123.so
  libgstplayback.so
  libgsttypefindfunctions.so
  libgstvolume.so
)

missing=()
for plugin in "${required_plugins[@]}"; do
  if [[ ! -s "$plugin_dir/$plugin" ]]; then
    missing+=("$plugin_dir/$plugin")
  fi
done

scanner="$appdir/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
if [[ ! -x "$scanner" ]]; then
  missing+=("$scanner")
fi

hook="$appdir/apprun-hooks/linuxdeploy-plugin-gstreamer.sh"
if [[ ! -s "$hook" ]]; then
  missing+=("$hook")
else
  for assignment in \
    'GST_PLUGIN_SYSTEM_PATH_1_0="${APPDIR}/usr/lib/gstreamer-1.0"' \
    'GST_PLUGIN_PATH_1_0="${APPDIR}/usr/lib/gstreamer-1.0"' \
    'GST_PLUGIN_SCANNER_1_0="${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"'; do
    if ! grep -Fq "$assignment" "$hook"; then
      missing+=("$hook: $assignment")
    fi
  done
fi

if ! command -v gst-inspect-1.0 >/dev/null 2>&1; then
  missing+=("gst-inspect-1.0 (required to validate the packaged plugin registry)")
elif [[ ${#missing[@]} -eq 0 ]]; then
  registry_dir="$(mktemp -d "${TMPDIR:-/tmp}/lumiverse-gstreamer-registry.XXXXXX")"
  trap 'rm -rf "$registry_dir"' EXIT
  required_elements=(
    appsrc
    appsink
    audioconvert
    audioresample
    autoaudiosink
    decodebin
    mpegaudioparse
    mpg123audiodec
    playbin
    pulsesink
    typefind
    volume
  )
  for element in "${required_elements[@]}"; do
    if ! env \
      LD_LIBRARY_PATH="$appdir/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
      GST_REGISTRY="$registry_dir/registry.bin" \
      GST_REGISTRY_REUSE_PLUGIN_SCANNER=no \
      GST_PLUGIN_SYSTEM_PATH_1_0="$plugin_dir" \
      GST_PLUGIN_PATH_1_0="$plugin_dir" \
      GST_PLUGIN_SCANNER_1_0="$scanner" \
      gst-inspect-1.0 "$element" >/dev/null 2>&1; then
      missing+=("GStreamer element factory: $element")
    fi
  done
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  printf 'AppImage is missing required bundled GStreamer media support:\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

echo "Verified bundled GStreamer audio plugins, factories, and AppRun search paths."
