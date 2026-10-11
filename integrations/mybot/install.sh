#!/usr/bin/env bash
# Adds the Chumi meeting-transcript source to a local mybot checkout (https://github.com/jzhoulab/mybot).
#   bash integrations/mybot/install.sh [path-to-mybot]      (default: ~/Code/mybot)
set -euo pipefail
MYBOT="${1:-$HOME/Code/mybot}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$MYBOT/sources/registry.py" ]] || { echo "Not a mybot checkout: $MYBOT" >&2; exit 1; }

cp "$HERE/chumi.py" "$MYBOT/sources/chumi.py"
if grep -q '"chumi"' "$MYBOT/sources/registry.py"; then
  echo "mybot already has the chumi source registered; updated sources/chumi.py."
elif git -C "$MYBOT" apply --check "$HERE/mybot-chumi-source.patch" 2>/dev/null; then
  git -C "$MYBOT" apply "$HERE/mybot-chumi-source.patch"
  echo "Registered the chumi source in $MYBOT."
else
  echo "Could not apply the patch cleanly (mybot changed?). Apply the small edits in docs/mybot.md by hand." >&2
  exit 1
fi

cat <<EOF

Next steps:
  1. In Chumi: Settings → Integrations → turn on "Export sessions for mybot" (then "Export all now").
  2. In $MYBOT/.env add chumi to the sources, e.g.:
       TRAJECTORY_SOURCES=codex,claude,chumi
  3. Restart mybot (./run_chatbot.sh). Ask it things like "what did my advisor say about the holdout split?"
EOF
