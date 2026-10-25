# Verification log

## Desktop handoff and project work — 2026-10-25

On the development Mac. All new workflow checks use synthetic meetings, temporary or in-memory databases, and injected desktop openers.

| Check | Result |
|---|---|
| `npm run check` | Both TypeScript projects and translation checks pass; **280 / 280 tests pass** in the current working tree. Coverage includes schema migration, project isolation, mixed-project redrafting and explicit retargeting, version conflicts, draft preservation, late responses, completed-action context, clipboard fallback, and immutable desktop handoff snapshots. |
| Desktop links | Injected openers verify the workspace and prefilled prompt without opening Codex. Windows tests run the actual navigation/IPC callbacks; a compiled Swift harness checks allowed and rejected Codex links. Unsupported actions and malformed URLs are refused. |
| `npm run build:web` | Production build passes. The existing JavaScript chunk-size warning remains. |
| `bash native/build.sh app` | Mac helper and application rebuild successfully using temporary compiler caches; code-signature verification passes. |
| Browser smoke test | Final production bundle in Chrome with an isolated memory fixture: save and reopen a project agenda; preserve an action draft across a simulated update from another window; compare and explicitly accept the new version; save completed status and a result link; reopen persisted results; navigate to the source handoff; verify the default Codex app destination and mocked launch request; verify project preselection in Start session. No recording was started. |
| `git diff --check` | Passes. |
| Merged with main (PRs #18–#24) | Where this work and main had fixed the same bug, main's fix was kept: late transcription is tagged with its own meeting (the next meeting can start at once), capture restarts back off and then pause, cancelled queued AI jobs settle when their turn comes, session reloads use main's sequencing, and main's CI workflow is the only one. Kept from this work, on top of main: shutdown guards and a transcriber `stop()`, stale-run event guards, summary-startup failures that still release the session, per-overview tokens, safe question submission and compact view. Added to main's session loading: a reload re-reads once when the title, project, speakers or handoff change during it; a session deleted while disconnected leaves the view; a late progress event cannot reopen a finished answer; ending a meeting no longer jumps away from another one being read. Tests for the replaced designs were removed or rewritten. `npm run check`: 306 / 306 tests; `npm run build:web` and `bash native/build.sh app` pass. |

The desktop launch was simulated: this pass did not open a real Codex conversation, send a model request, or run the Windows desktop application. A successful OS open request means the composer was requested, not that work started or completed. Progress remains user-maintained; project agendas are saved notes and are not automatically injected into meeting AI context. The Mac bundle was built but not launched over any existing session.

## Startup, shutdown and settings reliability — 2026-10-25

On the development Mac. Tests use synthetic audio, temporary or in-memory databases, and stub AI and speech providers.

| Check | Result |
|---|---|
| `npm run check` | Both TypeScript projects and translation checks pass; **246 / 246 tests pass**. Regression coverage includes duplicate-server startup and port conflicts, capture restart exhaustion, cancellation during Codex initialization, invalid handoff output and transactional draft replacement, meeting-specific context caching, and speech-settings races. |
| Isolated commit snapshot | After separating unrelated existing working-tree changes, both TypeScript projects, translation checks, **239 / 239 tests**, and the production web build pass against an export of the Git index. The 246-test working-tree run above also included separate vendor tests that are not part of this commit. |
| Native shutdown | A compiled Swift harness runs the actual server manager against Node children: a save that takes more than three seconds completes before exit, and a hung child is terminated within the configured deadline. The desktop shutdown allowance is now aligned with the backend's 15-second cleanup budget, with a two-second exit margin. |
| `npm run build:web` | Production build passes. The existing warning for a JavaScript chunk above 500 kB remains. |
| `bash native/build.sh app` | Mac helper and application rebuild successfully; code-signature verification passes. The newly built application was not launched over an existing session. |
| Browser smoke test | Production bundle in Chrome against an isolated in-memory fixture: compact mode preserves 2× playback and seeks to the selected transcript line; a delayed settings response preserves edits made while saving; ending disables speech settings and benchmarking; privacy text follows self-hosted Qwen, ElevenLabs, and Alibaba selections, including the configured destination. The start-session dialog also shows the Alibaba destination. |
| `git diff --check` | Passes. |

Not rerun in this pass: real microphone/system capture, real vendor model requests, or the Windows desktop runtime. Shutdown still uses a bounded four-second transcription drain and marks unfinished work interrupted; these changes do not add a durable transcription queue.

## Session and handoff reliability — 2026-10-24

On the development Mac. Tests use synthetic audio, in-memory or temporary databases, and stub AI providers.

| Check | Result |
|---|---|
| `npm run check` | Both TypeScript projects and translation checks pass; **195 / 195 tests pass** (31 added in this pass). Covers delayed transcription after ending, shutdown/start races, cancelled AI jobs, handoff project changes and input revisions, reconnect/navigation races, deleted sessions, failed submissions, and Vite proxy headers. |
| `npm run build:web` | Production build passes. The existing warning for a JavaScript chunk above 500 kB remains. |
| Browser smoke test | Production bundle in Chrome against an isolated in-memory fixture: failed submission preserves the question and attached passage; reconnect recovers a missed transcript line and completed answer while preserving both; ending with transcription pending shows a persistent notice and the finishing status. |
| `git diff --check` | Passes. |
| CI | Added checks and web builds for macOS and Windows with Node 24 and 26. Workflow syntax checked locally; hosted runs have not been triggered. |

Not rerun in this pass: real microphone/system capture, vendor model requests, native desktop shells, or Windows. Application shutdown retains its existing four-second wait limit; unfinished transcription is marked interrupted, and this change does not add a durable transcription queue.

## Recording, playback and export — 2026-10-21

On the development Mac. **Record audio** is chosen per session in Start session (on by default; the default is in Settings → Audio).

| Check | Result |
|---|---|
| `npm run check` | Both TypeScript projects pass; 159 / 159 tests. `tests/recording.test.ts` covers the session-time ↔ file-position mapping, mixing overlapping sources with clipping, long gaps shortened to a one-second break, byte ranges that start or end inside a sample, crash recovery (including audio written after the last checkpoint), the per-session choice surviving a resume, and AAC export. |
| Real run, isolated data folder | The English sample played through the file input at 8×, with a pause and a resume. Playback matched the source file sample for sample before the pause, and the resumed run sat exactly 0.5 s later, matching the resume marker. |
| Player | ▶ on a transcript line played from that line and highlighted it; a citation click moved the player and kept it paused. Range requests returned 206 with the right `Content-Range`; a range past the end returned 416. |
| Export | A 9-minute meeting encoded to a 2.3 MB `.m4a` (AAC, 16 kHz mono, 32 kbit/s) in 0.6 s with `afconvert`. |
| Crash | `kill -9` during a recording: after restart the session was marked interrupted, its WAV header was repaired, and all 32.5 s captured so far played back. |
| WebKit (Chumi.app's engine), 2026-10-22 | Chumi.app's own `WebController` (compiled into a test harness) loaded the 9-minute session from an isolated server. Play, ▶ on a line (highlighted), −10 s, the seek bar to 8:00, 2× speed and citation clicks all worked. **Export audio** downloaded through the app's download handler in 9 of 11 runs, including first exports that had to encode; the two misses were the first two harness runs and did not recur. Found and fixed: WebKit renamed the download to `.mp4` because it was served as `audio/mp4`; it is now `audio/x-m4a` and saves as `.m4a`. |

Not verified: playback and download in a signed Chumi.app build itself (the test used its WebKit code, not the bundle), and on Windows.

## Antigravity as a coding agent — 2026-10-13

Antigravity CLI (`agy`) 1.3.4 on the development Mac. Details are in [agents.md](agents.md).

| Check | Result |
|---|---|
| `npm run check` | Both TypeScript projects pass; 152 / 152 tests. The read check and **Continue in…** tests now include Antigravity. A new test covers Connect and Disconnect: the server entry is added and removed, the check-tool rule is added once, and the user's other settings and rules are kept. |
| Real CLI, throwaway home | `agy mcp add` writes `~/.gemini/config/mcp_config.json`, replacing an earlier entry (and re-enabling it). Antigravity started Chumi's MCP server, got past its `server/discover` handshake, and listed all seven tools. The client name is `antigravity-client`. |
| Real CLI, this Mac | Connected through Chumi's own code. The status is registered and up to date. Chumi's MCP server starts and reads the local meetings. |

Not verified: **Test a real agent read** and a handoff with a signed-in Antigravity, which needs a Google sign-in. A stand-in model can't stand in here, because Antigravity offers gateway models no tools. Also not verified: the Antigravity desktop app (not installed), and the Settings card in the browser.

## Speech services: ElevenLabs and Qwen3-ASR — 2026-10-13

On the development Mac (Apple M5 Max, 64 GB). Details are in [transcription.md](transcription.md).

| Check | Result |
|---|---|
| `npm run check` | Both TypeScript projects pass; 151 / 151 tests. 14 new tests run against a local stand-in server, covering request shapes, response parsing, refused context, a rejected key (never echoed back), fallback to Whisper, skipping the service during an outage, missing keys, and address checks. |
| Settings | A non-Alibaba address for the cloud key, an unknown engine, and ElevenLabs without a saved key are all refused with HTTP 400. |
| Self-hosted Qwen3-ASR, stand-in server | A 16-second clip through the file input went to the stand-in as `audio_url` data URLs, with the glossary as context, and was saved as two English lines. |
| Fallback | With the server stopped, the same clip still started a session, and local Whisper (Large v3 Turbo) transcribed it in close agreement with the reference. The speech badge and the engine card name the unreachable server. |
| Settings → Transcription | Checked in the browser preview: the four engines, the key fields, region and address, and the error shown in the active engine's card. |

Not verified: real requests to ElevenLabs and Model Studio (no keys on this machine), and a real `qwen-asr-serve`.

## Windows desktop — 2026-10-13

Development machine: Windows 11 build 26300, i9-12900H, RTX 3060 Laptop 6 GB, Node 24.21.0, whisper.cpp b5454 CUDA 12.4, Electron 44.7.0.

| Check | Result |
|---|---|
| TypeScript and unit tests | Both TypeScript projects pass; 137/137 tests. |
| Native helper dependencies | Static MinGW-w64 build imports only `KERNEL32.dll`, `msvcrt.dll` and `ole32.dll`; no .NET or external C++ runtime. |
| WASAPI computer audio | Real Windows playback, about −24.4 dBFS; valid 16 kHz PCM frames with no backward timestamps. |
| WASAPI microphone and both | The default Redmi input provides frames. During mixed playback its microphone signal is −46.4 dBFS, and system signal is −24.4 dBFS. A quiet microphone-only run is −75.5 dBFS; human speech recognition on that input remains a separate check. |
| Packaged Electron window | Opens the production UI, moves and resizes through Windows controls, and reports the speech engine ready. Native settings and start controls operate. |
| Real capture → transcription → AI | An 85-second fictional lab-meeting clip played through Windows output and captured by WASAPI produced 10 transcript segments using real Whisper. Real ChatGPT catch-up: 5 citations, none unsupported. Final summary: 32 citations, none unsupported. |
| Pause/resume/end | Operated through the actual Electron page; capture stopped/restarted and the final summary completed. |
| Window chooser | Electron enumerated 8 Windows windows through the existing screen API. |
| Real window screenshot | A fictional Notepad slide was captured and persisted at 1920 × 1144. |
| Installer | NSIS installer built and installed in a path containing Chinese characters and spaces. Installed app starts with only Windows System32 on `PATH`; bundled Node, Codex and Whisper report ready. The installer is unsigned and not published. |
| First-use model setup | An empty model directory shows the Download speech model button. A local HTTP mirror served the existing real 874 MB model; the app downloaded it and started Whisper automatically. This proves the application flow, not the public download network. The compact Small model was separately downloaded from official Hugging Face. |
| GPU and CPU benchmarks | Bundled English/Mandarin clips: CUDA Large v3 Turbo, 97%/93% text accuracy and 40.1×/38.7× real time. Forced CPU with Small q5_1: 96%/90% and 2.75×/2.50×. Large on CPU is only 0.87×/0.78×; use the CPU recommendation. Synthetic-clip accuracy is not a real-meeting accuracy claim. |
| Model switching | Switching to an installed Small model restarts Whisper and returns to ready. Absolute Windows model paths are resolved correctly. |
| Handoff and real Codex read | Real ChatGPT drafted 10 items from the captured meeting. Reviewed/confirmed handoff was copied through Chumi; real Codex called `chumi_get_handoff` and `chumi_get_passages` through the installed MCP server, then returned a plan without changing project files. |
| Close/reopen/resume | Closed a recording through the native confirmation dialog. The backend exited, the meeting reopened as interrupted with its saved screenshot and timeline marker, and resuming/ending worked. |
| Folder chooser and credentials | Native folder dialog opens and cancels correctly. A dummy compatible key survived Windows account encryption/decryption and was deleted; plaintext was absent from its stored file. No paid API request was made. |
| Global shortcut | Windows simulated virtual-key presses start, pause and resume. Setting the shortcut to Off prevents a recording from starting; Windows shortcut options display the selected value correctly. |
| Repeated launch | The second process exits with status 0 and brings the first window forward. Fixed an early-exit path that called `globalShortcut` before Electron was ready. |
| Continue button | The actual **Continue in Codex** button opened a console and a stand-in CLI in a project path containing Chinese characters and spaces, with the correct handoff-file argument. The separate real-Codex read above verifies MCP evidence delivery. |
| Full sample acceptance | `scripts/acceptance.ts`: 16 pass, 0 fail, 2 manual with real Whisper and offline AI. The fixture now seeds its fictional familiarity profile because fresh installs intentionally start empty. |

Found and fixed: the initial state response could snapshot ASR as starting before waiting for provider startup, overwriting an ASR-ready event. The live snapshot is now read after that wait. Home's online/hybrid presets also wait for the audio-source setting before opening the start dialog.

A repository-contained installation initially masked missing backend dependencies: Node found the checkout's parent `node_modules`. Installing under `%LOCALAPPDATA%\Programs\Chumi` exposed it. Backend dependencies now have an explicit resource mapping, and an `afterPack` check verifies their presence and loads the SDKs with bundled Node before an installer can be generated. The final launch check is performed outside the repository.

Release qualification still needed: another Windows 10/11 machine, Bluetooth/USB device switching, microphone speech from a human participant and a fresh ChatGPT browser sign-in. No private real meeting was used in the sample run. The short synthetic meeting tested real ChatGPT answers; the full 20-minute acceptance run used the offline AI test provider.

`scripts/windows-acceptance.py` operates an open desktop window and repeats the real system-audio → Whisper → live catch-up → pause/resume → summary checks. Use an isolated data directory and a public example WAV, as described in its docstring.

Results from the development Mac: Apple M5 Max, macOS 26.5, Node 26.5, whisper.cpp 1.9.5 with large-v3-turbo q8_0.

## Windows preview — 2026-10-12

First run of Chumi on Windows 11 (i9-12900H, RTX 3060 Laptop 6 GB, Node 24.21.0). Details, setup and what is missing are in [windows.md](windows.md).

| Check | Result |
|---|---|
| `npm run check` | 135 / 135 on Windows and on macOS. |
| `node scripts/acceptance.ts` (offline test provider, real Whisper) | 16 pass, 0 fail, 2 manual, the same as on macOS. The run used whisper.cpp's CUDA 12.4 build, at about 0.8 s per utterance. |
| `scripts\setup.ps1` | A fresh install and a repeat run both work. |
| Codex 0.125, real model | `node scripts/acceptance.ts --provider codex`: 13 pass, 0 fail, 2 manual, with real Whisper and the ChatGPT plan (gpt-5.5). This is the first complete real-Codex run (see *ChatGPT plan answers* below). The summary had 73 citations, 0 unsupported. It kept the GATA result tentative, "not stated" for the rerun deadline, and the Friday deadline. |

Found and fixed on the way:
- A test split paths on `/`.
- The CUDA 11.8 whisper.cpp build silently runs on the CPU because it lacks cuBLAS.
- Codex 0.125 refuses to start when asked to disable feature names it doesn't know.

Not verified on Windows: live capture (no Windows helper yet) and opening an agent console from the UI.

## opencode and Qwen Code as coding agents — 2026-10-12

Chumi's agent connection now covers opencode and Qwen Code next to Claude Code and Codex. Details are in [agents.md](agents.md).

| Check | Result |
|---|---|
| `npm run check` | Both TypeScript projects pass; 135 / 135 tests. New tests cover the read check for all four agents, opencode's configuration file, comment-tolerant JSON reading, and how each agent is started. |
| API keys | Tested by mutation: a stand-in agent refuses to record a read if an API key reaches Claude Code or Codex, or if opencode's or Qwen Code's key is removed. Making opencode strip keys fails the test. |
| Real CLIs, stand-in model | `node scripts/agent-trial.ts opencode` (1.19.0) and `qwen-code` (0.25.1): Connect, client health, the read check and Disconnect all pass. Reads are logged as `opencode` and `qwen-cli-mcp-client-chumi`. |
| Settings and handoff UI | Checked in headless Chrome with a seeded meeting: four agent cards, and the **Continue in another agent…** menu listing the installed agents. Without consent the opencode read check is refused (HTTP 400). |

Not verified: a read check or a handoff with a real opencode or Qwen Code model, and opening Terminal from the new menu (the script it runs was tested directly).

## Fresh install from GitHub — 2026-10-12

The one-command installer was run on the development Mac with Chumi's data folder moved aside, so the app started as a new user would see it. The data folder was restored afterwards.

| Step | Result |
|---|---|
| `curl … install.sh \| bash` | Cloned `main` into `~/Chumi`. Setup: macOS, Apple Silicon, Xcode tools, Homebrew and Node passed; the speech model (875 MB) downloaded; Chumi.app built; the Codex and Claude sign-ins were detected; the final check passed (exit 0). |
| First launch | Speech recognition ready, ChatGPT plan connected, empty profile in English, no meetings. **Get Chumi ready** showed 2 of 4 steps left: your background and the microphone (not yet asked, because a newly built app counts as new to macOS). |
| A meeting | The sample meeting was played through the test file input: real local transcription, a running overview, and a final summary through the ChatGPT plan, with citations. |
| Found and fixed | The build steps printed signing and bundler noise; they now go to `build/setup.log`, shown only on failure. Starting a second session returned HTTP 500; it now returns 409. |

Not covered by this run, because the tools were already installed: installing Homebrew, the Xcode tools or Node from setup, and signing in to Codex or Claude from it.

## Branch review and optimization — 2026-10-12

A review of the speaker-label, compatible-model, local-model, and session-type work before merging.

| Check | Result |
|---|---|
| `npm run check` | Both TypeScript projects pass. All tests pass, including new regression tests for each fix below. |
| Real speaker model, end to end | Chinese 4-speaker sample through the file input at 4× (real Whisper, mock AI): 4 speakers. The 14 s line at 0:32, with one detected voice and long non-speech, is now assigned (it was "unknown"). Rename in the UI relabels the line and flags the summary. A meeting without analysis shows no speaker bar or tags. |
| Re-analysis cost (2,000 lines, 3,000 turns) | First run 87 → 73 ms. Rerun on retained audio 2,676 → 30 ms. Resume-style run 1,315 → 27 ms. |
| Acceptance harness | `scripts/acceptance-speakers.ts`: English 2-speaker passed (2 groups), Chinese 4-speaker passed (4 groups). |

Fixed in this pass:

- **Transcript budgets.** Every line carried a speaker tag, even in meetings never analyzed, while budgets counted only the bare text. Summaries of long meetings silently dropped their first ~25 minutes. Unanalyzed lines now have no tag, tags are short (legend once in the rules), and budgets measure the formatted lines.
- **Capture and analysis.**
  - A small backward clock step (device switch, drift re-anchor) no longer stops speaker capture for both sources. A large step starts a new take for that source only.
  - Speaker updates now send only annotations and staleness, and unchanged rows don't re-render.
  - First labels no longer mark earlier AI output stale, which used to force a full re-digest.
  - A superseded analysis no longer records "done" or overwrites the newer job's state.
  - The worker converts audio in blocks, using about a third less peak memory.
- **Compatible models.**
  - JSON wrapped in code fences or prose is accepted.
  - Leading `<think>` blocks are hidden while streaming and removed from the answer.
  - The timeout starts after the local queue and resets on each chunk.
  - A stream finished with `finish_reason: stop` is accepted without `[DONE]`.
  - An invalid saved profile no longer blocks unrelated settings saves.
  - An LM Studio download Chumi can no longer reach can be dropped ("Stop tracking").
- **Session types.**
  - Each type chooses its summary style, so a renamed or added type gets the right template. Exports, agent evidence and mybot carry the type's name.
  - Names reject control characters, and duplicates of translated defaults are caught.
  - Removing an unsaved row drops it instead of archiving it, and re-adding a removed type restores it.
  - Only active types count toward the 50-type limit.

## Compatible model integration — 2026-10-11

This pass covers the new local/API adapter, configuration, credentials interface, and settings UI. Earlier end-to-end results below were not rerun for this change.

| Check | Result |
|---|---|
| `npm run check` | Backend and frontend TypeScript pass; **54 / 54 tests pass**, including 27 new adapter, configuration, and answer-metadata tests. Transports and credentials are mocked. Download tests use a temporary loopback server. |
| `npm run build:web` | Production build passes. |
| Browser smoke test | Isolated database and fake local Chat Completions server: saved a profile without selecting it, tested a synthetic completion, explicitly selected the provider, and verified unsaved edits disable testing and can be discarded. Unsupported reasoning controls disappear after selection. |
| HTTP smoke test | Stale model tests return 409; settings containing API keys and remote URLs in local profiles return 400; the fake local completion test succeeds. |
| `git diff --check` | Passes. |

Not verified in this pass: real vendor completions, Keychain write/delete round trips, actual Ollama/LM Studio installations, model answer quality, or simultaneous local inference and speech recognition performance. No paid model requests were made. Local runtimes and model downloads remain user-managed; configure a sufficient context window before evaluating long meetings.

## Automated

| Run | Command | Result |
|---|---|---|
| Unit tests | `npm test` | 18 / 18 pass. Covers VAD segmentation (including a regression for a split-during-pause crash), the frame protocol, Whisper cleanup, Traditional→Simplified conversion, the citation checker, the quota gate, effort mapping, slide-change detection, and language rules. |
| End-to-end, offline test provider | `node scripts/acceptance.ts` | 16 pass, 0 fail, 2 manual. Streams the 20:43 sample lab meeting through real local Whisper and checks every acceptance criterion that doesn't need a real model. |
| End-to-end, real model (Claude plan) | `node scripts/acceptance.ts --provider claude-cli` | 13 pass, 0 fail, 2 manual. Details below. |

What the real-model run showed:

- **Summary uncertainty.** The summary called the GATA-motif result tentative and kept the disagreement.
- **Deadlines.** It wrote "not stated" for the rerun that had no deadline, and kept the Friday deadline.
- **Citations.** The summary had 107 citations and the other answers 79, all pointing at real transcript lines.
- **Depth.** Deep explanations were about 2.3× longer than Quick ones.
- **Auto-explain.** It picked genuinely unfamiliar terms (integrated gradients, master regulator, library complexity, CUT&Tag) and never repeated one.
- **Live transcription.** It kept running while catch-ups were generated.

## Manual and live checks

| Area | Result |
|---|---|
| Computer audio capture | `node scripts/check-audio.ts system 6 --play` captured real signal (RMS −31 dBFS, 99 % non-zero samples). It was also used for a real 28-minute seminar. |
| Microphone capture | Permission flow and frame delivery verified. Real signal **not verified**: the MacBook lid was closed, which silences the built-in mic. Re-check with `node scripts/check-audio.ts mic 6`. |
| Window capture | A TextEdit window was captured at 1346 × 878, sharp and readable. Three content changes produced exactly three stored captures. Claude correctly read the bullet points of a captured slide. |
| Quick-start shortcut | The shortcut registered system-wide. Start, pause and resume verified through the server. The physical key press is left to the user. |
| ChatGPT plan answers | Status, quota windows and the credit-spending gate verified against a real account. A real completion **wasn't run**, because that account's weekly window was exhausted and Chumi correctly refused to spend credits. Re-check with `node scripts/acceptance.ts --provider codex`. A full real-Codex run later passed on Windows (13 pass, 0 fail, 2 manual; see *Windows preview* above). |
| Crash recovery | A real crash during a seminar kept all 197 transcript lines and 49 captures. The session reopened as "interrupted", ready to resume. The bug that caused it is fixed and covered by a regression test. |

## mybot integration

| Check | Result |
|---|---|
| Chumi export | Unit test: `chumi-transcript/1` JSONL is private by default, has the right line types, and the file is removed when the session is deleted. Live sessions are not exported. |
| mybot adapter, against a real mybot checkout | `install.sh` applies cleanly to a fresh clone of jzhoulab/mybot, and a second run is safe. `integrations/mybot/test_chumi_source.py` indexed 2 exported sessions (291 turns), both owner-only, produced session and chunk import records, and read transcript windows with timestamped snippets. |
| mybot's own indexer | `trajectory_memory.py build --sources chumi` indexed both sessions (`by_tool: {"chumi": 2}`), and `search "how many barcodes per variant"` returned them. The embedding and server paths (sentence-transformers, `/chat`) weren't run here. |
