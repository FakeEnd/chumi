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

[[ "$(uname -s)" == "Darwin" ]] || { echo "This installer is for macOS 14.4 or later. For Windows, see https://github.com/FakeEnd/chumi/blob/main/docs/windows.md"; exit 1; }
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Chumi first needs Apple's Xcode Command Line Tools (they include git). An installer window is opening."
  xcode-select --install >/dev/null 2>&1 || true
  echo "Click Install, wait until it finishes, then run the same command again."
  exit 1
fi

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
if [[ -e "$DIR/.git" ]]; then
  check_chumi_stopped "$(cd "$DIR" && pwd -P)"
  echo "Updating Chumi in ${DIR}…"
  if ! git -C "$DIR" pull --ff-only; then
    echo "Chumi was not updated. Check the checkout before trying again:"
    printf '  git -C "%s" status\n' "$DIR"
    echo "Keep any local changes you need. You can also install a fresh copy with CHUMI_DIR set to a new folder."
    exit 1
  fi
elif [[ -e "$DIR" ]]; then
  echo "$DIR already exists and is not a Chumi download. Choose another folder, for example:"
  echo "  curl -fsSL https://raw.githubusercontent.com/FakeEnd/chumi/main/scripts/install.sh | CHUMI_DIR=~/Apps/Chumi bash"
  exit 1
else
  echo "Downloading Chumi into ${DIR}…"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
# Piped into bash, standard input is this script: give the guided setup the terminal for its questions.
if [[ -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then exec bash scripts/setup.sh "$@" </dev/tty; fi
exec bash scripts/setup.sh --yes "$@"
