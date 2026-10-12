# Chumi + mybot

[mybot](https://github.com/jzhoulab/mybot) unifies your Claude Code and Codex conversations into one local, searchable memory, with an agent that answers from the actual transcripts. Chumi adds the other half of research work: **what was said in meetings**.

With the integration on, mybot can answer:

- *"What did my advisor ask me to rerun last week?"*, citing the meeting, its date, and the moment it was said.
- *"When did we decide on 200 barcodes per variant, and who was unsure?"*
- *"Did the lecture cover the negative binomial model, and how was it explained?"*
- *"Which agent session implemented the holdout split Maya asked for in lab meeting?"*. That last one joins a meeting with your coding sessions.

Everything stays on your Mac. Chumi writes files, and mybot indexes them locally.

It also works the other way. During a meeting, Chumi can look up your earlier agent sessions for the meeting's project through mybot, so the AI answering your questions knows what was already tried (see [Project context in questions](#project-context-in-questions)).

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
| `session` (first line) | `format`, `id`, `title`, `session_type` (id), `session_type_name`, `status`, `started_at`, `ended_at`, `duration_ms`, `audio_source`, `visibility`, `project` (`id`, `name`, `workspace`, or `null`), `cwd`, `revision` | Header. `visibility` is `private` unless sharing is enabled. `project` is set only when you assigned the meeting to a project; `cwd` is its folder. |
| `segment` | `id`, `t_ms`, `t_end_ms`, `timestamp` (ISO), `source` (`mic` / `system`), `lang`, `text` | One transcript line: what was actually said. `id` is stable. |
| `gap` | `kind` (`pause` / `resume` / `gap` / `interrupted`), `t_ms`, `timestamp`, `detail` | Recording pauses and gaps |
| `qa` | `id`, `kind` (`answer` / `explain` / `catchup`), `question`, `answer`, `created_at`, `covered_from_ms`, `covered_to_ms` | Your questions and Chumi's AI-written answers |
| `summary` | `id`, `text`, `created_at` | The final AI-written summary (Markdown with `[m:ss]` citations) |
| `frame` | `id`, `t_ms`, `timestamp`, `window_title` | A captured slide or screen (metadata only; agents fetch the image through Chumi's MCP server) |
| `handoff` | `id`, `project_id`, `confirmed_at`, `confirmed_revision`, `items` | Only a handoff you confirmed: confirmed decisions and actions, open questions, with origin, owner/deadline if stated, and evidence references. See [agents.md](agents.md). |

In mybot, speech lines become `user` events (highest search weight). Chumi's summaries and answers become `assistant` events, labelled *AI-generated*, and a confirmed handoff becomes an `assistant` event labelled *reviewed by the user*. Gaps become `actions`. A meeting's project folder becomes the session's `cwd`, so it sits next to the agent sessions from that folder. Titles read like *"Lab meeting: enhancer model (lab meeting, 2026-10-10)"*.

## Project context in questions

This is the other direction: during a meeting, Chumi asks mybot about your earlier agent work. If a meeting is assigned to a project, the Ask box shows a **Project context** button. Turn it on, and each question also searches mybot for earlier Claude Code and Codex sessions in the project's folder. The best matches go into the question, and the answer cites them as `[P1]`, `[P2]`. The answer card lists those sessions.

- **Off by default, per meeting.** Nothing is searched while it is off. Once on, it stays on for that meeting.
- **Only the project folder.** Chumi runs mybot's `/trajectory/search` and keeps only sessions whose working folder is the project folder or inside it. For the top two, it reads the surrounding conversation through `/trajectory/read`. It sends about 2,500 tokens in total, made of the snippets that mention the question's words. The same question within 10 minutes reuses the earlier result.
- **The excerpts go to your AI provider** together with the question, like the transcript does. The prompt marks them as background from outside the meeting, possibly out of date, and never as instructions.
- **If mybot isn't running,** the question is still answered without project context. The Ask box and the answer card say that mybot couldn't be reached.
- **The meeting itself is excluded,** in case mybot also indexes Chumi's exports.

Set the address in **Settings → Integrations → mybot address**. The default is `http://127.0.0.1:8788`. To start mybot, run `./run_chatbot.sh` in your mybot folder (no Discord or Slack needed).

### mybot settings for this use

Searches use mybot's keyword index and call no AI model, as long as mybot's query planner is off. Some mybot defaults do call models through your Codex or Claude plan, so a lean `.env` sets:

```bash
TRAJECTORY_SOURCES=codex,claude          # add chumi to also index exported meetings
TRAJECTORY_QUERY_PLANNER=false           # the planner asks a model to rewrite weak searches
BRIEFING_ENABLED=false                   # the daily briefing runs several high-effort agents
TRAJECTORY_INDEX_AUTOBUILD_VECTORS=false # keyword index stays current; embeddings are optional
```

On first start, mybot also runs an agent to work out who you are, unless `state/owner_identity.json` already has a `display_name`.

## Privacy

Meetings contain other people's words, so **exports are owner-only by default**. Each file is marked `visibility: private`, and mybot never uses private sessions when answering anyone but you, even with guest access enabled.

Turning on **Let mybot share meeting content with teammates** re-exports every session without that marker, so mybot's normal sharing rules apply. Only do this if the people in those meetings are comfortable with it, and follow your institution's rules on recording.
