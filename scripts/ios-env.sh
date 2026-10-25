# Sourced by the ios-* scripts. Finds full Xcode without changing the Mac's global xcode-select:
# an explicit DEVELOPER_DIR wins, then /Applications/Xcode.app, then ~/Applications/Xcode.app,
# then any Xcode that Spotlight knows about, such as one kept in a personal apps folder.
if [ -z "${DEVELOPER_DIR:-}" ]; then
  for xcode in /Applications/Xcode.app "$HOME/Applications/Xcode.app"; do
    if [ -d "$xcode/Contents/Developer" ]; then
      export DEVELOPER_DIR="$xcode/Contents/Developer"
      break
    fi
  done
fi
if [ -z "${DEVELOPER_DIR:-}" ]; then
  while IFS= read -r xcode; do
    if [ -d "$xcode/Contents/Developer" ]; then
      export DEVELOPER_DIR="$xcode/Contents/Developer"
      break
    fi
  done < <(mdfind "kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'" 2>/dev/null)
fi
