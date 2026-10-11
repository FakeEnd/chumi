# Chumi native (macOS)

Two Swift programs, built with the Command Line Tools compiler (no Xcode project):

| Output | What it is |
| --- | --- |
| `build/chumi-audio` | Audio capture helper (dev copy). Streams 16 kHz mono PCM on stdout. |
| `build/Chumi.app` | App shell: runs `node server/main.ts`, shows the web UI in a WKWebView. Contains the helper at `Contents/MacOS/chumi-audio`. |

```
native/
  build.sh              build + assemble + codesign
  entitlements.plist    com.apple.security.device.audio-input (needed only with the hardened runtime)
  audio/                chumi-audio sources + embedded Info.plist
  app/                  Chumi.app sources + Info.plist template (ChumiRepoPath is filled in by build.sh)
  tools/make_icon.swift draws the app icon (optional build step)
```

## Build

```sh
bash native/build.sh
```

* Target `arm64-apple-macos14.4` (override with `CHUMI_TARGET`), `swiftc -O -swift-version 5`.
* Signs ad-hoc by default (`codesign --force --sign - --timestamp=none`), helper first, then the app,
  then the dev copy of the helper. Set `CHUMI_SIGN_IDENTITY="Apple Development: …"` to use a real
  identity; the build then also enables the hardened runtime with the audio-input entitlement.
* Idempotent: `build/Chumi.app` is recreated every time; intermediates live in `build/.intermediates`.
* `ChumiRepoPath` in `Chumi.app/Contents/Info.plist` is set to the repo root (the parent of `native/`).

## `chumi-audio`

```
chumi-audio --source mic|system|both [--mic-device <CoreAudio UID>] [--aec on|off] [--chunk-ms 50]
            [--self-responsible] [--ignore-stdin] [--debug]
chumi-audio --list-devices        # [{"uid","name","isDefault","inputChannels"}] (input devices only)
chumi-audio --check-permissions   # {"microphone":"granted|denied|notDetermined|restricted","systemAudio":"granted|denied|unknown","systemAudioMethod":"tcc_preflight|none"}
chumi-audio --request-mic         # shows the microphone prompt if undetermined, prints the same JSON
chumi-audio --help | --version
```

* `--aec` defaults to `on` for `--source both`, otherwise `off`. AEC = `AVAudioInputNode` voice
  processing with "other audio" ducking set to minimum / advanced ducking off.
* `--chunk-ms` 10–1000 (default 50 → 800 samples per frame).
* `--ignore-stdin` disables "exit on stdin EOF" (handy when running by hand with `< /dev/null`).
* `--debug` (or `CHUMI_AUDIO_DEBUG=1`) adds `{"type":"debug",…}` lines: formats, stream layout, etc.
* `systemAudio` in `--check-permissions` uses the private, read-only `TCCAccessPreflight` if it can be
  resolved; only 0 → `granted` and 1 → `denied` are mapped, anything else is `unknown` (on this
  machine "not yet decided" returns 2 → `unknown`).

### stdout: binary frames (little-endian), nothing else

```
0..3   "CHA1"
4      source: 1 = mic, 2 = system
5      flags = 0
6..7   u16 reserved = 0
8..15  f64 timestamp of the first sample, seconds since helper start (mach host clock)
16..19 u32 N
20..   N × int16, mono, 16000 Hz
```

Frames are normally exactly `chunk` samples. A shorter frame is written before a timestamp
discontinuity (device change, restart, >200 ms drift between device and host clock) and at shutdown.
Timestamps come from the capture host time of each buffer and are contiguous otherwise.
If the reader stops consuming, at most ~8 MB is queued; beyond that frames are dropped with a
`stdout_backpressure` warning.

### stderr: one JSON object per line

| type | fields / codes |
| --- | --- |
| `ready` | `sources` (running), `micDevice`, `micUID`, `aec` (true only if voice processing really got enabled), `systemOutputDevice`, `pending` (sources still starting, usually waiting on a permission prompt), `sampleRate`, `chunkMs`, `pid` |
| `source_started` | `source`: a source listed in `pending` came up after `ready` |
| `level` | `source`, `rms`, `peak` in dBFS (floor −120), ~10 Hz per source, computed on the 16 kHz output |
| `permission` | `kind:"microphone"`, `status` |
| `warning` | `system_silent` (≥15 s of digital silence; re-armed when signal returns), `mic_silent` (≥10 s of exact zeros; says so explicitly when a MacBook lid is closed), `system_permission_pending`, `mic_start_pending`, `aec_unavailable`, `mic_device_not_found`, `mic_device_select_failed`, `stdout_backpressure`, `resampler_failed`, `self_responsible_failed`, `self_responsible_protected_location` |
| `info` | `system_silent_cleared`, `mic_silent_cleared` |
| `error` | `mic_permission_denied`, `no_input_device`, `mic_start_failed`, `system_tap_failed`, `system_tap_unsupported`, `bad_arguments` (exit 2) |
| `device_changed` | `kind:"input"` (`name`, `uid`, `previous`) or `kind:"output"` (`name`) |
| `stopped` | `reason`: `signal`, `stdin_closed`, `stdout_closed`, `error`; `forced:true` if the watchdog had to exit |

### Lifecycle

* Exits on SIGTERM/SIGINT/SIGHUP, stdin EOF and broken stdout. Shutdown stops both sources
  concurrently with a 1.5 s deadline, flushes partial frames, writes `stopped`, and exits. A 4 s
  watchdog hard-exits if the main thread is stuck. coreaudiod removes the private tap and aggregate
  device when the process dies in any case.
