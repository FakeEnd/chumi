#!/bin/bash
# Formats the iOS sources with Xcode's swift-format and ios/.swift-format.
# --check only reports files that need formatting, and fails if any do.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_dir/scripts/ios-env.sh"
if ! xcrun --find swift-format >/dev/null 2>&1; then
  echo 'swift-format ships with Xcode 16 or later. Install Xcode and run npm run ios:doctor.' >&2
  exit 1
fi
paths=("$repo_dir/ios/Chumi" "$repo_dir/ios/Tests")
config="$repo_dir/ios/.swift-format"
if [ "${1:-}" = "--check" ]; then
  xcrun swift-format lint --strict --recursive --configuration "$config" "${paths[@]}"
else
  xcrun swift-format format --in-place --recursive --configuration "$config" "${paths[@]}"
fi
