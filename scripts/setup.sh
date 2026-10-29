#!/usr/bin/env bash
# Chumi setup for an Apple Silicon Mac (macOS 14.4+). It checks what is missing, offers to install it, builds the app,
# and helps you connect an AI. Safe to run again: finished steps are skipped.
#
#   bash scripts/setup.sh             guided: asks before installing anything new
#   bash scripts/setup.sh --yes       accept the defaults without asking (does not install Homebrew or sign you in)
#   --mirror                          download the speech model from hf-mirror.com (often faster in mainland China);
#                                     or set CHUMI_MODEL_BASE_URL to another copy of ggerganov/whisper.cpp
#   --sample                          also generate the 20-minute sample meeting used for testing
#   --no-ai                           skip the AI step
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
# Do not replace files while the app or a source server is using them.
check_chumi_stopped() {
  local root processes pid command cwd found=0
  root=$(cd "$1" && pwd -P) || return 1
  processes=$(ps -ww -axo pid=,command=) || { echo "Could not check whether Chumi is running. Quit Chumi and try again." >&2; return 1; }
  while read -r pid command; do
    [[ -n $pid ]] || continue
    case "$command " in
      *"$root/server/main.ts "*|*"$root/build/Chumi.app/Contents/MacOS/Chumi "*) ;;
      *)
        # Relative commands need their working directory to distinguish another checkout.
        if [[ ! $command =~ (^|[[:space:]])(\./)?server/main\.ts([[:space:]]|$) && ! $command =~ ^(\./)?build/Chumi\.app/Contents/MacOS/Chumi([[:space:]]|$) ]]; then continue; fi
        cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p') || cwd=''
        if [[ -n $cwd ]]; then
          cwd=$(cd "$cwd" 2>/dev/null && pwd -P) || cwd=''
          if [[ -n $cwd && $cwd != "$root" ]]; then continue; fi
        fi
        if [[ -z $cwd ]]; then echo "Could not determine the working directory of PID $pid; check this process before updating." >&2; fi ;;
    esac
    printf 'Chumi update blocked by PID %s: %s\n' "$pid" "$command" >&2
    found=1
  done < <(printf '%s\n' "$processes" | awk '/Chumi[.]app\/Contents\/MacOS\/Chumi([[:space:]]|$)/ || (/(^|[[:space:]\/])node([[:space:]]|$)/ && /server\/main[.]ts([[:space:]]|$)/)')
  if [[ $found == 1 ]]; then
    echo "Finish any active meeting, quit Chumi (or stop npm start), then run this command again." >&2
    return 1
  fi
}
MODELS="${CHUMI_MODELS_DIR:-$HOME/Library/Application Support/Chumi/models}"

YES=0 SAMPLE=0 AI=1 MIRROR=0
for arg in "$@"; do
  case $arg in
    -y|--yes) YES=1 ;;
    --mirror) MIRROR=1; export CHUMI_MODEL_BASE_URL="${CHUMI_MODEL_BASE_URL:-https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main}" ;;
    --sample) SAMPLE=1 ;;
    --no-ai) AI=0 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)"; exit 2 ;;
  esac
done
INTERACTIVE=0
[[ $YES == 0 && -t 0 ]] && INTERACTIVE=1

