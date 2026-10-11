# Chumi + mybot

[mybot](https://github.com/jzhoulab/mybot) unifies your Claude Code and Codex conversations into one local, searchable memory, with an agent that answers from the actual transcripts. Chumi adds the other half of research work: **what was said in meetings**.

With the integration on, mybot can answer:

- *"What did my advisor ask me to rerun last week?"*, citing the meeting, its date, and the moment it was said.
- *"When did we decide on 200 barcodes per variant, and who was unsure?"*
- *"Did the lecture cover the negative binomial model, and how was it explained?"*
- *"Which agent session implemented the holdout split Maya asked for in lab meeting?"*. That last one joins a meeting with your coding sessions.

Everything stays on your Mac. Chumi writes files, and mybot indexes them locally.

## Set up

**1. In Chumi:** turn on **Settings → Integrations → Export finished sessions for mybot**, then click **Export all sessions now**. To export from the command line instead, even with the app closed:

```bash
node scripts/export-mybot.ts
```

**2. In mybot:** add the Chumi source to your checkout (default `~/Code/mybot`):

```bash
bash integrations/mybot/install.sh ~/Code/mybot
```

Then add `chumi` to the sources in mybot's `.env` and restart mybot:

```bash
TRAJECTORY_SOURCES=codex,claude,chumi
```

The installer copies `integrations/mybot/chumi.py` to `sources/chumi.py` and applies `mybot-chumi-source.patch`. The patch makes four small additions: the registry entry, the default folder, the file pattern, and transcript reading. Running it twice is safe.

**3. Check it** (optional) from the Chumi folder:

```bash
python3 integrations/mybot/test_chumi_source.py ~/Code/mybot "$HOME/Library/Application Support/Chumi/exports/mybot"
```

## What gets exported

When a session ends, Chumi writes `<export folder>/<session-id>.jsonl`. The default folder is `~/Library/Application Support/Chumi/exports/mybot`. The file is refreshed when the summary or a new answer arrives, or when you rename the session. It is deleted when you delete the session in Chumi. Live (still recording) sessions are not exported.

Format `chumi-transcript/1`, one JSON object per line:

| `type` | Fields | Meaning |
|---|---|---|
| `session` (first line) | `format`, `id`, `title`, `session_type`, `status`, `started_at`, `ended_at`, `duration_ms`, `audio_source`, `visibility` | Header. `visibility` is `private` unless sharing is enabled. |
| `segment` | `t_ms`, `t_end_ms`, `timestamp` (ISO), `source` (`mic` / `system`), `lang`, `text` | One transcript line: what was actually said |
| `gap` | `kind` (`pause` / `resume` / `gap` / `interrupted`), `t_ms`, `timestamp`, `detail` | Recording pauses and gaps |
| `qa` | `kind` (`answer` / `explain` / `catchup`), `question`, `answer`, `created_at`, `covered_from_ms`, `covered_to_ms` | Your questions and Chumi's AI-written answers |
| `summary` | `text`, `created_at` | The final AI-written summary (Markdown with `[m:ss]` citations) |

In mybot, speech lines become `user` events (highest search weight). Chumi's summaries and answers become `assistant` events, labelled *AI-generated*. Gaps become `actions`. Titles read like *"Lab meeting: enhancer model (lab meeting, 2026-10-10)"*.

## Privacy

Meetings contain other people's words, so **exports are owner-only by default**. Each file is marked `visibility: private`, and mybot never uses private sessions when answering anyone but you, even with guest access enabled.

Turning on **Let mybot share meeting content with teammates** re-exports every session without that marker, so mybot's normal sharing rules apply. Only do this if the people in those meetings are comfortable with it, and follow your institution's rules on recording.
