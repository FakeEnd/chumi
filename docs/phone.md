# Chumi on a phone (Android, preview)

The Chumi Android app records a meeting on the phone and sends the audio to Chumi on your computer. The computer does everything else, as it does for its own microphone:
- It transcribes the audio and answers questions with your ChatGPT or Claude plan.
- It writes the summary and the handoff, and serves meeting evidence to your coding agents.

The phone also opens Chumi's full interface, so you can follow the transcript, catch up and ask questions there.

## Why the phone works through the computer

- **Subscriptions.** Chumi uses your existing ChatGPT or Claude plan through the Codex and Claude Code command-line tools. Those tools run on a computer, not on a phone.
- **Coding agents.** The handoff to Claude Code, Codex, opencode or Qwen Code happens in your project folders, which live on the computer.
- **Audio.** Android does not let apps record call audio from other apps (`AudioPlaybackCapture` excludes voice communication). So a phone cannot capture a Zoom or Tencent Meeting call; it records the room through its microphone. That makes it most useful for in-person meetings, with the computer handling online ones.

The same connection works with any Chumi server the phone can reach, so a Chumi running on a server instead of a laptop would need no change on the phone.

## Set up

1. **On the computer:** open **Settings → Phone** and turn on **Allow paired phones to connect over the network**. Chumi listens on port 4787 (`remote.port` in the settings).
2. **Install the app** on the phone; see [android/README.md](../android/README.md). It needs Android 11 or later.
3. **Pair.** On the computer, click **Pair a phone**. In the app, enter one of the addresses shown and the six-digit code. The code works once, for five minutes, and stops after five wrong guesses.

The phone and the computer must reach each other:
- on the same Wi-Fi network;
- on the same VPN, such as Tailscale (use the computer's VPN address);
- not over guest networks that isolate devices.

## Record a meeting

- **Start.** In the app, tap **Record a meeting on this phone**. Chumi on the computer starts a session whose source is the phone. You can also open Chumi's interface from the app.
- **Pause, resume, end.** These work from the phone or from the computer. While the meeting is paused, the phone discards audio rather than sending it later. **End meeting** first sends what is still buffered, then ends the session, and Chumi writes the summary.
- **Recording with the screen off.** The app records in a foreground service with a notification, so it keeps going with the screen off.
- **When the network drops.** The phone keeps recording and holds up to ten minutes of audio in memory. It reconnects with back-off and sends what it held. After reconnecting it resends its last five seconds; Chumi drops audio it already received, so nothing is transcribed twice.
- **What is lost.** Audio held in memory is lost if the app is closed while offline. Nothing is written to the phone's storage.

## Security and privacy

- **Off by default.** Phone access is a separate listener on its own port, off until you turn it on. Chumi's main interface stays on `127.0.0.1` with its host check.
- **Pairing.** A paired phone gets a random 256-bit token and sends it with every request, as a bearer header or, in the app's web view, an HttpOnly cookie. Chumi stores only a SHA-256 hash of each token (`remote-devices.json` in the data folder). **Remove** in Settings revokes a phone at once.
- **What a phone cannot do.** It cannot read or change API keys, create pairing codes, manage paired phones, or use developer routes. It can do everything else in Chumi's interface.
- **No encryption.** The connection is plain HTTP. On your own network or over Tailscale (which encrypts) that is reasonable. Don't use it on public Wi-Fi.
- **Backups.** The app keeps its token out of Android backups and device transfers.

## How the audio travels

Pairing and status:
- `POST /api/remote/pair {code, name}` returns `{token}`.
- `GET /api/remote/whoami` returns Chumi's status: `idle`, `recording` or `paused`. It also says whether the source is the phone and whether a phone is connected.

The audio goes up in `POST /api/remote/audio?capture=<id>`:
- The body is a long chunked upload of the same `CHA1` frames the macOS audio helper writes ([native/README.md](../native/README.md)): 16 kHz mono 16-bit PCM in 50 ms frames, each with its time since the capture started.
- `capture` identifies one recording on the phone. Chumi keeps each capture's clock, so audio resent after a reconnect lands at the same time, and anything it already has is dropped.
- A new capture is placed after what was received.
- The upload is refused (409) unless a session is recording from the phone.

On the computer, the upload feeds `PhoneCapture` (`server/audio/phone.ts`), an input like the native helper's. From there the audio goes through the same segmenter, transcriber and speaker capture.

## Verification

`node scripts/phone-trial.ts` plays a stand-in phone: it pairs, starts a session and uploads the sample meeting at 8× speed. Partway through, it breaks the connection mid-frame, reconnects, and resends five seconds. All 19 checks pass on macOS with real Whisper:

| Area | Checks |
|---|---|
| Access | Phone access is off by default. Unpaired requests and wrong codes are refused. Phones cannot reach API keys, pairing or developer routes. |
| Recording | The phone starts and ends the session, and the transcript matches the sample. |
| Dropped connection | After the drop the session keeps recording; the resent audio adds no duplicate lines, and line times stay in order. |
| After the meeting | Uploads after the end are refused, and so is a removed phone. |

`tests/remote.test.ts` covers pairing codes, token storage, and frame timing across reconnects. `android/` has a unit test for the frame format.

The app builds and passes lint; it has not yet run on a physical phone.

## Next

- **On a real phone.** Long meetings with the screen off, and moving between Wi-Fi and mobile data. Android may defer network access for apps in Doze; the app may need to ask to be exempt from battery optimisation.
- **Easier pairing.** A QR code in Settings instead of typing the address and code.
- **A native live view** of the transcript and catch-up on the phone, alongside the web interface.
- **Offline meetings.** On-device transcription with sherpa-onnx, which Chumi already uses for speaker labels and which has Android streaming models for English and Chinese. The result syncs to the computer later.
- **HTTPS** with a certificate pinned at pairing, for networks without a VPN.
