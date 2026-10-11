<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner-light.png">
    <img src="docs/assets/banner-light.png" alt="Chumi: never lose the thread, understand every talk. A listening companion for lab meetings, advisor 1:1s, lectures and seminars." width="900">
  </picture>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS-14.4%2B%20Apple%20Silicon-000000" alt="macOS 14.4+ on Apple Silicon">
  <img src="https://img.shields.io/badge/node-24%2B-339933" alt="Node 24+">
  <img src="https://img.shields.io/badge/speech-on--device%20(whisper.cpp)-4f46e5" alt="On-device speech recognition">
  <img src="https://img.shields.io/badge/AI-ChatGPT%20or%20Claude%20plan-0e9fb8" alt="ChatGPT or Claude plan">
  <img src="https://img.shields.io/badge/network-localhost%20only-4ade80" alt="Localhost only">
</p>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>

---

**Chumi is a listening companion for academic conversations.** It transcribes lab meetings, advisor 1:1s, lectures and seminars on your Mac, in English, Mandarin, or both at once. While the talk goes on, it tells you where the discussion is, catches you up when you drift, and explains unfamiliar methods and terms at your level. Every answer is cited back to the moment it came from.

Research talk moves fast and borrows from neighbouring fields. A deep-learning person in a wet-lab meeting, or a biologist in a statistics seminar, constantly loses a minute here and a term there. Chumi keeps the thread for you, using the ChatGPT or Claude subscription you already have. It never sends audio off the machine.

## Highlights

- **Catch up in one click.** You drifted off, or the speaker skipped ahead. **Catch me up** tells you what is being discussed now, what you missed, how it connects to earlier points, and which question is on the table. Every answer states the exact stretch of transcript it covers, and it stays put while the meeting goes on.
- **Explanations pitched to you.** Select a phrase and get the background at the right level. Chumi keeps a per-domain profile: it won't explain transformers to an ML person, and it won't assume you know a wet-lab assay. Pick **Quick, Standard or Deep**, and choose how hard the model thinks, from **Low to Max**.
- **It keeps what was said apart from what it adds.** Answers separate *what the speakers said*, *background added by Chumi*, and *interpretation and uncertainty*. Every claim cites a clickable `[m:ss]` that jumps to the supporting lines. If a speaker points at a slide Chumi can't see, it says so instead of guessing.
- **It sees the slides too.** Capture the Zoom share, the lecture video or the slide deck. Chumi keeps one picture per slide and can show it to the model, so *"explain this figure"* works.
- **Bilingual by design.** Transcribes English, Mandarin, and Mandarin with English technical terms. Explains in **中文** (keeping English terms) or **English**, switchable at any time.
- **Summaries you can trust.** Summaries are shaped for lab meetings, advisor 1:1s, lectures or WIP talks. Preliminary results stay preliminary, disagreements are kept, and owners or deadlines appear only if someone actually said them.
- **Uses the subscription you already pay for.** ChatGPT (through Codex) or Claude (through Claude Code), with live quota and billing shown. Chumi **never** switches to a paid API on its own, and pauses instead of spending purchased credits.
- **Private and crash-safe.** Speech recognition runs locally with whisper.cpp, so audio never leaves the Mac. Transcript lines are saved as they arrive. After a crash, the session reopens with a gap marker and can be resumed.
- **One keystroke when a talk starts.** Press **⌃⌥⌘L** from any app to start listening. Press again to pause.

## See it in action

**Lost the thread? Catch me up.** Here's a live lab meeting with a running overview and English and Mandarin transcript. The catch-up covers exactly the last two minutes, with every point cited to the transcript:

<p align="center">
  <img src="docs/assets/screens/live.png" width="900" alt="Chumi during a lab meeting: live transcript with English and Mandarin lines, a running overview with clickable timestamps, and a catch-up card covering the last two minutes">
</p>

**Ask about the slide on screen.** A captured slide goes with the question, and the answer weighs it against what was actually said. Here it notices that the slide's numbers don't match the library size the speaker described:

<p align="center">
  <img src="docs/assets/screens/window-capture.png" width="900" alt="A captured slide in the Screen strip; the answer explains the slide, cites transcript times, and flags a mismatch between the slide and the discussion">
</p>

