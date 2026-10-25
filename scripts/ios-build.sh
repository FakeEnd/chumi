#!/bin/bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_dir/scripts/ios-env.sh"
if ! xcodebuild -version >/dev/null 2>&1; then
  echo 'Full Xcode is required. Install it and run npm run ios:doctor.' >&2
  exit 1
fi
xcodebuild -project "$repo_dir/ios/Chumi.xcodeproj" -scheme Chumi -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$repo_dir/build/ios" CODE_SIGNING_ALLOWED=NO build
