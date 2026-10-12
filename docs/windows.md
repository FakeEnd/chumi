# Chumi on Windows (preview)

Chumi's server, speech recognition, AI providers, summaries, handoffs and the coding-agent connection run on Windows 10/11 (x64). Live microphone and computer-audio capture do not yet: they need a Windows version of the native audio helper (see [Next](#next)). Open the interface in a browser; there is no Windows app window yet.

## Set up

Requirements:
- Node.js 24 or newer, first on `PATH`.
- Git.
- `curl.exe` (included with Windows 10 1803 and later).
- An NVIDIA GPU is optional. With one, speech recognition uses the CUDA build of whisper.cpp; without one, the CPU build and a smaller model.

```powershell
git clone https://github.com/FakeEnd/chumi.git
cd chumi
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

`scripts\setup.ps1` does the following, and running it again is safe:
1. It puts whisper.cpp in `build\whisper`. With an NVIDIA GPU it uses the CUDA 12 build (about 680 MB), which includes cuBLAS.
2. It installs the npm dependencies.
3. It downloads the speech model that suits the computer into `%LOCALAPPDATA%\Chumi\models`. With an NVIDIA GPU of 4 GB or more, that is Large v3 Turbo.
4. It builds the web interface.

On networks that need it, pass a proxy (`-Proxy http://127.0.0.1:7890`) or a model mirror (`-ModelBaseUrl https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main`).

The smaller CUDA 11.8 build does not include cuBLAS. whisper.cpp then quietly falls back to the CPU and cannot keep up with a large model, so the setup script never uses it.

Then sign in to an AI provider (`codex login`, or another provider in Settings), run `npm start`, and open http://127.0.0.1:4777. If an older Node comes first on `PATH`, a small `.cmd` file can put Node 24 first and run `node server\main.ts`. Closing its console window shuts Chumi down cleanly.

## What is different on Windows

- **Data** lives in `%LOCALAPPDATA%\Chumi`: the database, models, captures, handoffs and `logs`. `CHUMI_DATA_DIR` and `CHUMI_MODELS_DIR` still override it.
- **Command-line tools** are found through `PATH` and `PATHEXT`, plus `%APPDATA%\npm`, `%USERPROFILE%\.local\bin` and `build\whisper`. Tools that npm installs as `.cmd` shims (Codex, opencode, Qwen Code) are started through `cmd.exe` with safe quoting. When Chumi stops one, it stops the whole process tree.
- **Codex** before 0.13x knows fewer feature names and refuses to start when asked to disable one it doesn't know. Chumi reads `codex features list` first and disables only the features that version has.
- **Continue in an agent** opens a new console window in the project folder. `cmd.exe` cannot pass a multi-line argument, so the agent's first message is one line pointing to the handoff file (`%LOCALAPPDATA%\Chumi\handoffs\…md`). That file holds the same instructions macOS passes directly.
- **The folder picker** is the standard Windows folder dialog.
- **Privacy settings** open the Windows microphone page.
- **Notifications** are not shown yet.
- **API keys** for the Anthropic API and compatible providers are stored in the macOS Keychain, which Windows does not have. Use a subscription provider (Codex or Claude Code) or a local model server without a key for now.

## Verification

The development machine for this check: Windows 11 Home (build 26300), i9-12900H, 48 GB, RTX 3060 Laptop 6 GB (driver 616.92), Node 24.21.0, whisper.cpp b5454 CUDA 12.4.

| Check | Result |
|---|---|
| `npm run typecheck`, `npm test` | Both TypeScript projects pass; 135 / 135 tests. |
| `scripts\setup.ps1` | Ran from scratch and again; the second run skips what is installed. |
| CUDA | whisper.cpp loads the CUDA backend and keeps the 874 MB model in GPU memory. |
| `node scripts/acceptance.ts` (offline test provider, real Whisper) | 16 pass, 0 fail, 2 manual, the same as on macOS. Includes crash recovery. At 8× speed, utterances are transcribed in about 0.8 s each. |
| Codex provider status | Chumi reads the ChatGPT plan, its weekly window and credits through Codex 0.125's app-server. |
| `node scripts/acceptance.ts --provider codex` (ChatGPT plan, gpt-5.5) | 13 pass, 0 fail, 2 manual, the same as the Claude-plan run on macOS. The summary had 73 citations, all supported. It kept the GATA result tentative, left the rerun's deadline as "not stated" and kept the Friday deadline. Deep answers were about 2.4× longer than quick ones. |
| `Chumi.cmd` launcher | Starts the server with Node 24 first on `PATH`; speech recognition and the ChatGPT plan report ready. |

Not yet checked on Windows: Claude Code, opencode and Qwen Code, and opening the agent console from the UI.

## Next

1. **A native audio helper**: `chumi-audio.exe`, speaking the same protocol as the macOS helper ([native/README.md](../native/README.md)). That protocol is binary `CHA1` frames of 16 kHz mono PCM on stdout, and JSON events on stderr.
   - The microphone comes through WASAPI.
   - Computer audio comes through process loopback, excluding Chumi's own process (Windows 10 build 20348 and later, so every Windows 11). This matches what the macOS process tap records.
   - Echo cancellation for mixed meetings comes from the communications audio path.
2. **The remaining helpers**: window capture (Windows.Graphics.Capture), the global shortcut (`RegisterHotKey`), and API keys in the Windows Credential Manager.
3. **An app window** around the interface (WebView2), so Windows has a window like Chumi.app.
