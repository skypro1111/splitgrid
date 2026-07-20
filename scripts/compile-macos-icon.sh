#!/usr/bin/env bash
# Compiles the Icon Composer source (public/logos/icon_macos.icon) into the
# macOS Tahoe (26+) Liquid Glass assets:
#   build/Assets.car   -> live Liquid Glass icon (read via CFBundleIconName)
#   build/icon.icns    -> flattened fallback for macOS < 26 (and Finder previews)
#
# Requires Xcode (actool). macOS only. Run: npm run icon:macos
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICON_SRC="$ROOT/public/logos/icon_macos.icon"
OUT="$ROOT/build"
ICON_NAME="icon_macos"   # must match CFBundleIconName in forge.config.ts
PARTIAL_PLIST="$OUT/assetcatalog_generated_info.plist"

if ! xcrun --find actool >/dev/null 2>&1; then
  echo "actool not found — install Xcode to build the macOS Liquid Glass icon." >&2
  exit 1
fi

xcrun actool "$ICON_SRC" --compile "$OUT" \
  --output-format human-readable-text --notices --warnings --errors \
  --output-partial-info-plist "$PARTIAL_PLIST" \
  --app-icon "$ICON_NAME" --include-all-app-icons \
  --enable-on-demand-resources NO \
  --development-region en \
  --target-device mac \
  --minimum-deployment-target 26.0 \
  --platform macosx

# Use actool's backwards-compatible .icns as the legacy fallback so pre-Tahoe
# macOS shows the same artwork as the Liquid Glass icon.
cp "$OUT/$ICON_NAME.icns" "$OUT/icon.icns"
rm -f "$PARTIAL_PLIST"

echo "Wrote build/Assets.car and build/icon.icns (icon name: $ICON_NAME)"
