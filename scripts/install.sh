#!/usr/bin/env bash
# Install Chumi with one command (run it again to update):
#
#   curl -fsSL https://raw.githubusercontent.com/FakeEnd/chumi/main/scripts/install.sh | bash
#
# It downloads Chumi into ~/Chumi (set CHUMI_DIR for another folder), then runs the guided setup, which asks
# before installing anything. Setup options pass through: ... | bash -s -- --mirror
set -euo pipefail
DIR="${CHUMI_DIR:-$HOME/Chumi}"
REPO="${CHUMI_REPO:-https://github.com/FakeEnd/chumi.git}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "Chumi runs on macOS (Apple Silicon, macOS 14.4 or later)."; exit 1; }
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Chumi first needs Apple's Xcode Command Line Tools (they include git). An installer window is opening."
  xcode-select --install >/dev/null 2>&1 || true
  echo "Click Install, wait until it finishes, then run the same command again."
  exit 1
fi

if [[ -d "$DIR/.git" ]]; then
  echo "Updating Chumi in $DIR…"
  git -C "$DIR" pull --ff-only
elif [[ -e "$DIR" ]]; then
  echo "$DIR already exists and is not a Chumi download. Choose another folder, for example:"
  echo "  curl -fsSL https://raw.githubusercontent.com/FakeEnd/chumi/main/scripts/install.sh | CHUMI_DIR=~/Apps/Chumi bash"
  exit 1
else
  echo "Downloading Chumi into $DIR…"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
# Piped into bash, standard input is this script: give the guided setup the terminal for its questions.
if [[ -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then exec bash scripts/setup.sh "$@" </dev/tty; fi
exec bash scripts/setup.sh --yes "$@"
