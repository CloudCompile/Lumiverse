#!/usr/bin/env bash
set -euo pipefail

# Mount a Filebase bucket to a local filesystem path so Lumiverse's
# DATA_DIR/LanceDB layout keeps working across cold starts.
#
# Required env vars:
#   LUMIVERSE_FILEBASE_ENABLED=true
#   LUMIVERSE_FILEBASE_BUCKET=lumiverse-data
#   LUMIVERSE_FILEBASE_ENDPOINT=https://s3.filebase.com
#   LUMIVERSE_FILEBASE_ACCESS_KEY_ID=...
#   LUMIVERSE_FILEBASE_SECRET_ACCESS_KEY=...
#
# Optional env vars:
#   LUMIVERSE_FILEBASE_MOUNT_PATH=/mnt/lumiverse-filebase
#   DATA_DIR=/mnt/lumiverse-filebase
#
# This script only mounts the bucket if the feature is enabled. It leaves the
# normal local DATA_DIR behavior untouched otherwise.

if [[ "${LUMIVERSE_FILEBASE_ENABLED:-false}" != "true" ]]; then
  exit 0
fi

require_value() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "Missing required env var: $name" >&2
    exit 1
  fi
}

require_value LUMIVERSE_FILEBASE_BUCKET
require_value LUMIVERSE_FILEBASE_ENDPOINT
require_value LUMIVERSE_FILEBASE_ACCESS_KEY_ID
require_value LUMIVERSE_FILEBASE_SECRET_ACCESS_KEY

MOUNT_PATH="${LUMIVERSE_FILEBASE_MOUNT_PATH:-/mnt/lumiverse-filebase}"
RCLONE_CONFIG_DIR="${HOME:-/root}/.config/rclone"
RCLONE_CONFIG_FILE="$RCLONE_CONFIG_DIR/rclone.conf"
RCLONE_REMOTE_NAME="filebase"

mkdir -p "$RCLONE_CONFIG_DIR" "$MOUNT_PATH"

cat > "$RCLONE_CONFIG_FILE" <<EOF
[$RCLONE_REMOTE_NAME]
type = s3
provider = Other
access_key_id = ${LUMIVERSE_FILEBASE_ACCESS_KEY_ID}
secret_access_key = ${LUMIVERSE_FILEBASE_SECRET_ACCESS_KEY}
endpoint = ${LUMIVERSE_FILEBASE_ENDPOINT}
region = us-east-1
acl = private
storage_class = STANDARD
EOF

if ! command -v rclone >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y --no-install-recommends rclone
  else
    echo "rclone is required but not installed and no apt-get is available." >&2
    exit 1
  fi
fi

if ! mountpoint -q "$MOUNT_PATH"; then
  echo "Mounting Filebase bucket ${LUMIVERSE_FILEBASE_BUCKET} to $MOUNT_PATH"
  rclone mount \
    "$RCLONE_REMOTE_NAME:${LUMIVERSE_FILEBASE_BUCKET}" \
    "$MOUNT_PATH" \
    --allow-other \
    --dir-cache-time 1h \
    --vfs-cache-mode full \
    --daemon
fi

if [[ -n "${DATA_DIR:-}" ]]; then
  if [[ "$DATA_DIR" != "$MOUNT_PATH" ]]; then
    mkdir -p "$DATA_DIR"
  fi
  if [[ "$DATA_DIR" != "$MOUNT_PATH" ]] && ! mountpoint -q "$DATA_DIR"; then
    if [[ ! -d "$DATA_DIR" ]]; then
      mkdir -p "$DATA_DIR"
    fi
    # Leave the app's data directory on the same mounted filesystem when a
    # custom DATA_DIR has been set by the operator, but do not override the
    # mount path if a bucket-backed filesystem was already configured.
    export DATA_DIR="$MOUNT_PATH"
  fi
fi

export DATA_DIR="${DATA_DIR:-$MOUNT_PATH}"
mkdir -p "$DATA_DIR"

if [[ "$DATA_DIR" == "$MOUNT_PATH" ]]; then
  echo "DATA_DIR is mounted from Filebase at $DATA_DIR"
else
  echo "Filebase is mounted at $MOUNT_PATH and DATA_DIR is $DATA_DIR"
fi
