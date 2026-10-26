#!/usr/bin/env bash
# Renders the README art with headless Chrome: the banner (docs/assets/banner.html) in four variants, and the two
# video cards (docs/assets/video-card.html), each on a frame of its video. Re-run after re-rendering the videos.
# Each card then becomes the first frame of its 720p video: GitHub's player rests on a video's first frame, so the
# uploaded tour and pet show their card until played.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TAG=chumi-poster-frame
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
      tour) name="chumi-promo${suffix}"; at=78.5 ;;
      pet) name="chumi-pet${suffix}"; at=$([[ $lang == en ]] && echo 25.0 || echo 25.4) ;;
    esac
    web="docs/assets/$name.mp4"; master="dist/video/$name-1080p.mp4"
    # The source: the 1080p master when there is one (it never has the card frame), else the 720p video itself,
    # without the card frame a previous run put first.
    src=$web; skip=0
    if [[ -f $master ]]; then src=$master
    elif ffprobe -v error -show_entries format_tags=comment -of csv=p=0 "$web" | grep -q "$TAG"; then skip=1; fi
    secs=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src" | awk -v s=$skip '{ printf "%d", $1 - s / 30 + 0.5 }')
    unit=$([[ $lang == en ]] && echo " s" || echo " 秒")
    ffmpeg -loglevel error -y -ss "$at" -i "$src" -frames:v 1 -vf scale=1280:720:flags=lanczos -q:v 2 "$TMP/$video$suffix.jpg"
    png="$TMP/card.png"; card="docs/assets/card-${video}${suffix}.jpg"
    shot 1280 720 "$png" "file://$PWD/docs/assets/video-card.html?video=${video}&lang=${lang}&secs=${secs}${unit}&bg=file://$TMP/$video$suffix.jpg"
    sips -s format jpeg -s formatOptions 88 -Z 1280 "$png" --out "$card" >/dev/null
    echo "wrote $card"
    # The card as the video's first frame (one frame, 1/30 s; the sound waits for it), encoded as make-video.ts does.
    ffmpeg -loglevel error -y -loop 1 -t 1 -i "$card" -i "$src" -filter_complex "\
[0:v]scale=1280:720:flags=lanczos,setsar=1,fps=30,trim=end_frame=1,format=yuv420p[p];\
[1:v]trim=start_frame=$skip,setpts=PTS-STARTPTS,scale=1280:720:flags=lanczos,setsar=1,fps=30,format=yuv420p[v];\
[p][v]concat=n=2:v=1:a=0[vv];[1:a]atrim=start=$(awk -v s=$skip 'BEGIN { print s / 30 }'),asetpts=PTS-STARTPTS,adelay=33:all=1[aa]" \
      -map "[vv]" -map "[aa]" -c:v libx264 -crf 24 -preset slow -tune animation -pix_fmt yuv420p -c:a aac -b:a 128k \
      -movflags +faststart -metadata comment="$TAG" "$TMP/out.mp4"
    mv "$TMP/out.mp4" "$web"
    echo "wrote $web (card as its first frame)"
  done
done
