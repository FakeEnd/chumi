#!/usr/bin/env bash
# Renders the README banner (docs/assets/banner.html) in four variants with headless Chrome.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
for lang in en zh; do
  for theme in light dark; do
    suffix=$([[ $lang == en ]] && echo "" || echo "-zh")
    out="docs/assets/banner${suffix}-${theme}.png"
    "$CHROME" --headless --disable-gpu --hide-scrollbars --force-color-profile=srgb \
      --window-size=1280,560 --force-device-scale-factor=1.5 --virtual-time-budget=2500 --run-all-compositor-stages-before-draw \
      --screenshot="$out" "file://$PWD/docs/assets/banner.html?theme=${theme}&lang=${lang}" 2>/dev/null
    echo "wrote $out"
  done
done
