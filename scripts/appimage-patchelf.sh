#!/usr/bin/env bash
set -euo pipefail

# A compiled Bun executable contains its embedded application in ELF sections.
# linuxdeploy's RPATH rewrite corrupts the ARM64 executable before GTK rescans
# it. Keep the already tested sidecar intact while patching desktop libraries.
if [[ "${1:-}" == --set-rpath && "${3##*/}" == lumiverse-server ]]; then
  echo "Preserving the compiled Bun server without an RPATH rewrite." >&2
  exit 0
fi

exec "${LUMIVERSE_REAL_PATCHELF:-patchelf}" "$@"
