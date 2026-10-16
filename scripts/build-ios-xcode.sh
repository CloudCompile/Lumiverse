#!/bin/sh
# Xcode's Run action must work without a Tauri CLI process or shell startup files.
set -eu

if [ "${LUMIVERSE_IOS_PREBUILT_RUST:-0}" = "1" ]; then
  exit 0
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export CARGO_TARGET_DIR="$repo_root/.tmp/ios-rust"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-15.0}"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: Install Rust with rustup before building the iOS client." >&2
  exit 1
fi

case "${PLATFORM_NAME:?Xcode must provide PLATFORM_NAME}" in
  iphoneos) target=aarch64-apple-ios ;;
  iphonesimulator) target=aarch64-apple-ios-sim ;;
  *) echo "error: Unsupported iOS build platform: $PLATFORM_NAME" >&2; exit 1 ;;
esac
case "${ARCHS:-arm64}" in
  arm64) ;;
  *) echo "error: This iOS client supports arm64 devices and simulators." >&2; exit 1 ;;
esac
case "${CONFIGURATION:?Xcode must provide CONFIGURATION}" in
  debug|Debug) profile=debug ;;
  release|Release) profile=release ;;
  *) echo "error: Unsupported iOS configuration: $CONFIGURATION" >&2; exit 1 ;;
esac

cd "$repo_root/ios/tauri"
set -- cargo build --manifest-path src-tauri/Cargo.toml --target "$target" --locked --lib
case "${LUMIVERSE_IOS_EXPERIMENTAL_HIGH_REFRESH:-0}" in
  1) set -- "$@" --features experimental-high-refresh ;;
  0) ;;
  *) echo "error: LUMIVERSE_IOS_EXPERIMENTAL_HIGH_REFRESH must be 0 or 1." >&2; exit 1 ;;
esac
if [ "$profile" = "release" ]; then
  set -- "$@" --release
fi
# Xcode exports the iPhone SDK as SDKROOT. Cargo also compiles macOS build
# dependencies, which must select their own SDK rather than inherit that SDK.
env -u SDKROOT "$@"

# Simulator and device archives are both arm64 but are incompatible linker
# inputs. Keep them separate even when Xcode builds the same configuration.
external="${SRCROOT:?Xcode must provide SRCROOT}/Externals/$PLATFORM_NAME/arm64/$CONFIGURATION"
mkdir -p "$external"
cp "$CARGO_TARGET_DIR/$target/$profile/liblumiverse_ios_client.a" "$external/libapp.a"
