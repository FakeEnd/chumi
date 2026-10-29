# Chumi for Windows

The Windows desktop app uses Electron for its own window and a small C++ WASAPI helper for live audio. Its installer includes Chromium, Node 24, the audio helper, whisper.cpp and the official Codex CLI. Users do not need Node, .NET, Python, a compiler or WebView2 installed.

The current build targets **Windows 10/11 x64**. Windows on ARM and 32-bit Windows do not have a native package in this release. This build has been exercised on the development Windows 11 machine; Windows 10 and other hardware still need release qualification.

## Install and start

1. Open `Chumi-Setup-0.1.0-x64.exe`. Installation is per user and does not require administrator privileges.
2. Open Chumi from the Start menu or desktop shortcut.
3. On a new computer, the home checklist offers **Download speech model**. The app downloads its selected model and starts local speech recognition when the download finishes. Other models remain available in Transcription settings.
4. Choose an AI provider. **Sign in with ChatGPT** opens the official Codex browser sign-in. Existing Codex and Claude Code sign-ins are also detected. Local and compatible API providers remain available in Settings.
5. Start an in-person, online or hybrid meeting.

The installer is built locally from this branch under `dist/`; it has not been published as a GitHub release. The current development build is unsigned.

## Audio

- **Microphone:** the Windows default input, or a microphone selected in Audio settings. Windows controls access through **Settings → Privacy & security → Microphone → Let desktop apps access your microphone**.
- **Computer audio:** WASAPI loopback of the current default multimedia output device. It works with speakers or headphones and needs no additional recording permission. It captures all sound routed to that output, including notification sounds.
- **Both:** separate microphone and computer-audio streams, with the existing transcript duplicate filtering. Use headphones to reduce acoustic echo. This version does not claim software echo cancellation on Windows.
- **Device changes:** capture reconnects when the default device changes or the selected device returns. The shared session clock continues across reconnections.
- **Silence:** loopback can stop producing packets when no application is playing sound. The helper advances its timeline with silent frames so speech segmentation still finishes correctly.

The helper emits the same `CHA1` 16 kHz mono PCM protocol and JSON status events as the macOS helper. Its only DLL imports are Windows system libraries; it needs no .NET or separately installed C++ runtime.

## Desktop behaviour

- A single Chumi window with normal Windows move, resize, minimize and maximize controls; size and position are remembered.
- A transparent, always-on-top desktop pet reuses the same character, toolbar and answer cards as macOS. Enable it in **Settings → Desktop pet** or **窗口 → 桌宠**. Drag the character to move it; empty areas pass clicks through, and only the Ask box takes keyboard focus. Size, tag filters, screen-capture visibility and resetting its position use the shared settings.
- The backend and audio engine run without console windows. Closing Chumi shuts them down and saves an active meeting as interrupted, ready to resume next time.
- A second launch brings the existing window forward. A separate older Chumi server using the same data folder is reported before starting another backend.
- Native project folder selection, export save dialogs and external links in the default browser.
- Default global shortcut: **Ctrl+Alt+L** to start, pause or resume. Recording keeps the computer awake.
- Window screenshots use Electron's Windows capture support and feed the existing slide-change detection and image context pipeline.
- API keys are encrypted with Windows account protection through Electron `safeStorage`, outside the settings database.
- The Transcription speed/accuracy check uses bundled English and Mandarin example clips; it does not require installed speech voices.

## Data and agents

Data stays in `%LOCALAPPDATA%\Chumi`: the database, models, captures, handoffs, encrypted API keys and logs. `CHUMI_DATA_DIR` and `CHUMI_MODELS_DIR` still work for development and isolated acceptance runs.

Chumi bundles the official Codex CLI so new users can sign in and use it without installing npm. Other coding agents are discovered through `PATH`, `%APPDATA%\npm` and `%USERPROFILE%\.local\bin`. Connecting an agent registers the bundled Node and installed MCP server paths. Reconnect an existing registration if it points to an older checkout.

**Continue in an agent** opens its console in the chosen project folder. The first message points to the reviewed handoff file; the agent can retrieve original passages and screenshots over MCP. Details are in [agents.md](agents.md).

**Continue in Codex app** prepares an immutable handoff file and asks Windows to open the installed app's `codex://` handler with a prefilled composer. The user still clicks Send in Codex. **Copy instructions** remains available. Action progress, result links and the next-meeting project brief use the same workflow as macOS. Saved audio plays from transcript lines and exports as WAV on Windows.

DeepSeek Harness is found through `dsh` on `PATH` or the install folder recorded in its uninstall entry (`resources\runtime\cli\bin\dsh.cmd` there), including folders with Chinese characters. If it has no uninstall entry, **Choose DeepSeek Harness…** in Settings → Coding agents takes its folder. Its settings live in `%USERPROFILE%\.dsh` unless `DSH_HOME` is set. **Connect** registers Chumi; **Test a real agent read** can use the API key already saved in Harness, without setting an environment variable. This was verified with a real model on Windows.

To continue there, Chumi copies a one-line instruction and opens Harness. Open the project folder, start a new session and paste. The snapshot preserves the reviewed handoff; its original evidence remains available through MCP. Copying Chinese text and bringing the existing app forward are verified, as is a full read-only CLI handoff that reads the evidence and proposes a plan. Pasting into a new Harness GUI chat remains a manual check. See [verification.md](verification.md).

## Build from source (developers)

Requirements: Python 3, Node 24 with npm, and MinGW-w64 `g++` on `PATH`. The build uses static C++ linking; the compiler is needed only on the build machine.

Use Node 24 first on `PATH`, install dependencies with `npm ci`, then:

```text
python scripts/build-windows.py --node E:\APPs\NodeJS24\node.exe
python scripts/build-windows.py --installer --node E:\APPs\NodeJS24\node.exe
```

The first command creates `dist/win-unpacked/Chumi.exe`; the second also creates the installer. `--native-only` builds just `build/chumi-audio.exe`. `CHUMI_NODE` can select the Node executable instead of the argument.

The script stages production dependencies, the speech engine from `build/whisper`, the official pinned Codex CLI and app-local Microsoft runtime DLLs needed by the speech engine. Set up `build/whisper` using the existing `scripts/setup.ps1` developer setup, or extract the official whisper.cpp Windows build there. The current speech engine is b5454 CUDA 12.4, with CPU backends also included. The smaller CUDA 11.8 archive is not suitable: it omits cuBLAS and can silently fall back to CPU.

Audio protocol checks and desktop acceptance results are recorded in [verification.md](verification.md).
