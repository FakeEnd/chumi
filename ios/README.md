# Chumi for iPhone — first native prototype

[中文调试与配对指南](README.zh-CN.md)

Native SwiftUI client for iOS 17 and later. The phone records and keeps its meetings locally; your Mac provides AI answers and optional mybot project context. The Xcode project is checked in and needs no project generator.

## What this version does

- Record microphone audio on iPhone and save it locally.
- Display live, **on-device Apple Speech** transcription when the selected language is supported. Chinese and English are selectable; this is not a validated bilingual Zipformer integration. If offline recognition is unavailable, the app records audio and explains the limitation instead of uploading it to a speech service.
- Keep meetings and finalized transcript segments across app restarts.
- Pair with the Mac companion using a private pairing code, HTTPS, and a pinned certificate. Store pairing credentials in the iOS Keychain.
- Explicitly sync transcript text to the Mac, including during recording, choose a project, ask questions, catch up, and request summaries using the Mac's configured AI provider. Only finalized text is synced; new transcript segments need another sync. Project context uses the existing opt-in mybot integration.
- Look and work like the Mac app: the same colours, cards and meeting-type dots, catch-ups over the last 2 minutes, 5 minutes or the meeting so far, AI answers rendered as Markdown, and light and dark appearance.
- Open the app with the `--demo` launch argument to inspect sample screens without recording, connecting to a Mac, or making model requests. Debug builds also accept `--demo-screen detail`, `assistant`, `connection` or `new` to open that screen directly, which is handy for simulator screenshots.

This is a prototype, not an App Store release. The app has successfully compiled with **Xcode 26.6 and the iOS 26.5 SDK**, producing arm64 and x86_64 simulator binaries without code signing. The demo home, meeting detail, assistant, connection and new-meeting screens have been verified on an **iPhone 15 simulator running iOS 26.5**, in light and dark appearance. Server tests and native core checks also pass. Microphone capture, on-device recognition, Mac network pairing, and physical-device behavior still need testing.

## Install the development tools

