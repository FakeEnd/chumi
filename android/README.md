# Chumi for Android

Records a meeting on the phone and sends the audio to Chumi on your computer, which transcribes it and does everything else. How it works, pairing and security: [docs/phone.md](../docs/phone.md).

The app is plain Kotlin on Android's own APIs, with no library dependencies:
- `AudioRecord` in a foreground service;
- `HttpURLConnection` and `org.json`;
- a `WebView` for Chumi's interface.

It needs Android 11 (API 30) or later.

| File | What it does |
|---|---|
| `Frames.kt` | Chumi's `CHA1` audio frame format, shared with the macOS helper and the server; unit-tested. |
| `ChumiClient.kt` | Pairing and Chumi's HTTP API; the pairing kept in private preferences. |
| `RecorderService.kt` | Records 16 kHz mono speech audio and streams it to the computer. Holds up to 10 minutes in memory while offline, follows pause and end from either side. |
| `MainActivity.kt` | Pairing, meeting controls and status. |
| `WebUiActivity.kt` | Chumi's full interface from the computer, signed in with the device token. |

## Build

Requirements:
- JDK 17 or newer.
- The Android SDK with platform 36 and build-tools 36.0.0. Android Studio installs these, or use `sdkmanager "platforms;android-36" "build-tools;36.0.0" "platform-tools"`.
- `ANDROID_HOME` set, or `sdk.dir` in `android/local.properties`.

```bash
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

To install on a phone, turn on **Developer options → USB debugging** and connect it by USB. On Android 11 and later you can use **Wireless debugging** with `adb pair` instead.

If `dl.google.com` is unreachable, use a mirror:
- **Gradle.** A Gradle init script (`gradle -I mirrors.init.gradle.kts …`) can point `google()` at a mirror such as `https://maven.aliyun.com/repository/google`. That keeps the mirror out of the project.
- **The SDK.** `SDK_TEST_BASE_URL=https://mirrors.cloud.tencent.com/AndroidSDK/` does the same for `sdkmanager`.
