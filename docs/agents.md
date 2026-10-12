# Continue meeting work in Claude Code or Codex

Chumi connects a meeting to the project you work on with Claude Code or Codex. You assign the meeting to a project, review a handoff of the work it implies, and continue in your agent. The agent reads the confirmed work and the original evidence through Chumi's local MCP server, so you don't paste the transcript or brief it again.

This is the P0 scope of [project-integration-prd.md](project-integration-prd.md). Project briefs before a meeting, execution results and decision history (P1), and live access during a meeting (P2) are not built yet.

## Set up

1. **Create a project.** Go to **Settings → Projects**, give it a name, and choose its folder: the directory where you run `claude` or `codex`. It does not need to be a Git repository; if it is, Chumi records the branch and remote.
2. **Connect your agents.** In **Settings → Claude Code & Codex**, click **Connect** for each agent you use. This adds a server named `chumi` to the agent's user settings (`~/.claude.json` or `~/.codex/config.toml`). **Disconnect** removes it. The same tab shows the commands if you prefer to run them yourself:

   ```bash
   claude mcp add --scope user chumi -- /opt/homebrew/bin/node /path/to/Chumi/server/mcp/main.ts
   ```

   ```bash
   codex mcp add chumi -- /opt/homebrew/bin/node /path/to/Chumi/server/mcp/main.ts
   ```

3. **Check the connection.** The tab reports four things separately, and shows "unknown" or "not verified" rather than guessing:
   - **Local:** Chumi starts its own MCP server and reads the database.
   - **Registered:** the agent's configuration contains Chumi, pointing at this copy of Chumi.
   - **Client health:** Claude Code's own server check. Codex does not report one.
   - **Agent read:** **Test a real agent read** asks the agent to call Chumi's check tool, then confirms the MCP server recorded that exact read. It uses one small request, and only runs within your plan's included usage: never on purchased credits or paid overage.

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
4. **Continue.** **Continue in Claude Code** or **Continue in Codex** opens a Terminal window in the project folder running the agent with the confirmed work as its first message. **Copy instructions** gives the same text for an IDE, the desktop apps or another terminal. The agent looks at the project, proposes a plan and works under its own permission prompts.

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

Passing `project_id` to the meeting, handoff, passage or frame tools makes Chumi refuse anything outside that project. Evidence links (`open_in_chumi`) open the meeting in Chumi and focus the passage or capture.

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
- **Codex end to end with a model: not verified yet.** The account's weekly Codex usage is exhausted until October 14, and Chumi does not spend purchased credits. Running Codex on a local Ollama model (qwen2.5:7b, with `model_reasoning_effort="none"`) produced a plan from the instructions, but that model made no tool calls. Codex choosing to call Chumi's tools in a real session should be checked with a ChatGPT model once usage resets.

## Not in this release

- Project briefs given to Chumi before a meeting, linking actions to results (commits, pull requests, reports), and decision history (P1).
- Incremental access to a meeting in progress, and clarification prompts during the meeting (P2).
- One meeting serving several projects: handoff items carry their own project id, so this can follow without a data change.