1. Install **Xcode** from the Mac App Store. If that version requires a newer macOS, use a compatible release from [Apple Developer Downloads](https://developer.apple.com/download/all/). Open Xcode once and finish its first-launch setup, then install the iOS platform and at least one iPhone simulator runtime in its components/platform settings.
2. Run `npm run ios:doctor` from the repository. The scripts first honor an explicit `DEVELOPER_DIR`, then look in `/Applications/Xcode.app`, then `~/Applications/Xcode.app`, then anywhere Spotlight finds Xcode (for example a personal apps folder). Installing Xcode in your personal Applications folder works when the system folder is not writable. The scripts do not change the Mac's global `xcode-select` setting.
3. Open `ios/Chumi.xcodeproj`, select the **Chumi** scheme, select an iPhone simulator, and run. Or use `npm run ios:build` for a simulator build without code signing.

The simulator does not need a paid Apple Developer membership. A real device needs a signing team in Xcode; a Personal Team can be used for personal device testing with Apple's provisioning limitations.

## Allow physical iPhone debugging

1. Connect the iPhone 15 to the Mac over USB. Unlock it and choose **Trust This Computer** when asked.
2. In Xcode, open the device manager (Devices and Simulators / Device Hub, depending on Xcode version), pair the phone, and wait for device preparation to finish.
3. On iPhone, enable **Settings → Privacy & Security → Developer Mode**, restart, then confirm. If the setting is absent, pair with Xcode first.
4. In Xcode settings, add your Apple Account yourself. In the app target's **Signing & Capabilities**, select your team and use a unique bundle identifier if required. No password or developer credential needs to be sent in chat.
5. Choose the physical iPhone as the run destination. Allow microphone, speech recognition, and local-network access when Chumi asks.

Once this is set up, a coding agent with terminal access to this Mac can invoke `xcodebuild`, inspect `xcrun simctl` simulator state, and use available Apple device tools to build, install, and collect logs. Any macOS automation or Developer Tools prompt still needs to be approved on the Mac. Full Disk Access is not a general prerequisite. Direct remote touch control of a physical iPhone is not implied by terminal access.

Apple references: [Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device), [running on a simulator or device](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices).

## Connect to the Mac

Run from the source checkout with Node 24+ and dependencies installed.
First configure your AI provider in Chumi.app, then quit it: the companion shares its data and port.

```bash
npm run mobile:setup
npm run start:mobile
```

Keep the terminal open; use the desktop UI at `http://127.0.0.1:4777` in a browser.
Stop with Ctrl-C before reopening Chumi.app, which does not start the companion.

The setup command writes private credentials and a self-signed TLS certificate under `~/Library/Application Support/Chumi/mobile/` (or `CHUMI_DATA_DIR/mobile/`). It prints a JSON pairing code containing the Mac URL, a random bearer token, and the certificate's SHA-256 fingerprint. It does **not** start a listener by itself. Keep this code private.

On the phone, open **连接 Mac**, paste the whole JSON line (Universal Clipboard is convenient), and verify the connection. The phone and Mac must be on a network where they can reach each other. If macOS asks about incoming connections, permit the Node process used by Chumi. Guest Wi-Fi and enterprise networks may block device-to-device connections.

If the default `.local` hostname does not resolve, choose the Mac's reachable LAN IP:

```bash
npm run mobile:setup -- --rotate --address 192.168.1.20
```

Restart `npm run start:mobile` and pair again; rotation revokes the old pairing.
Changing `--address` or `--port` requires `--rotate`; setup without options reprints the existing pairing.
Keep this personal companion off the public internet.

Certificates expire after 365 days. Invalid pairing disables only phone access; the desktop shows a notice.
For missing pairing, run setup. Otherwise rotate as above (include `--port` if customized), restart, and pair again.

The desktop web API still binds to `127.0.0.1:4777`. The explicit `CHUMI_MOBILE=1` mode additionally enables an authenticated HTTPS companion on port 4778, with a small allowlist of mobile endpoints. It does not expose desktop settings, arbitrary shell commands, or unrestricted mybot endpoints. No Codex or Claude login credentials are transferred to iPhone. Only the meeting text you explicitly sync is sent to the Mac; AI prompts then follow the Mac's selected provider configuration. Original audio remains on the phone.

Pairing configuration persists across launches; the companion listener starts only in mobile mode. Stopping the companion server disconnects the phone, while locally saved meetings remain available.

## Code layout

```text
ios/Chumi/
  Design/      colour tokens, shared components and Markdown rendering
  Models/      meetings and their local, atomic storage
  Networking/  pairing and the pinned HTTPS client
  Recording/   microphone capture and on-device recognition
  Views/       Home, Meeting (detail, recorder, sync, transcript, assistant, sheets) and Connection
```

`Design/Theme.swift` mirrors the `:root` variables in `web/src/styles.css`, light and dark; change both together so the phone and Mac stay alike. The app icon and in-app logo are rendered from the Mac icon's source, `native/tools/make_icon.swift` (use `--full-bleed` for the iOS icon).

Format Swift code with `npm run ios:format`. It uses the `swift-format` bundled with Xcode and `ios/.swift-format`.

## Verification

```bash
npm run check
bash ios/Tests/run-core-checks.sh
npm run ios:format -- --check
npm run ios:doctor
npm run ios:build
```

After a real build, test on the iPhone: deny and grant permissions, record in airplane mode, interrupt recording with a call or backgrounding, stop and reopen the meeting, restart the app, pair with the Mac, disconnect Wi-Fi, retry the same sync, ask with and without project context, and rotate the pairing code. Verify that retries do not duplicate transcript lines and that a stale snapshot cannot overwrite a newer one.

## Scope of the first version

- Apple Speech's selected locale is not a guarantee of accurate Chinese-English code switching. Zipformer Small bilingual is a next ASR integration, pending linked SDK/model and real-device validation.
- Recording stops and saves when the app enters the background or audio is interrupted. Continuous background recording is not included. This version does not capture other iOS apps' system audio or slides.
- Audio is saved as uncompressed CAF in Files → Chumi → Recordings, approximately 11.5 MB per minute for mono 48 kHz input and more for stereo. Export or remove recordings in Files when storage is limited.
- AI requests require the Mac to be reachable. There is no relay, push notification, or always-on cloud runtime yet.
- Reviewed handoffs and agent execution remain in the Mac app. The phone's first version handles meeting capture and AI assistance; it does not yet provide remote code execution or agent approval dialogs.
- This personal companion reuses the Mac's selected provider. Distribution to other users needs the providers' supported product authentication and billing flows.
