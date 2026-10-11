#!/usr/bin/env bash
# Builds the Chumi native parts with the Command Line Tools Swift compiler (no Xcode needed):
#   build/chumi-audio   audio capture helper (dev copy, signed)
#   build/Chumi.app     app shell (WKWebView + node server), helper at Contents/MacOS/chumi-audio
#   build/chumi-screen  window capture tool (slides / shared screen)
#   build/chumi-hotkey  global quick-start shortcut listener
#   `native/build.sh tools` rebuilds only these two (Chumi.app and its permissions stay untouched)
#
# Env:
#   CHUMI_SIGN_IDENTITY  codesign identity (e.g. "Apple Development: …"). Default: ad-hoc ("-").
#   CHUMI_TARGET         swiftc target triple (default arm64-apple-macos14.4)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$REPO_ROOT/build"
OBJ_DIR="$BUILD_DIR/.intermediates"
APP="$BUILD_DIR/Chumi.app"
TARGET="${CHUMI_TARGET:-arm64-apple-macos14.4}"
SIGN_IDENTITY="${CHUMI_SIGN_IDENTITY:--}"
ENTITLEMENTS="$SCRIPT_DIR/entitlements.plist"

SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
if [[ -z "$SDK" || ! -d "$SDK" ]]; then
  SDK="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk"
fi

SWIFT_FLAGS=(-O -target "$TARGET" -sdk "$SDK" -swift-version 5)

mkdir -p "$OBJ_DIR"

build_screen() {
  # Window-capture tool (ScreenCaptureKit). Lives outside the app bundle so rebuilding it never changes
  # Chumi.app's signature (which would make macOS ask for Microphone / System Audio permission again).
  echo "==> Building chumi-screen ($TARGET)"
  swiftc "${SWIFT_FLAGS[@]}" -parse-as-library -module-name ChumiScreen -o "$OBJ_DIR/chumi-screen" "$SCRIPT_DIR"/screen/*.swift
  cp "$OBJ_DIR/chumi-screen" "$BUILD_DIR/chumi-screen"
  codesign --force --sign "$SIGN_IDENTITY" --timestamp=none --identifier local.chumi.screen "$BUILD_DIR/chumi-screen"
}

build_hotkey() {
  # Global quick-start shortcut listener (Carbon RegisterEventHotKey). Also outside the app bundle.
  echo "==> Building chumi-hotkey ($TARGET)"
  swiftc "${SWIFT_FLAGS[@]}" -module-name ChumiHotkey -o "$OBJ_DIR/chumi-hotkey" "$SCRIPT_DIR"/hotkey/*.swift
  cp "$OBJ_DIR/chumi-hotkey" "$BUILD_DIR/chumi-hotkey"
  codesign --force --sign "$SIGN_IDENTITY" --timestamp=none --identifier local.chumi.hotkey "$BUILD_DIR/chumi-hotkey"
}

if [[ "${1:-all}" == "screen" || "${1:-all}" == "tools" ]]; then
  build_screen
  build_hotkey
  echo "Built: $BUILD_DIR/chumi-screen, $BUILD_DIR/chumi-hotkey"
  exit 0
fi

echo "==> Building chumi-audio ($TARGET)"
swiftc "${SWIFT_FLAGS[@]}" -module-name ChumiAudio \
  -o "$OBJ_DIR/chumi-audio" \
  "$SCRIPT_DIR"/audio/*.swift \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$SCRIPT_DIR/audio/Info.plist"

echo "==> Building Chumi ($TARGET)"
swiftc "${SWIFT_FLAGS[@]}" -module-name Chumi \
  -o "$OBJ_DIR/Chumi" \
  "$SCRIPT_DIR"/app/*.swift

# Optional icon (cached; failures are non-fatal).
ICNS="$OBJ_DIR/AppIcon.icns"
if [[ ! -f "$ICNS" || "$SCRIPT_DIR/tools/make_icon.swift" -nt "$ICNS" ]]; then
  echo "==> Generating app icon"
  if swiftc -O -target "$TARGET" -sdk "$SDK" -swift-version 5 -o "$OBJ_DIR/make_icon" "$SCRIPT_DIR/tools/make_icon.swift" 2>/dev/null \
     && "$OBJ_DIR/make_icon" "$OBJ_DIR/icon_1024.png"; then
    ICONSET="$OBJ_DIR/AppIcon.iconset"
    rm -rf "$ICONSET"; mkdir -p "$ICONSET"
    for s in 16 32 128 256 512; do
      sips -z "$s" "$s" "$OBJ_DIR/icon_1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
      d=$((s * 2))
      sips -z "$d" "$d" "$OBJ_DIR/icon_1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
    done
    iconutil -c icns "$ICONSET" -o "$ICNS" || rm -f "$ICNS"
  else
    echo "    (icon generation skipped)"
  fi
fi

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$OBJ_DIR/Chumi" "$APP/Contents/MacOS/Chumi"
cp "$OBJ_DIR/chumi-audio" "$APP/Contents/MacOS/chumi-audio"
cp "$SCRIPT_DIR/app/Info.plist" "$APP/Contents/Info.plist"
plutil -replace ChumiRepoPath -string "$REPO_ROOT" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
if [[ -f "$ICNS" ]]; then
  cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"
else
  plutil -remove CFBundleIconFile "$APP/Contents/Info.plist" || true
fi
plutil -lint "$APP/Contents/Info.plist" >/dev/null

cp "$OBJ_DIR/chumi-audio" "$BUILD_DIR/chumi-audio"

echo "==> Code signing (identity: ${SIGN_IDENTITY})"
SIGN_ARGS=(--force --sign "$SIGN_IDENTITY" --timestamp=none --entitlements "$ENTITLEMENTS")
if [[ "$SIGN_IDENTITY" != "-" ]]; then
  # A real identity gets the hardened runtime (needs the audio-input entitlement for the mic).
  SIGN_ARGS+=(--options runtime)
fi
# Helper first (nested code), then the app bundle, then the dev copy of the helper.
codesign "${SIGN_ARGS[@]}" --identifier local.chumi.audio "$APP/Contents/MacOS/chumi-audio"
codesign "${SIGN_ARGS[@]}" --identifier local.chumi.app "$APP"
codesign "${SIGN_ARGS[@]}" --identifier local.chumi.audio "$BUILD_DIR/chumi-audio"
codesign --verify --strict "$APP"
codesign --verify --strict "$BUILD_DIR/chumi-audio"

build_screen
build_hotkey

echo
echo "Built:"
echo "  Window capture: $BUILD_DIR/chumi-screen"
echo "  Quick-start shortcut: $BUILD_DIR/chumi-hotkey"
echo "  App:     $APP"
echo "  Helper:  $APP/Contents/MacOS/chumi-audio"
echo "  Dev helper: $BUILD_DIR/chumi-audio"
echo "  Repo path baked into Info.plist (ChumiRepoPath): $REPO_ROOT"
echo "Run:  open \"$APP\"     or     \"$BUILD_DIR/chumi-audio\" --source both"
