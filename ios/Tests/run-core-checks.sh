#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/chumi-ios-checks.XXXXXX")
trap 'rm -rf "$build_dir"' EXIT INT TERM
cd "$root"
xcrun swiftc -swift-version 5 -module-cache-path "$build_dir/modules" \
  ios/Chumi/Models/Meeting.swift ios/Chumi/Models/MeetingStore.swift \
  ios/Chumi/Networking/MobileEndpoint.swift ios/Chumi/Networking/ConnectionStore.swift \
  ios/Chumi/Networking/MobileAPI.swift ios/Tests/CoreChecks.swift \
  -o "$build_dir/core-checks"
"$build_dir/core-checks"
