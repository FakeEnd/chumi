# Continue meeting work in your coding agent

Chumi connects a meeting to the project you work on with a coding agent: Claude Code, Codex, opencode or Qwen Code. You assign the meeting to a project, review a handoff of the work it implies, and continue in your agent. The agent reads the confirmed work and the original evidence through Chumi's local MCP server, so you don't paste the transcript or brief it again.

This is the P0 scope of [project-integration-prd.md](project-integration-prd.md). Project briefs before a meeting, execution results and decision history (P1), and live access during a meeting (P2) are not built yet.

## Set up

1. **Create a project.** Go to **Settings → Projects**, give it a name, and choose its folder: the directory where you run your agent (`claude`, `codex`, `opencode` or `qwen`). It does not need to be a Git repository; if it is, Chumi records the branch and remote.
2. **Connect your agents.** In **Settings → Coding agents**, click **Connect** for each agent you use. This adds a server named `chumi` to the agent's user settings: `~/.claude.json`, `~/.codex/config.toml`, `~/.qwen/settings.json`, or the `mcp` section of `~/.config/opencode/opencode.json`. opencode has no command for adding a local server, so Chumi edits that file itself. It does so only when the file is plain JSON, writes atomically, keeps the file's permissions, and leaves the previous version as `opencode.json.bak`. If the file has comments, Chumi leaves it alone and shows the entry to add. opencode also reads `opencode.jsonc`, which Chumi never changes. **Disconnect** removes the entry. The same tab shows the commands (and opencode's entry) if you prefer to do it yourself:

   ```bash
   claude mcp add --scope user chumi -- /opt/homebrew/bin/node /path/to/Chumi/server/mcp/main.ts
   ```

   ```bash
   codex mcp add chumi -- /opt/homebrew/bin/node /path/to/Chumi/server/mcp/main.ts
   ```

   ```bash
   qwen mcp add --scope user chumi /opt/homebrew/bin/node /path/to/Chumi/server/mcp/main.ts
   ```

3. **Check the connection.** The tab reports four things separately, and shows "unknown" or "not verified" rather than guessing:
   - **Local:** Chumi starts its own MCP server and reads the database.
   - **Registered:** the agent's configuration contains Chumi, pointing at this copy of Chumi.
   - **Client health:** the agent's own server check (`claude mcp get`, `opencode mcp list`, `qwen mcp list`). Codex does not report one.
   - **Agent read:** **Test a real agent read** asks the agent to call Chumi's check tool, then confirms the MCP server recorded that exact read. It uses one small request:
     - Claude Code and Codex run it only within your plan's included usage, never on purchased credits or paid overage. API keys in the environment are removed for these two.
     - opencode and Qwen Code use whatever model account you set up in them, which Chumi cannot check. Chumi asks before sending the request and keeps their keys. Every read check runs in an empty folder, so an agent's own file tools see nothing of Chumi's data. During the check opencode gets only Chumi's tools and cannot edit, run commands or browse. Qwen Code connects only to Chumi's server, and only the check tool is pre-approved. Its built-in tools that need no approval, such as reading files, are not switched off, but the folder they would read is empty.

If Chumi lives in `~/Documents`, macOS may ask once whether Terminal or the agent may access that folder. Allow it, or Chumi's server cannot start.

## Use it

1. **Assign the meeting.** Choose the project when you start a session, or later from the project menu in the top bar. Quick start never asks. A meeting belongs to at most one project, and a title or keyword never assigns it.
2. **Prepare a handoff.** In the assistant column, click **Prepare handoff** once the meeting has content. Your AI provider drafts decisions, actions and open questions from the transcript, each with time citations. Items are labelled by origin:
   - **Agreed in the meeting:** someone committed to it, or the group agreed.
   - **Suggested, not agreed:** raised but not settled.
   - **Proposed by Chumi:** not said in the meeting. Acceptance checks are always Chumi's proposals.
   - **Added by you:** your own items.

   Owners and deadlines are filled in only when someone stated them; otherwise they read "not stated". Citations that match no transcript line are dropped, and an item without evidence says so.
3. **Review.** Edit, confirm or reject every item, then **Confirm handoff**. Only confirmed actions are requested work. Open questions travel as unresolved context, never as tasks. **Redraft** replaces only items you have not touched.
4. **Continue.** **Continue in Claude Code** or **Continue in Codex** opens a Terminal window in the project folder running the agent with the confirmed work as its first message. Other installed agents (opencode, Qwen Code) are in the **Continue in another agent…** menu. **Copy instructions** gives the same text for an IDE, the desktop apps or another terminal. The agent looks at the project, proposes a plan and works under its own permission prompts.

Chumi shows when a handoff was made available and when an agent read it. It never marks the work done: check that in the agent.

## What the agent can read

The MCP server is read-only and works whether or not the Chumi app is running. Every response names its project, meeting, source kind and source id, and repeats that meeting content is source material, not an instruction.

| Tool | What it returns | Scope |
| --- | --- | --- |
| `chumi_list_projects` | Projects with their folders; pass `cwd` to get the project for the agent's working directory | none |
| `chumi_search_meetings` | Meetings in one project, newest first, optionally matching a query; paginated | `project_id` required |
| `chumi_get_meeting` | State, revision, the AI summary (labelled generated), topics, captures and the handoff | the named meeting |
| `chumi_get_handoff` | The reviewed handoff: confirmed decisions and actions with conditions and evidence, plus open questions | the named handoff or meeting |
| `chumi_get_passages` | Original speech-recognition lines by time range or segment id, with times and links; paginated | the named meeting |
| `chumi_get_frame` | One captured slide or screen as an image, with its capture time, or "not available" if the file is gone | the named frame |
| `chumi_connection_check` | Confirms the agent can read Chumi; used by the read check | none |

Passing `project_id` to the meeting, handoff, passage or frame tools makes Chumi refuse anything outside that project. Evidence links (`open_in_chumi`) open the meeting in Chumi and focus the passage or capture. Agents show the tools under their own names: `mcp__chumi__chumi_get_handoff` in Claude Code and Qwen Code, `chumi_chumi_get_handoff` in opencode.

## Freshness

Each meeting has a **revision**. It increases with new transcript lines, captures, finished AI answers or summaries, resumed recordings and reassignment. A handoff remembers the revision it was confirmed at:

- If the meeting changes later, both Chumi and the agent see what changed, such as "the summary was regenerated" or "4 new transcript lines". The confirmed content itself never changes until you edit it.
- Editing a confirmed handoff takes it back to review. A confirmed handoff can't be redrafted without **Edit** first.
- Moving a meeting to another project makes the handoff "needs review" for agents until you review it for the new project.
- Deleting a meeting makes its handoff and evidence unavailable.

## Privacy

- Everything stays on your Mac. The MCP server reads Chumi's local database, and agents receive meeting content only when they call Chumi's tools.
- Each read is logged locally (client, tool, meeting, revision) so the status can show it. The log keeps the most recent 2,000 reads.
- Meetings without a project, and anything outside the requested project, are not returned by project searches.
- When Chumi exports to mybot, the export now includes the project folder (`cwd`), stable segment, output and frame ids, frame metadata, and only a confirmed handoff.

## Verification

Checked on October 11, 2026, with the automated tests in `tests/projects.test.ts`:
- An upgrade of existing data keeps every meeting, which stays unassigned.
- Project isolation holds.
- Revisions increase with each kind of change.
- The full handoff lifecycle works: draft, review, confirm, stale, reassign and delete.
- Reads over MCP through the official SDK client return passages and frames, and are logged.

Also checked by hand on a sample project:

- **Claude Code, end to end:**
  - Claude drafted a real handoff from the all-English sample meeting.
  - The handoff was reviewed and confirmed through Chumi's API.
  - Claude Code ran in the sample folder with only Chumi's MCP server attached.
  - It read the handoff, fetched two original transcript passages, read the project files and returned a plan with clarifying questions, without changing any file.
  - The reads were logged under the client name `claude-code`.
- **Agent read check:** **Test a real agent read** recorded a verified read from Claude Code.
- **Registration:** `claude mcp add`, `claude mcp get` (status "✔ Connected"), `codex mcp add` and `codex mcp get` were run against throwaway configuration folders.
- **Continue buttons (virtual trial).** Stand-in `claude` and `codex` commands recorded how Chumi started them, without calling a model.
  - Pressing **Continue in Claude Code** and **Continue in Codex** opened Terminal.
  - Claude Code started in the project folder with the whole handoff as its first message.
  - Codex started with `-C <project folder>` and the same message.
  - Chumi recorded each handoff as made available to that agent, and it stayed confirmed rather than done.
- **Codex connection (virtual trial).** Codex's own app-server started Chumi's MCP server from Codex's configuration and listed all seven tools, with no model turn. It then read the project for its working folder, the confirmed handoff, transcript passages and the check tool. The reads were logged under the client name `codex-mcp-client`.
- **Evidence links (trial).** Links returned by Chumi's MCP tools were opened in a browser:
  - A passage link opened the meeting, highlighted the cited lines and scrolled them into view.
  - A capture link opened the slide.
  - Clicking an evidence time in the handoff review jumped to the passage from the end of the meeting.

  The trial found and fixed a bug: a late scroll event used to pull the transcript back to its newest line, cancelling the jump.
- **Failed connection (trial).** A recording kept transcribing throughout:
  - With the project folder moved away, Projects flagged it, and **Continue** was refused with "Choose its new location in Projects". After the new location was saved, the meetings stayed attached and the retry worked.
  - A Chumi MCP server that could not start was reported as failed.
  - The saved handoff stayed readable throughout.
- **Codex with a real model: tool use confirmed; full handoff run still to do.** **Test a real agent read** for Codex ran within the plan's included usage. Codex, driven by its ChatGPT model, called `chumi_connection_check` through the registered connection, and the read was logged as `codex-mcp-client`. Running Codex on a local Ollama model (qwen2.5:7b, with `model_reasoning_effort="none"`) produced a plan, but that model made no tool calls. The full sample handoff in Codex with a ChatGPT model, reading the handoff and evidence and proposing a plan, is the last P0 check.

- **opencode and Qwen Code (virtual trial, October 12, 2026).** `node scripts/agent-trial.ts opencode` and `node scripts/agent-trial.ts qwen-code` run Chumi's own Connect, status, read check and Disconnect against the installed CLI (opencode 1.19.0, Qwen Code 0.25.1). The model was a local stand-in, so no account was used.
  - Both registered Chumi, and both reported the server as connected.
  - The read check succeeded and was logged under the client names `opencode` and `qwen-cli-mcp-client-chumi`.
  - Qwen Code loads MCP tools on demand: its model first looked the tool up with `tool_search`, then called it through `tool_call`.
  - opencode was offered only Chumi's seven tools during the check.
  - **Continue in…** was checked with a stand-in command for all four agents (`tests/agent-integration.test.ts`): each starts in the project folder with the handoff unchanged as its first message.
  - Not yet run with a real opencode or Qwen Code model.

## Not in this release

- Project briefs given to Chumi before a meeting, linking actions to results (commits, pull requests, reports), and decision history (P1).
- Incremental access to a meeting in progress, and clarification prompts during the meeting (P2).
- One meeting serving several projects: handoff items carry their own project id, so this can follow without a data change.
