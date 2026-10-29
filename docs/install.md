# Install Chumi

**English** · [简体中文](install.zh-CN.md)

## What you need

- A Mac with Apple Silicon (M1 or later) on macOS 14.4 or later. Intel Macs work, but speech recognition is slower.
- About 3 GB of free disk space: the speech model is about 0.9 GB, plus the tools and the app.
- An AI to answer with, one of:
  - a **ChatGPT** subscription (used through Codex),
  - a **Claude** Pro or Max subscription (used through Claude Code),
  - or a free **local model** with Ollama or LM Studio, if your Mac has 16 GB of memory or more.

You don't need to install anything else first. Setup offers to install what is missing.

## Install with one command

Open **Terminal** and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/FakeEnd/chumi/main/scripts/install.sh | bash
```

This downloads Chumi into `~/Chumi` and runs the guided setup. Setup asks before it installs anything, and takes about 5 to 15 minutes, mostly downloads:

1. **Checks this Mac.** If the Xcode Command Line Tools, Homebrew or Node.js 24 are missing, it offers to install them. Homebrew asks for your Mac password.
2. **Installs local speech recognition.** That means whisper.cpp plus the speech model that fits your Mac, for example Large v3 Turbo (about 875 MB) on Apple Silicon with 16 GB or more. If the download stops, run setup again and it resumes.
3. **Builds Chumi.app** and its audio helper on your Mac.
4. **Helps you connect an AI.** Pick ChatGPT, Claude, a local model, or decide later. It installs the official command-line tool if needed and opens its sign-in page. Your password and account stay with that tool; Chumi never sees them.
5. **Runs a final check** and offers to open Chumi.

Run the same command again later to update Chumi. Finished steps are skipped.

### Prefer to do it by hand

```bash
git clone https://github.com/FakeEnd/chumi.git && cd chumi
```

```bash
bash scripts/setup.sh
```

| Option | What it does |
|---|---|
| `--yes` | Accept the defaults without asking. It never installs Homebrew or signs you in for you. |
| `--mirror` | Download the speech model from hf-mirror.com, which is often faster in mainland China. To use another copy, set `CHUMI_MODEL_BASE_URL`. Every download is checked against the official file's SHA-256. |
| `--sample` | Also generate the 20-minute sample meeting used for testing. |
| `--no-ai` | Skip the AI step. You can choose one later in Settings → AI provider. |

With the one-command install, pass options like this: `curl -fsSL …/install.sh | bash -s -- --mirror`.

## First launch

Open Chumi with `open ~/Chumi/build/Chumi.app`, or drag it from that folder to your Dock. The home screen shows a **Get Chumi ready** checklist until everything is set:

- **Speech recognition on this Mac:** ready after setup.
- **Connect the AI you already have:** if it isn't connected, the checklist shows the exact command to run, for example `codex login`, and a **Check again** button.
- **Tell Chumi about your background:** explanations are pitched to what you already know, field by field. A new install starts with an empty profile, so this takes a minute and is worth it.
- **Allow the microphone:** macOS asks once.

Then click **⚡ Quick start**, or press **⌃⌥⌘L** in any app to start listening.

**Permissions macOS may ask for:**

| Permission | When | Why |
|---|---|---|
| Microphone | The first time you listen in person | To hear the room |
| System Audio Recording | The first time you record Zoom, Teams or a video | To hear the computer's audio |
| Screen Recording | Only if you capture a window, for example slides | To keep a picture of each slide |
| Files and folders | Only if Chumi lives in Documents, Desktop or Downloads | So Chumi's own helpers can start |

If you said no by mistake, turn it on in **System Settings → Privacy & Security**, then restart Chumi.

## Connecting an AI by hand

- **ChatGPT plan:** run `brew install codex` once, then `codex login` and choose *Sign in with ChatGPT*.
- **Claude plan:** run `npm install -g @anthropic-ai/claude-code` once, then `claude auth login`.
- **Local model:** install [Ollama](https://ollama.com) (`brew install ollama && brew services start ollama`) or [LM Studio](https://lmstudio.ai). Then in Chumi, open **Settings → AI provider → Other models: local or API**, choose it, and click **Download recommended model**. Chumi suggests a model that fits your Mac's memory.

Chumi never switches to a paid API on its own. Paid API keys are optional and off by default.

## Check an install

```bash
npm run doctor
```

Run it in the Chumi folder. It checks each part (macOS, Node.js, whisper.cpp, the speech model, the app build, the AI sign-in) and prints the exact fix for anything missing. Microphone permission is checked inside Chumi when you first listen; a Terminal check cannot report the app’s permission.

## Troubleshooting

| What you see | What to do |
|---|---|
| `brew: command not found` right after installing Homebrew | Run the two "Next steps" commands Homebrew printed, or open a new Terminal window. |
| The speech model download is slow or blocked | Run `bash scripts/setup.sh --mirror`; the source is saved for in-app downloads too. After a failed download, Home offers **Retry** and **Use the hf-mirror.com copy**. Retries resume partial downloads. **Settings → Transcription → Download source** shows the source and lets you switch back to Hugging Face. |
| Installing JavaScript packages (`npm ci`) is slow in mainland China | Run `bash scripts/setup.sh --mirror`; it uses npmmirror for this install without changing your npm configuration. |
| Setup says Node.js 24 is needed, but you installed it | A version manager such as nvm may be picking an older Node. Run `nvm install 24`, or put Homebrew's Node first in your PATH. |
| The AI pill on Home says *not signed in* | Run `codex login` or `claude auth login`, then click **Check again**. |
| The transcript stays empty | Check **System Settings → Privacy & Security → Microphone** (and **System Audio Recording** for computer audio). To test capture, run `node scripts/check-audio.ts mic 6`. |
| macOS asks for permissions again after an update | Chumi is signed only on your Mac, so a rebuilt app counts as new. Allow it again. |
| Anything else | Run `npm run doctor`, and [open an issue](https://github.com/FakeEnd/chumi/issues) with its output. |

## Uninstall

Before deleting Chumi, export any meetings you want to keep. In **Settings → Coding agents**, click **Disconnect** for every connected agent (Claude Code, Codex, opencode, Qwen Code, Antigravity and DeepSeek Harness). Resolve any error shown there before deleting the app; restart the agents afterward so they stop using the old MCP registration.

Use **Remove key** in **Settings → AI provider** and **Settings → Transcription** for any API keys saved in Chumi. Then quit Chumi and run:

```bash
rm -rf ~/Chumi "$HOME/Library/Application Support/Chumi" "$HOME/Library/Logs/Chumi"
```

The second path holds your meetings and the speech models. `brew uninstall whisper-cpp` removes whisper.cpp if nothing else uses it.

If Chumi is already deleted or Disconnect could not finish, back up the relevant agent config and remove only Chumi’s entry:

| Agent | Cleanup |
|---|---|
| Claude Code | `claude mcp remove chumi -s user` |
| Codex | `codex mcp remove chumi` |
| opencode | Remove `mcp.chumi` from `~/.config/opencode/opencode.json` and/or `opencode.jsonc` (under `$XDG_CONFIG_HOME/opencode` if set). Chumi does not edit commented JSONC files. |
| Qwen Code | `qwen mcp remove --scope user chumi`, or remove `mcpServers.chumi` from `~/.qwen/settings.json`. |
| Antigravity | `agy mcp remove chumi`, or remove `mcpServers.chumi` from `~/.gemini/config/mcp_config.json`. Also remove only `mcp(chumi/chumi_connection_check)` from `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`. |
| DeepSeek Harness | Remove the block from `# >>> chumi` through `# <<< chumi` in `$DSH_HOME/cordis.patch.yml` (default `~/.dsh/cordis.patch.yml`). |

Deleting Chumi’s data folder does not remove macOS Keychain items. If keys were not removed in the app, open **Keychain Access** and remove the saved items with services **Chumi Anthropic API key**, **Chumi compatible API key** and **Chumi speech API key**. Keep other apps’ credentials and agent sign-ins.