if [[ -t 1 ]]; then B=$'\033[1m' G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' D=$'\033[2m' N=$'\033[0m'; else B='' G='' Y='' R='' D='' N=''; fi
STEP=0 STEPS=5
step() { STEP=$((STEP + 1)); printf '\n%s[%d/%d] %s%s\n' "$B" "$STEP" "$STEPS" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
fail() { printf '\n  %s✗ %s%s\n' "$R" "$1" "$N"; [[ -n ${2:-} ]] && printf '    %s\n' "$2"; exit 1; }
# ask "question" Y|N: the default answer is used with --yes or without a terminal.
ask() {
  local def=${2:-Y} reply
  if [[ $INTERACTIVE == 0 ]]; then [[ $def == Y ]]; return; fi
  read -r -p "  $1 $([[ $def == Y ]] && echo '[Y/n]' || echo '[y/N]') " reply || reply=''
  [[ ${reply:-$def} =~ ^[Yy] ]]
}
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

printf '%sChumi setup%s\n' "$B" "$N"
echo "This installs local speech recognition (whisper.cpp and one speech model, about 0.9 GB),"
echo "builds Chumi and its audio helper, and helps you connect ChatGPT, Claude or a local model."
echo "It takes about 5–15 minutes, mostly downloads. Nothing is sent anywhere except the downloads."

# ----------------------------------------------------------------------------------------------------------------
step "Checking this Mac"
[[ "$(uname -s)" == "Darwin" ]] || fail "This setup is for macOS." "On Windows, use the desktop app or scripts/setup.ps1 (see docs/windows.md). Linux is not supported yet."
check_chumi_stopped "$ROOT"
OS=$(sw_vers -productVersion)
version_ge "$OS" "14.4" || fail "Chumi needs macOS 14.4 or later (this Mac has $OS)." "Update in System Settings → General → Software Update, then run this again."
ok "macOS $OS"
APPLE_SILICON=$(sysctl -in hw.optional.arm64 2>/dev/null || true)
if [[ $APPLE_SILICON == 1 ]]; then ok "Apple Silicon"; else warn "This is an Intel Mac: Chumi works, but speech recognition is slower. Settings → Transcription can pick a smaller model."; fi

tools_ready() { CLT_OUTPUT=$(xcrun --find swiftc 2>&1 && xcrun swiftc -version 2>&1); }
tools_license() { [[ $CLT_OUTPUT == *license* || $CLT_OUTPUT == *License* ]]; }
if tools_ready; then
  ok "Xcode Command Line Tools"
else
  if tools_license; then fail "The Xcode license needs to be accepted." "Run: sudo xcodebuild -license accept, then run setup again."; fi
  warn "The Xcode Command Line Tools are missing or cannot run (needed to build Chumi's audio helper)."
  if [[ $INTERACTIVE == 1 ]] && ask "Open Apple's installer for them now?"; then
    xcode-select --install >/dev/null 2>&1 || true
    echo "  A macOS window opened. Click Install and wait until it finishes (a few minutes)."
    until tools_ready; do
      if tools_license; then fail "The Xcode license needs to be accepted." "Run: sudo xcodebuild -license accept, then run setup again."; fi
      read -r -p "  Press Return when the installer has finished (or Ctrl-C to stop) " _ || exit 1
    done
    ok "Xcode Command Line Tools"
  else
    fail "Install them with: xcode-select --install" "Then run this setup again."
  fi
fi

# Homebrew may be installed but missing from PATH in a fresh shell.
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x $b ]] && ! command -v brew >/dev/null && eval "$("$b" shellenv)"; done
if command -v brew >/dev/null; then
  ok "Homebrew"
else
  warn "Homebrew is missing (Chumi uses it to install whisper.cpp and, if needed, Node.js)."
  if [[ $INTERACTIVE == 1 ]] && ask "Install Homebrew now? It asks for your Mac password."; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [[ -x $b ]] && eval "$("$b" shellenv)"; done
    command -v brew >/dev/null || fail "Homebrew did not install." "See https://brew.sh, then run this setup again."
    ok "Homebrew"
    warn "To use brew in new Terminal windows, run the two \"Next steps\" commands Homebrew printed above."
  else
    fail "Install Homebrew from https://brew.sh" "Then run this setup again."
  fi
fi

node_ok() { command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; }
if node_ok; then
  ok "Node.js $(node -v)"
else
  warn "Chumi needs Node.js 24 or later ($(command -v node >/dev/null && node -v || echo 'not installed'))."
  if ask "Install the current Node.js with Homebrew?"; then
    brew install node || brew upgrade node
    hash -r
    node_ok || fail "Node.js 24+ is still not the one on your PATH ($(command -v node))." "If you use nvm or another version manager, switch to Node 24 or later and run this again."
    ok "Node.js $(node -v)"
  else
    fail "Install Node.js 24 or later (brew install node), then run this setup again."
  fi
fi

if [[ $APPLE_SILICON == 1 && "$(node -p 'process.arch')" != arm64 ]]; then
  warn "Node.js is running under Rosetta on Apple Silicon. Use arm64 Homebrew: /opt/homebrew/bin/brew install node; put /opt/homebrew/bin first on PATH, then rerun setup."
fi

# ----------------------------------------------------------------------------------------------------------------
step "Local speech recognition"
if command -v whisper-server >/dev/null; then ok "whisper.cpp"; else echo "  Installing whisper.cpp with Homebrew…"; brew install whisper-cpp; ok "whisper.cpp"; fi

if [[ $APPLE_SILICON == 1 ]] && ! file -b "$(command -v whisper-server)" | grep -q arm64; then
  warn "whisper.cpp may be running under Rosetta. Install its Apple Silicon build with /opt/homebrew/bin/brew install whisper-cpp, and put /opt/homebrew/bin first on PATH."
fi

BASE=$(node scripts/setup-model.ts base "${CHUMI_MODEL_BASE_URL:-}")
ok "Speech model download source: $BASE"
MODEL=$(node scripts/setup-model.ts model)
installed() { node --input-type=module -e "import('./server/asr/models.ts').then((m) => process.exit(m.isInstalled('$MODEL') ? 0 : 1))"; }
if installed; then
  ok "Speech model $MODEL"
else
  if [[ $BASE == https://huggingface.co/ggerganov/whisper.cpp/resolve/main ]] && ! curl -sfI --max-time 8 -o /dev/null "$BASE/$MODEL"; then
    warn "huggingface.co did not answer."
    if [[ $INTERACTIVE == 1 ]] && ask "Download from the hf-mirror.com copy instead?"; then
      BASE=$(node scripts/setup-model.ts base "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main")
    else
      warn "To use the hf-mirror.com copy, rerun setup with --mirror, or choose it in Settings → Transcription → Download source."
    fi
  fi
  echo "  Downloading $MODEL (your configured Whisper model; other sizes are in Settings → Transcription)."
  echo "  ${D}If it stops, run setup again: the download resumes.${N}"
  mkdir -p "$MODELS"
  curl -L --fail --retry 3 -C - --progress-bar -o "$MODELS/$MODEL.part" "$BASE/$MODEL" \
    || fail "The model download failed." "Check your connection and run setup again (it resumes). Behind a firewall, try: bash scripts/setup.sh --mirror"
  # The same SHA-256 the app checks (server/asr/models.ts), whichever copy it came from.
  SHA=$(node --input-type=module -e "import('./server/asr/models.ts').then((m) => console.log(m.MODEL_CATALOG.find((x) => x.id === '$MODEL').sha256))")
  if [[ "$(shasum -a 256 "$MODELS/$MODEL.part" | cut -d ' ' -f 1)" != "$SHA" ]]; then
    rm -f "$MODELS/$MODEL.part"
    fail "The downloaded model does not match its published checksum, so it was deleted." "Run setup again to download it afresh. If this keeps happening, $BASE is not serving the official file."
  fi
  mv "$MODELS/$MODEL.part" "$MODELS/$MODEL"
  installed || fail "The downloaded model looks incomplete." "Delete \"$MODELS/$MODEL\" and run setup again."
  ok "Speech model $MODEL"
fi

# ----------------------------------------------------------------------------------------------------------------
check_chumi_stopped "$ROOT"
step "Building Chumi"
# Build output goes to a log; it is shown only if a step fails.
mkdir -p "$ROOT/build"; LOG="$ROOT/build/setup.log"; : > "$LOG"
quietly() {
  local label=$1; shift
  echo "  ${label}…"
  if ! "$@" >>"$LOG" 2>&1; then tail -25 "$LOG" | sed 's/^/    /'; fail "$label failed." "The full output is in $LOG"; fi
}
# npm ci installs exactly package-lock.json and never rewrites it, so a later `git pull --ff-only` still works.
NPM_ARGS=(ci --no-audit --no-fund)
if [[ $MIRROR == 1 ]]; then NPM_ARGS+=(--registry=https://registry.npmmirror.com); fi
quietly "Installing JavaScript packages" npm "${NPM_ARGS[@]}"
quietly "Building the interface" npm run build:web
quietly "Building the audio helper and Chumi.app" bash native/build.sh
ok "Chumi.app is in $ROOT/build"
if [[ $SAMPLE == 1 && ! -f samples/lab-meeting/lab-meeting.wav ]]; then
  echo "  Generating the 20-minute sample meeting (for testing)…"
  node scripts/make-sample.mjs || warn "The sample meeting was skipped."
fi

# ----------------------------------------------------------------------------------------------------------------
step "Connecting an AI"
codex_ready()  { command -v codex >/dev/null && codex login status 2>&1 | grep -q ChatGPT; }
claude_ready() { command -v claude >/dev/null && claude auth status 2>&1 | grep -q '"loggedIn": *true'; }
provider_name() {
  case $1 in codex) echo "ChatGPT plan (codex)" ;; claude-cli) echo "Claude plan (claude-cli)" ;; anthropic-api) echo "Anthropic API (anthropic-api)" ;; compatible) echo "Other models (compatible)" ;; *) echo "$1" ;; esac
}
use_provider() {
  local result
  result=$(node scripts/setup-provider.ts use "$1")
  case $result in
    saved:*) ok "Chumi will use $(provider_name "${result#saved:}")" ;;
    existing:*) ok "Chumi uses $(provider_name "${result#existing:}")" ;;
    running) warn "Chumi is running, so setup did not change its provider. Choose $(provider_name "$1") in Settings → AI provider." ;;
  esac
}
saved_provider=''
if [[ $AI != 0 ]]; then saved_provider=$(node scripts/setup-provider.ts current); fi
if [[ $AI == 0 ]]; then
  echo "  Skipped (--no-ai). Choose one later in Chumi: Settings → AI provider."
