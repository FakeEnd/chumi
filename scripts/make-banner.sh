#!/usr/bin/env bash
# Renders the README art with headless Chrome: the banner (docs/assets/banner.html) in four variants, and the two
# video cards (docs/assets/video-card.html), each on a frame of its video. Re-run after re-rendering the videos.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
shot() {  # shot WIDTH HEIGHT OUT URL
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-color-profile=srgb --allow-file-access-from-files \
    --window-size="$1,$2" --force-device-scale-factor=1.5 --virtual-time-budget=2500 --run-all-compositor-stages-before-draw \
    --screenshot="$3" "$4" 2>/dev/null
}
for lang in en zh; do
  suffix=$([[ $lang == en ]] && echo "" || echo "-zh")
  for theme in light dark; do
    out="docs/assets/banner${suffix}-${theme}.png"
    shot 1280 560 "$out" "file://$PWD/docs/assets/banner.html?theme=${theme}&lang=${lang}"
    echo "wrote $out"
  done
done

# The video cards: the tour on its "one loop" frame, the pet catching up beside the call.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
for lang in en zh; do
  suffix=$([[ $lang == en ]] && echo "" || echo "-zh")
  for video in tour pet; do
    case $video in
      tour) mp4="docs/assets/chumi-promo${suffix}.mp4"; at=78.5 ;;
      pet) mp4="docs/assets/chumi-pet${suffix}.mp4"; at=$([[ $lang == en ]] && echo 25.0 || echo 25.4) ;;
    esac
    secs=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$mp4" | awk '{ printf "%d", $1 + 0.5 }')
    unit=$([[ $lang == en ]] && echo " s" || echo " 秒")
    ffmpeg -loglevel error -y -ss "$at" -i "$mp4" -frames:v 1 -q:v 2 "$TMP/$video$suffix.jpg"
    png="$TMP/card.png"; out="docs/assets/card-${video}${suffix}.jpg"
    shot 1280 720 "$png" "file://$PWD/docs/assets/video-card.html?video=${video}&lang=${lang}&secs=${secs}${unit}&bg=file://$TMP/$video$suffix.jpg"
    sips -s format jpeg -s formatOptions 88 -Z 1280 "$png" --out "$out" >/dev/null
    echo "wrote $out"
  done
done
