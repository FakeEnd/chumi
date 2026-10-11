# Verification log

Results from the development Mac: Apple M5 Max, macOS 26.5, Node 26.5, whisper.cpp 1.9.5 with large-v3-turbo q8_0.

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