elif [[ -n $saved_provider ]]; then
  ok "Chumi uses $(provider_name "$saved_provider")"
elif codex_ready || claude_ready; then
  codex_ready && ok "ChatGPT plan: Codex is signed in"
  claude_ready && ok "Claude plan: Claude Code is signed in"
  if codex_ready; then use_provider codex; else use_provider claude-cli; fi
else
  echo "  Chumi uses an AI you already have. Your sign-in stays with the official app; Chumi never sees it."
  echo "    1) ChatGPT plan (through Codex)"
  echo "    2) Claude plan (through Claude Code)"
  echo "    3) A free local model (Ollama on this Mac; needs 16 GB of memory or more)"
  echo "    4) Decide later in Settings → AI provider"
  choice=4
  if [[ $INTERACTIVE == 1 ]]; then read -r -p "  Choose 1–4 [4]: " choice || choice=4; choice=${choice:-4}; fi
  case $choice in
    1)
      if ! command -v codex >/dev/null; then
        echo "  Installing Codex with Homebrew…"
        if ! brew install codex; then warn "Could not install Codex. Chumi is built; retry later with: brew install codex, then codex login."; fi
      fi
      if command -v codex >/dev/null; then
        echo "  Signing in: choose \"Sign in with ChatGPT\" in the browser window."
        codex login || warn "Not signed in yet. Run: codex login"
        if codex_ready; then ok "ChatGPT plan connected"; use_provider codex; fi
      fi ;;
    2)
      if ! command -v claude >/dev/null; then
        echo "  Installing Claude Code…"
        if ! npm install -g @anthropic-ai/claude-code --loglevel=error; then
          warn "Could not install Claude Code. Chumi is built; you can connect an AI later in Settings."
          warn "For EACCES, use a writable npm prefix: npm config set prefix ~/.npm-global; add ~/.npm-global/bin to PATH, then retry the install."
        fi
        hash -r
      fi
      if command -v claude >/dev/null; then
        echo "  Signing in with your Claude Pro or Max account in the browser window."
        claude auth login || warn "Not signed in yet. Run: claude auth login"
        if claude_ready; then ok "Claude plan connected"; use_provider claude-cli; fi
      fi ;;
    3)
      ollama_installed=1
      if ! command -v ollama >/dev/null; then
        echo "  Installing Ollama with Homebrew…"
        if ! brew install ollama; then ollama_installed=0; warn "Could not install Ollama. Chumi is built; retry later with: brew install ollama."; fi
      fi
      if [[ $ollama_installed == 1 ]] && command -v ollama >/dev/null; then
        brew services start ollama >/dev/null 2>&1 || true
        use_provider compatible
      fi
      echo "  In Chumi, open Settings → AI provider → Other models: local or API → Ollama,"
      echo "    and click Download recommended model: it picks one that fits this Mac." ;;
    *) echo "  Later: open Chumi, and the Get Chumi ready checklist on Home shows what to do." ;;
  esac
fi

# ----------------------------------------------------------------------------------------------------------------
step "Final check"
READY=1
node scripts/doctor.ts --brief || READY=0
echo
if [[ $READY == 1 ]]; then printf '%sChumi is installed.%s\n' "$B" "$N"; else printf '%sChumi is installed, but the items above need attention first.%s\n' "$Y" "$N"; fi
echo "  Open it:            open \"$ROOT/build/Chumi.app\"   (or drag it to your Dock)"
echo "  In a browser:       npm start   →  http://127.0.0.1:4777"
echo "  Check anything:     npm run doctor"
echo "  Update later:       git pull && bash scripts/setup.sh"
echo "  The first time you listen, macOS asks for Microphone (and, for Zoom or video, System Audio Recording) access."
if [[ $INTERACTIVE == 1 ]] && ask "Open Chumi now?"; then open "$ROOT/build/Chumi.app"; fi
