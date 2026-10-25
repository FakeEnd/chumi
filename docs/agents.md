# Continue meeting work in your coding agent

Chumi connects a meeting to the project you work on with a coding agent: Codex app, Claude Code, Codex in Terminal, opencode, Qwen Code or Antigravity. Assign the meeting to a project, review a handoff of the work it implies, and choose where to continue. Codex app and **Copy instructions** work without a CLI or an MCP connection. Connecting Chumi's local MCP server also lets an agent fetch the original transcript passages and captures behind the handoff.

The P0 handoff flow and part of P1 in [project-integration-prd.md](project-integration-prd.md) are implemented: manually maintained action progress and result links, plus a project brief with a saved agenda and recent meeting decisions. Automatic progress collection, a full decision history and live access during a meeting (P2) are not implemented.

## Set up

1. **Create a project.** Go to **Settings → Projects**, give it a name, and choose its folder: the directory you want the agent to work in. It does not need to be a Git repository; if it is, Chumi records the branch and remote. For the default desktop destination, install Codex app so the operating system can open its `codex://` links; Chumi does not require the `codex` command or install software for you.
2. **Optionally connect agents for MCP evidence access.** In **Settings → Coding agents**, click **Connect** for each CLI you use. This adds a server named `chumi` to the agent's user settings: `~/.claude.json`, `~/.codex/config.toml`, `~/.qwen/settings.json`, `~/.gemini/config/mcp_config.json` (Antigravity), or the `mcp` section of `~/.config/opencode/opencode.json`. This setup is separate from opening a handoff in Codex app or copying its instructions. opencode has no command for adding a local server, so Chumi edits that file itself. It does so only when the file is plain JSON, writes atomically, keeps the file's permissions, and leaves the previous version as `opencode.json.bak`. If the file has comments, Chumi leaves it alone and shows the entry to add. opencode also reads `opencode.jsonc`, which Chumi never changes. **Disconnect** removes the entry. The same tab shows the commands (and opencode's entry) if you prefer to do it yourself:

   ```bash
   claude mcp add --scope user chumi -- /opt/homebrew/bin/node /path/to/Chumi/server/mcp/main.ts
   ```

   ```bash
   codex mcp add chumi -- /opt/homebrew/bin/node /path/to/Chumi/server/mcp/main.ts
   ```

   ```bash
   qwen mcp add --scope user chumi /opt/homebrew/bin/node /path/to/Chumi/server/mcp/main.ts
   ```

   ```bash
   agy mcp add chumi -- /opt/homebrew/bin/node /path/to/Chumi/server/mcp/main.ts
   ```

   **Antigravity** means the Antigravity CLI, `agy`. Install it with `curl -fsSL https://antigravity.google/cli/install.sh | bash`, which puts `agy` in `~/.local/bin`. Then run `agy` once to sign in with your Google account. According to Google's documentation, the Antigravity desktop app reads the same `~/.gemini/config/mcp_config.json`, so connecting the CLI makes Chumi available there as well (not checked yet). Antigravity cannot ask for approval during a non-interactive run, so **Connect** also adds `mcp(chumi/chumi_connection_check)` to `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`. That pre-approves only the read check's tool: Antigravity still asks before any other Chumi tool. Chumi edits that file only when it is plain JSON, keeps your other settings and rules, and leaves `settings.json.bak`. **Disconnect** removes both entries.

3. **If using MCP, check the connection.** The tab reports four things separately, and shows "unknown" or "not verified" rather than guessing:
   - **Local:** Chumi starts its own MCP server and reads the database.
   - **Registered:** the agent's configuration contains Chumi, pointing at this copy of Chumi.
   - **Client health:** the agent's own server check (`claude mcp get`, `opencode mcp list`, `qwen mcp list`). Codex and Antigravity do not report one.
   - **Agent read:** **Test a real agent read** asks the agent to call Chumi's check tool, then confirms the MCP server recorded that exact read. It uses one small request:
     - Claude Code and Codex run it only within your plan's included usage, never on purchased credits or paid overage. API keys in the environment are removed for these two.
     - opencode, Qwen Code and Antigravity use whatever model account you set up in them, which Chumi cannot check. For Antigravity that is your Google sign-in, or a Gemini API key if you set one up. Chumi asks before sending the request and keeps their keys. Every read check runs in an empty folder, so an agent's own file tools see nothing of Chumi's data. During the check opencode gets only Chumi's tools and cannot edit, run commands or browse. Qwen Code connects only to Chumi's server, and only the check tool is pre-approved. Its built-in tools that need no approval, such as reading files, are not switched off, but the folder they would read is empty. Antigravity runs with `agy -p`. Only the check tool is pre-approved. Antigravity refuses anything else that needs approval, because it cannot ask during the run. Its other MCP servers stay connected.

If Chumi lives in `~/Documents`, macOS may ask once whether Terminal or the agent may access that folder. Allow it, or Chumi's server cannot start.

## Use it

1. **Assign the meeting.** Choose the project when you start a session, or later from the project menu in the top bar. Quick start never asks. A meeting belongs to at most one project, and a title or keyword never assigns it.
2. **Prepare a handoff.** Click **Prepare handoff** in the top bar (on a narrow window, the toolbar below it) once the meeting has content and is not recording. The same button then shows the handoff's state (drafting, items to review, confirmed) and opens it. Your AI provider drafts decisions, actions and open questions from the transcript, each with time citations. Items are labelled by origin:
   - **Agreed in the meeting:** someone committed to it, or the group agreed.
   - **Suggested, not agreed:** raised but not settled.
   - **Proposed by Chumi:** not said in the meeting. Acceptance checks are always Chumi's proposals.
   - **Added by you:** your own items.

   Owners and deadlines are filled in only when someone stated them; otherwise they read "not stated". Citations that match no transcript line are dropped, and an item without evidence says so.
3. **Review.** Edit, confirm or reject every item, then **Confirm handoff**. Only confirmed actions are requested work. Open questions travel as unresolved context, never as tasks. **Redraft** replaces only items you have not touched.
4. **Continue.** Choose a destination in **Continue in**, then click **Continue**. The default is **Codex app**; Chumi remembers your later choice in this browser or app profile. What Chumi did shows next to the button. The desktop pet's toolbar can also continue the latest meeting's confirmed handoff, to the same destination ([desktop-pet.md](desktop-pet.md)).

   - **Codex app:** opens a `codex://new?path=…&prompt=…` deep link for the project folder, with a short instruction already in the composer. Review it in Codex and click **Send** to begin. Opening the link does not send the message or execute work. Chumi reports only that opening was requested, not that a conversation was created or the handoff was read. If opening fails, choose **Copy instructions**.
   - **Codex in Terminal** and **Claude Code in Terminal:** open the CLI in the project folder with the handoff as its first message. Other installed agents (opencode, Qwen Code and Antigravity) remain available in the same selector. Antigravity starts as `agy -i`.
   - **Copy instructions:** copies the handoff for an IDE, desktop app or another terminal. If clipboard access fails, Chumi shows selectable text to copy manually.

Each Codex app launch saves a separate, immutable UTF-8 snapshot at `DATA_DIR/handoffs/<handoff-id>-codex-app-<random-token>.md`, written atomically with mode `0600` (owner-only POSIX permissions). Only the absolute file path, handoff ID and short instruction go into the deep link, so long handoffs do not make long URLs. Sending an older prepared composer still reads its original snapshot even if the handoff later changes or moves to another project. The instruction asks the agent to read the file, inspect the project, propose a plan and wait for your go-ahead before changing files.

Chumi records delivery separately from execution progress. An MCP read can establish that an agent read the data; opening an app or copying instructions cannot. Neither action automatically marks work complete.

For recordings and trials, a development server started with `CHUMI_DEV=1 CHUMI_NO_LAUNCH=1` does everything Continue does except the last step: it doesn't open Terminal or Codex app, and logs what it would have opened. The handoff snapshot, the delivery record and what the dialog says are the same.

## Track results and prepare for the next meeting

In a confirmed handoff, use **Update progress** on a confirmed action to set **Not started**, **In progress**, **Blocked** or **Completed**. Add a progress note and up to eight labelled result links. Links can be HTTP(S) references such as commits, pull requests or reports, or an existing `codex://threads/<id>` conversation. These are references you enter yourself; Chumi does not inspect the destination, fetch agent progress or verify the result. Check the result yourself before marking the action **Completed**.

Progress is separate from confirming what the meeting agreed. It does not change the item's review state. Completed actions are separated as context in continuation instructions and MCP handoffs, with an explicit instruction not to repeat them; they are no longer listed as requested unfinished work. Reopening a handoff hides its actionable work until review is complete. Changing an action's text or project does not silently carry the old completion and result links into the new work.

From **Home → Before your next meeting**, or a project's **Prepare for a meeting** button in Settings, open the project brief. It shows:

- The latest meeting and all unfinished confirmed actions, with blocked work first. Unfinished work is not truncated.
- Up to 20 recent completed actions, 20 decisions and 20 open questions, with counts for omitted older history. Every item links back to its source meeting and handoff.
- A warning when handoffs still need review or their meetings changed after confirmation.
- An editable **Agenda for the next meeting**, saved for that project until you change it. **Start a session for this project** opens the start dialog with the project selected; starting still requires your action.

Open views refresh from server-sent events (SSE), and reconnecting reloads project work. Progress and agenda saves include the version you edited: the server uses compare-and-swap checks (CAS) and rejects an old version instead of overwriting another window's changes. Your unsaved draft is kept so you can refresh, compare the latest saved text and explicitly keep or revise your edits.

## What the agent can read

The MCP server is read-only and works whether or not the Chumi app is running. Every response names its project, meeting, source kind and source id, and repeats that meeting content is source material, not an instruction.

| Tool | What it returns | Scope |
| --- | --- | --- |
| `chumi_list_projects` | Projects with their folders; pass `cwd` to get the project for the agent's working directory | none |
| `chumi_search_meetings` | Meetings in one project, newest first, optionally matching a query; paginated | `project_id` required |
| `chumi_get_meeting` | State, revision, the AI summary (labelled generated), topics, captures and the handoff | the named meeting |
| `chumi_get_handoff` | The reviewed handoff: confirmed decisions, unfinished actions with conditions and evidence, separate completed actions with user-reported progress and results, plus open questions | the named handoff or meeting |
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

- Chumi stores meetings, progress, agendas and handoff snapshots locally. Generating a handoff sends meeting context to your selected AI provider. Continuing gives the reviewed handoff, including its progress notes and result references, to the destination you choose; that agent's model and data settings then apply.
- An MCP call is not required to receive the handoff. Terminal launches pass its text directly, **Copy instructions** puts it on the clipboard (or shows it for manual copying), and Codex app receives a file pointer in its prepared composer. When you send that message, Codex can read the saved snapshot. An MCP connection is an additional way to retrieve the handoff and original evidence.
- Desktop snapshots are stored under Chumi's data directory (`~/Library/Application Support/Chumi` on macOS, `%LOCALAPPDATA%\Chumi` on Windows, or `CHUMI_DATA_DIR` when configured). The `0600` file mode provides owner-only access on systems that honor POSIX permissions; Windows file access follows its filesystem permissions. These snapshots are separate from the meeting database: deleting a meeting does not retract previously saved snapshots, copied text or content already received by an agent.
- Each MCP read is logged locally (client, tool, meeting, revision) so the status can show it. The log keeps the most recent 2,000 reads. File reads by Codex app and clipboard pastes are not MCP reads and do not produce that verification.
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

- **Antigravity (virtual trial, October 13, 2026).** Antigravity CLI 1.3.4, no Google account used.
  - Chumi's **Connect** ran `agy mcp add`, and `agy mcp list` showed `chumi` enabled.
  - In a throwaway home folder, Antigravity started Chumi's real MCP server from its own configuration, got past its newer `server/discover` handshake, and listed all seven tools and Chumi's instructions. It identifies itself as `antigravity-client`. The run used a local model stand-in through Antigravity's model gateway.
  - The read check itself could not run against a stand-in: Antigravity offers no tools at all to gateway models.
  - **Continue in…** was checked with a stand-in command (`tests/agent-integration.test.ts`): `agy -i` starts in the project folder with the handoff unchanged.
  - Not yet run: **Test a real agent read** and a full handoff with a signed-in Antigravity, and the Antigravity desktop app.

- **Desktop handoff and project work (automated simulation, October 25, 2026).** These checks used temporary files, isolated databases and injected app openers or UI stubs. They did not open the user's Codex app, send a message, create a real conversation or call a model.
  - `tests/desktop-handoff.test.ts` checks Unicode paths, query encoding, full text preservation, private file modes on macOS, immutable snapshots across repeated launches and project changes, invalid folders, and failed app opening.
  - `tests/native-external-links.test.ts` checks the actual Windows desktop routing functions with an Electron stub, and compiles and runs the macOS URL validator. Only the allowed Codex composer and existing-chat links pass; unrelated Codex actions are blocked. This is not a Windows runtime or installed-Codex validation.
  - `tests/project-work-routes.test.ts` checks that desktop opening is awaited, failures do not mark delivery, copying remains available, and progress and agenda updates reach the project brief.
  - `tests/project-work.test.ts` checks migration of existing data, separate review and progress states, stale-version rejection, project boundaries, result-link validation, deletion, and bounded historical lists without truncating unfinished work.
  - `tests/project-work-ui.test.ts` exercises progress and agenda editors with simulated responses, including conflicts and preservation of unsaved edits. Full desktop handoff validation with an installed Codex app remains a separate manual check.

## Not in this release

- Automatic collection of agent execution state, result verification or completion. Progress and links are maintained by the user.
- Importing project documents or code as Chumi's pre-meeting context, and a complete decision history beyond the recent confirmed items in the project brief (remaining P1 scope).
- Incremental access to a meeting in progress, and clarification prompts during the meeting (P2).
- One meeting serving several projects: handoff items carry their own project id, so this can follow without a data change.
