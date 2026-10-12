# Verification log

Results from the development Mac: Apple M5 Max, macOS 26.5, Node 26.5, whisper.cpp 1.9.5 with large-v3-turbo q8_0.

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
| ChatGPT plan answers | Status, quota windows and the credit-spending gate verified against a real account. A real completion **wasn't run**, because that account's weekly window was exhausted and Chumi correctly refused to spend credits. Re-check with `node scripts/acceptance.ts --provider codex`. |
| Crash recovery | A real crash during a seminar kept all 197 transcript lines and 49 captures. The session reopened as "interrupted", ready to resume. The bug that caused it is fixed and covered by a regression test. |

## mybot integration

| Check | Result |
|---|---|
| Chumi export | Unit test: `chumi-transcript/1` JSONL is private by default, has the right line types, and the file is removed when the session is deleted. Live sessions are not exported. |
| mybot adapter, against a real mybot checkout | `install.sh` applies cleanly to a fresh clone of jzhoulab/mybot, and a second run is safe. `integrations/mybot/test_chumi_source.py` indexed 2 exported sessions (291 turns), both owner-only, produced session and chunk import records, and read transcript windows with timestamped snippets. |
| mybot's own indexer | `trajectory_memory.py build --sources chumi` indexed both sessions (`by_tool: {"chumi": 2}`), and `search "how many barcodes per variant"` returned them. The embedding and server paths (sentence-transformers, `/chat`) weren't run here. |