**Explanations in Chinese, English terms kept.** Select *negative binomial* in the transcript and get the intuition, how it was used in this discussion, and why it matters. All of it is pitched to your statistics level:

<p align="center">
  <img src="docs/assets/screens/chinese.png" width="900" alt="An explanation card in Simplified Chinese for 'negative binomial model', with transcript citations">
</p>

**A structured summary when the meeting ends.** It has sections for research question, methods, findings (labelled established, preliminary or contested), disagreements, open questions and action items, all cited back to the transcript. Dark mode included:

<p align="center">
  <img src="docs/assets/screens/summary.png" width="900" alt="Dark mode: the final summary card with an overview and research question, each claim linked to transcript times">
</p>

**Start in one click.** The home screen offers quick start, presets for in-person, online and hybrid conversations, your recent sessions, and your knowledge profile at a glance:

<p align="center">
  <img src="docs/assets/screens/home.png" width="900" alt="The home screen: greeting, status, four start options, recent sessions, profile summary and tips">
</p>

<sub>All screenshots come from a real run (real local transcription, real Claude answers) on the synthetic sample meeting in <code>samples/lab-meeting</code>. To regenerate them, run <code>node scripts/demo-shoot.ts</code>.</sub>

## Works with mybot

[**mybot**](https://github.com/jzhoulab/mybot) unifies your Claude Code and Codex conversations into one local, searchable memory. With Chumi's export turned on, **your meetings join that memory too**. Ask mybot *"what did my advisor ask me to rerun last week?"* or *"when did we decide on 200 barcodes per variant, and who was unsure?"*, and it answers with the date and a link to the exact moment in the meeting.

- In Chumi, go to **Settings → Integrations** and turn on *Export finished sessions for mybot*.
- In mybot, run `bash integrations/mybot/install.sh ~/Code/mybot` once, then add `chumi` to `TRAJECTORY_SOURCES`.
- Meetings are **owner-only by default** (`visibility: private`), because they contain other people's words. Sharing with teammates is a separate opt-in.

Setup, the export format and the privacy model are in [docs/mybot.md](docs/mybot.md).

## Quick start

**Requirements:** an Apple Silicon Mac on macOS 14.4 or later, plus [Homebrew](https://brew.sh), Node.js 24 or later, and the Xcode Command Line Tools (`xcode-select --install`).

### 1. Install

```bash
git clone https://github.com/FakeEnd/chumi.git && cd chumi
```

```bash
bash scripts/setup.sh
```

The setup script installs whisper.cpp, downloads the speech model (about 875 MB, stored once in `~/Library/Application Support/Chumi/models/`), installs the npm packages, and builds the app and its helpers.

### 2. Connect the AI you already have

Pick one. Your account details stay with the official CLI, and Chumi never sees them.

```bash
codex login
```

That's for ChatGPT: choose *Sign in with ChatGPT*. For a Claude plan, use this instead:

```bash
claude auth login
```

### 3. Start listening

```bash
open build/Chumi.app
```

Click **⚡ Quick start**, or press **⌃⌥⌘L** from anywhere. macOS asks once for Microphone and/or System Audio Recording permission. You can also run Chumi in a browser with `npm start` and open http://127.0.0.1:4777.

## Features

**Listening**
- Microphone for in-person conversations, computer audio for Zoom, Teams or recorded lectures (headphones are fine), or both for hybrid meetings, with echo cancellation and duplicate filtering.
- Local whisper.cpp large-v3-turbo on the Metal GPU, about 0.3 s per utterance. Grey partial text is revised in place, never duplicated.
- English, Mandarin and code-switching. Traditional characters are converted to Simplified, and vocabulary hints improve spelling of jargon and names.
- Pause, resume, a quick-start shortcut, level meters, and clear permission guidance.

**Understanding**
- Catch me up over the last 2 minutes, the last 5 minutes, or the whole session so far.
- Questions about the selected passage, the surrounding discussion and relevant earlier passages.
- Explanation depth (Quick, Standard, Deep) and reasoning effort (Auto, Low, Medium, High, Extra high, Max) for each question. Neither changes your saved profile.
- Optional auto-explain cards with a cooldown and an interruption cap. Turning it off drops late results.
- A running overview and topic timeline, updated at pauses and topic changes.
- Window capture (ScreenCaptureKit) with one picture kept per slide, and *Ask about this slide*.

**Remembering**
- Structured final summaries by session type, with citations, uncertainty and disagreements kept, and owners and deadlines only when stated.
- History with full-text search (English and 中文), reopen, Markdown or plain-text export, and delete.
- Transcript lines saved as they arrive. Recording gaps are marked, and interrupted sessions can be resumed.

**Trust and cost control**
- Exactly one active AI provider, with no automatic fallback.
- Quota and billing shown live. Chumi pauses when included usage is used up.
- Background work (overview, auto-explain) runs at low effort, and long sessions use rolling notes instead of resending the whole transcript.
- Settings → Privacy & data explains exactly what is sent and when.

## How it works

```
Chumi.app (Swift window + macOS privacy identity)
├── chumi-audio   AVAudioEngine mic (+ echo cancellation) · Core Audio process tap
├── chumi-screen  ScreenCaptureKit window capture
├── chumi-hotkey  global quick-start shortcut
└── Node.js server (TypeScript, node:sqlite)
    ├── voice-activity segmenter → transcriber → whisper-server (local, separate process)
    ├── SQLite: sessions · raw transcript · gaps · AI outputs (kept separate) · screen captures
    ├── assistant: catch-up · Q&A · explain · overview · auto-explain · summary
    └── providers: Codex app-server (ChatGPT plan) │ claude -p (Claude plan) │ Anthropic API (optional, paid)
React UI ⇄ HTTP + Server-Sent Events on 127.0.0.1
```

| Provider | Sign-in | Billing |
|---|---|---|
| ChatGPT plan, via OpenAI's documented [Codex app-server](https://learn.chatgpt.com/docs/app-server) | `codex login` | Included plan usage. Purchased credits are used only if you allow it. |
| Claude plan, via the unmodified `claude -p` (personal use) | `claude auth login` | Plan usage limits. Chumi stops on paid overage. |
| Anthropic API key | macOS Keychain | Pay per request. Off until you enable it. |

The reasoning behind these choices, with links to the official terms, is in [docs/provider-research.md](docs/provider-research.md).

## Development

```bash
npm run check
```

That runs the type checks and unit tests.

```bash
node scripts/acceptance.ts
```

This end-to-end run streams the 20-minute sample through real Whisper, using an offline test provider. Add `--provider claude-cli` to use a real model.

```bash
node scripts/check-audio.ts system 6 --play
```

That confirms real computer-audio capture. Use `mic 6` instead to test the microphone.

```bash
node scripts/demo-shoot.ts
```

This regenerates the README screenshots. `bash scripts/make-banner.sh` re-renders the banner.

```bash
npm run build:tools
```

That rebuilds the window-capture and shortcut helpers without touching Chumi.app's permissions.

| Path | Contents |
|---|---|
| `server/` | Audio pipeline, speech recognition, assistant, AI providers, storage |
| `web/` | React interface |
| `native/` | Swift app shell and helpers ([native/README.md](native/README.md)) |
| `scripts/` | Setup, acceptance test, audio check, screenshots, sample generator |
| `samples/lab-meeting/` | Synthetic bilingual lab meeting, generated with `npm run sample` |
| `integrations/mybot/` | mybot source adapter, patch, installer and test ([docs/mybot.md](docs/mybot.md)) |
| `docs/` | [Provider research](docs/provider-research.md), the [verification log](docs/verification.md), [mybot integration](docs/mybot.md), and banner source |

## Related projects

| Project | What it is |
|---|---|
| [mybot](https://github.com/jzhoulab/mybot) | The connectivity layer for coding agents: every Claude Code and Codex conversation in one searchable memory, shared across your team. Chumi meetings plug in as a source. |
| [nebula-notebook](https://github.com/jzhoulab/nebula-notebook) | An agent-native notebook: you and your AI work in the same cells |

## Status and roadmap

Chumi is a working personal tool. What has been verified, and how, is in [docs/verification.md](docs/verification.md).

**Known limits:**
- Speakers are only told apart as mic vs computer audio.
- Protected (DRM) video captures as black.
- Claude reports plan usage only after each request.
- The app is ad-hoc signed, so rebuilds ask for permissions again.

**Next:** paper and slide-deck files as context, speaker diarization, a cross-session glossary, spoken explanations, a menu-bar mini mode, and a per-session usage meter.
