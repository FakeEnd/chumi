#!/bin/bash
set -u
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_dir/scripts/ios-env.sh"
if ! xcodebuild -version 2>/dev/null; then
  echo 'Full Xcode is missing or inactive. Install Xcode, open it once, and install the iOS platform and a simulator.'
  echo 'For a nonstandard location: DEVELOPER_DIR=/path/to/Xcode.app/Contents/Developer npm run ios:doctor'
  exit 1
fi
xcrun --sdk iphonesimulator --show-sdk-version || exit 1
xcrun simctl list devices available
echo "Project: $repo_dir/ios/Chumi.xcodeproj"
echo 'For a physical iPhone: connect by USB, trust the Mac, enable Developer Mode, and select your signing team in Xcode.'
