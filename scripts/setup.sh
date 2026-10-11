#!/usr/bin/env bash
# One-time setup for Chumi on an Apple Silicon Mac (macOS 14.4+).
set -euo pipefail
cd "$(dirname "$0")/.."
MODELS="$HOME/Library/Application Support/Chumi/models"

say_step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say_step "Checking prerequisites"
[[ "$(uname -m)" == "arm64" ]] || echo "warning: Chumi is tuned for Apple Silicon."
command -v node >/dev/null || { echo "Node.js 24+ is required (brew install node)"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || { echo "Node.js 24+ is required (found $(node -v))"; exit 1; }
command -v swiftc >/dev/null || { echo "Xcode Command Line Tools are required: xcode-select --install"; exit 1; }
command -v brew >/dev/null || { echo "Homebrew is required to install whisper.cpp: https://brew.sh"; exit 1; }

say_step "Installing local speech recognition (whisper.cpp)"
command -v whisper-server >/dev/null || brew install whisper-cpp

# The speech model that suits this Mac (Large v3 Turbo on Apple Silicon with 16 GB+; others can be added in Settings → Transcription).
MODEL=$(node --input-type=module -e "import('./server/asr/models.ts').then((m) => console.log(m.recommendModel()))")
say_step "Downloading the speech model $MODEL (once; other sizes are in Settings → Transcription)"
mkdir -p "$MODELS"
if ! node --input-type=module -e "import('./server/asr/models.ts').then((m) => process.exit(m.isInstalled('$MODEL') ? 0 : 1))"; then
  curl -L --fail --progress-bar -o "$MODELS/$MODEL.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
  mv "$MODELS/$MODEL.part" "$MODELS/$MODEL"
fi
node --input-type=module -e "import('./server/asr/models.ts').then((m) => process.exit(m.isInstalled('$MODEL') ? 0 : 1))" \
  || { echo "The model download looks incomplete. Delete $MODELS/$MODEL and re-run."; exit 1; }

say_step "Installing JavaScript dependencies"
npm install --no-audit --no-fund

say_step "Building the web interface"
npm run build:web

say_step "Building the native audio helper and Chumi.app"
bash native/build.sh

if [[ ! -f samples/lab-meeting/lab-meeting.wav ]]; then
  say_step "Generating the 20-minute sample lab meeting (for testing)"
  node scripts/make-sample.mjs || echo "(sample generation skipped)"
fi

say_step "Done"
echo "Launch the app:      open build/Chumi.app"
echo "Or in a browser:     npm start   → http://127.0.0.1:4777"
echo "AI (ChatGPT plan):   codex login   (choose 'Sign in with ChatGPT')"