* Exit code is 0 unless no source could start (1) or the arguments are bad (2). In `both` mode a
  failing source gets an `error` event and the other keeps running.
* `both`: the mic starts first. The system tap starts once the mic is up, or after 1.5 s if the mic is
  still waiting on its prompt. `ready` waits for both, up to 5 s; after that it lists what is running
  and puts the rest under `pending`.

### Microphone

AVAudioEngine input tap → mono (channel 0 only when voice processing is on; macOS reports 9 channels
there) → AVAudioConverter → 16 kHz → Int16. `--mic-device` sets `kAudioOutputUnitProperty_CurrentDevice`
on the input node's AU. The tap format comes from the hardware format, because the node's output format
can still describe the previous device. The engine restarts on `AVAudioEngineConfigurationChange` and
default-input changes, but ignores no-op notifications and rate-limits restarts.

### System audio

`CATapDescription(stereoGlobalTapButExcludeProcesses: [own process object])`, private, unmuted →
private aggregate device (main sub-device = default output, tap auto-start, drift compensation) →
`AudioDeviceCreateIOProcIDWithBlock` (IO thread: downmix only, then hand off) → 16 kHz → Int16.
Rebuilt when the default output device or its sample rate changes. If the output device also has
input streams (headsets, or the speakers while voice processing is active), only the tap's buffers
are read, and the sub-device inputs are switched off via `kAudioDevicePropertyIOProcStreamUsage`.
All Core Audio work for the tap runs on its own queue, because creating the IOProc blocks while macOS
shows the System Audio Recording prompt.

## Permissions (TCC) behaviour

macOS attributes privacy permissions to the *responsible* process:

* **Through Chumi.app** (app → node → helper): permissions belong to **Chumi**, using
  `NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription` from the app's Info.plist. Do not
  pass `--self-responsible` in this setup.
* **From a terminal**: permissions belong to the terminal app (Terminal, iTerm, VS Code, Claude Code…).
  If that app has no `NSAudioCaptureUsageDescription`, system audio is silently denied and the tap
  delivers zeros (→ `system_silent`).
* **`--self-responsible`**: re-execs itself with `responsibility_spawnattrs_setdisclaim` (looked up via
  dlsym), so the helper (`local.chumi.audio`, embedded Info.plist) becomes its own TCC identity. If the
  binary is in `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive, macOS first asks whether
  "chumi-audio" may access that folder, and the process blocks in dyld until the prompt is answered.
  A `self_responsible_protected_location` warning is printed.
* **Ad-hoc signing**: TCC identifies ad-hoc signed code by its cdhash, so every rebuild counts as a new
  app and permissions (mic, system audio, Documents folder) are asked again. Sign with a stable
  identity via `CHUMI_SIGN_IDENTITY` to avoid this.
* While a permission prompt is open, Core Audio calls from that process can block (IOProc creation,
  and even starting a voice-processing mic engine). The helper keeps running, emits
  `system_permission_pending` / `mic_start_pending`, and still shuts down cleanly.
* A MacBook with its lid closed delivers exact zeros from the built-in mic (→ `mic_silent` with a
  specific message).

## Chumi.app

* Finds node: `/opt/homebrew/bin/node`, `/usr/local/bin/node`, then `zsh -lc 'command -v node'`.
* If `http://127.0.0.1:4777/api/health` returns JSON with `"app":"chumi"`, it connects to that server
  and does not stop it on quit.
* Otherwise it picks the first free port in 4777–4790 and runs `node <repo>/server/main.ts` with
  cwd = repo and env plus `CHUMI_APP=1`, `CHUMI_AUDIO_HELPER=<bundle>/Contents/MacOS/chumi-audio`,
  `PORT`, and `PATH` prefixed with `/opt/homebrew/bin:/usr/local/bin`. The server's stdin is a pipe the
  app keeps open (EOF means the app is gone). stdout and stderr are appended to
  `~/Library/Logs/Chumi/server.log`.
* Before spawning, the app reads `server/main.ts` itself, so the one-time "access files in your
  Documents folder" prompt happens while the loading view says so, not inside node's 30 s health window.
* Polls `/api/health` every 250 ms for up to 30 s, then loads `http://127.0.0.1:<port>/`. On failure
  it shows an alert with the log tail and offers Quit / Open Log / Try Again. If the server dies later,
  it offers Restart Server / Quit.
* On quit: SIGTERM to the server, wait up to 3 s, then SIGKILL.
* WKWebView: Web Inspector enabled (right-click → Inspect Element); JS alert/confirm/prompt as NSAlert
  sheets; `target=_blank` / `window.open` and external links open in the default browser; `<input
  type=file>` via NSOpenPanel; downloads (attachment / non-displayable responses / `download` links /
  blob URLs) go to `~/Downloads` with unique names ("name (1).ext") and are revealed in Finder.
* Menus: App (About, Hide, Quit ⌘Q), Edit (Undo/Redo/Cut/Copy/Paste/Select All), View (Reload ⌘R,
  Open in Browser ⇧⌘O, zoom, Show Server Log, Full Screen), Window (Close ⌘W, Minimize, Zoom, Bring
  All to Front). Closing the window keeps the app (and recording) running; click the Dock icon to
  reopen it.
* The window is 1440×900 by default, minimum 1000×640, and its frame is remembered
  (`ChumiMainWindow`).
* When launched from Finder or `open`, the app does not see shell variables from `~/.zshrc`. Only PATH
  is extended.
