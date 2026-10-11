# Chumi Project Integration Requirements

Status: Draft for implementation planning  
Date: October 11, 2026  
Audience: Product and engineering contributors

## Product objective

Chumi should connect academic meetings to the projects users work on with Claude Code and Codex. A user should be able to capture a discussion, identify what was decided, and continue the corresponding work in their existing project with the original evidence available to the agent.

The initial release will complete the post-meeting workflow: **associate a meeting with a project, let the project agent retrieve its evidence, and hand over user-confirmed work.** Later releases will bring project context into meetings and connect execution results to subsequent discussions.

Reusing an existing AI subscription is part of the value proposition. The lasting product value is reducing the effort and errors involved in carrying context from a conversation into actual work. Subscription reuse, model choice, and agent access are not assumed to be unique to Chumi.

## Target users and needs

The initial audience is researchers and graduate students who attend recurring lab meetings or advisor meetings and already use Claude Code or Codex for code, experiments, analysis, or writing.

Their primary needs are:

- Continue project work without explaining the entire meeting to an agent again.
- Retrieve the original reasoning behind a requested change.
- Distinguish confirmed decisions from suggestions and unresolved questions.
- Keep unrelated projects and their meeting context separate.
- Carry useful project history into the next meeting.

These are product hypotheses to validate with real workflows. This document does not assume demonstrated demand or willingness to pay.

## Current implementation

The following baseline describes the code reviewed on October 11, 2026.

| Area | Existing capability | Remaining gap |
| --- | --- | --- |
| AI access | Chumi invokes Codex and Claude Code using the configured account and model. Codex creates ephemeral threads in Chumi's independent working directory; Claude runs without session persistence and with tools disabled. | These calls do not continue the user's existing project conversation or execution environment. See [Codex provider](../server/ai/codex.ts), [Claude provider](../server/ai/claude-cli.ts), and [paths](../server/paths.ts). |
| Meeting evidence | SQLite stores raw transcript segments, generated outputs, recording gaps, and captured frames separately. Segments have IDs and timestamps. | Evidence needs a stable, supported contract for project agents. See [data model](../server/db.ts). |
| Retrieval | Historical search and retrieval of transcript passages already exist. Chumi's question context is assembled primarily from the current meeting. | There is no project boundary or project-scoped retrieval. See [context assembly](../server/ai/context.ts) and [assistant](../server/ai/assistant.ts). |
| mybot integration | Finished or interrupted sessions can be exported with transcript, questions, answers, and summary. A source adapter makes them available to mybot. | The export has no project association, stable segment/output IDs, or captured frames. The adapter sets `cwd` to an empty string. See [exporter](../server/integrations/mybot.ts) and [adapter](../integrations/mybot/chumi.py). |
| User workflow | Users can start meetings, ask questions, generate summaries, and download Markdown or text. | There is no project selector, structured handoff review, or project continuation flow. See [start dialog](../web/src/components/StartDialog.tsx) and [assistant UI](../web/src/components/Assistant.tsx). |
| Integration status | Chumi reports the export directory and number of exported files. | It cannot establish that a downstream agent has retrieved the latest meeting content. See `MybotExporter.status()` in the [exporter](../server/integrations/mybot.ts). |

Existing verification covers export structure, mybot indexing, transcript window reads, and keyword search. The recorded verification did not exercise mybot's embedding or chat paths, or a full meeting-to-project execution workflow. It also records that a real Codex completion was deferred because the account quota was exhausted. These are validation gaps, not assertions that those paths fail. See [verification notes](verification.md).

## Release scope and priorities

| Priority | Scope | User outcome |
| --- | --- | --- |
| P0 | Project association, agent-readable evidence, reviewed task handoff, and connection checks | A user can continue one meeting's confirmed work in the correct Claude Code or Codex project. |
| P1 | Project briefs, execution result links, and decision history | Context travels in both directions, and the next meeting reflects what happened after the last one. |
| P2 | Incremental access to active meetings and contextual clarification prompts | A project agent can use current discussion, and Chumi can help resolve missing information before the meeting ends. |

The first release will not include autonomous code execution inside Chumi, a replacement coding-agent interface, comprehensive project management, team-wide permissions, additional model providers, or a new vector database. Meetings without a project association must remain usable.

## P0 requirements

### Project association

**PRJ-01:** Users can create a project with a stable ID, display name, and local workspace directory. The directory does not need to be a Git repository. Repository metadata may be recorded when available.

**PRJ-02:** A meeting can belong to one project in the initial release. Users can select the project before recording or assign it afterward. Quick start remains available without requiring a project selection.

**PRJ-03:** The meeting view displays its project. History and agent retrieval support an explicit project filter. Renaming a project or changing its configured location must preserve its identity and meeting associations.

**PRJ-04:** Project identity propagates through exports and the mybot adapter. Existing sessions remain unassigned until the user associates them. A title or keyword match must not silently establish project ownership.

**PRJ-05:** Reassigning a meeting invalidates its previous project association in subsequent retrieval. Existing handoffs must identify the project they were created for and require review before reuse in another project.

### Agent access and evidence

**CTX-01:** Provide a supported local agent entry point, with installation instructions for both Claude Code and Codex. A local MCP server can provide the initial integration, backed by the existing storage and retrieval logic. A CLI or exported meeting package may provide a fallback.

**CTX-02:** The integration supports four operations: search meetings within a project, read a meeting overview and handoff, retrieve cited transcript passages, and retrieve referenced frames. Responses must be bounded and support pagination or explicit limits where needed.

**CTX-03:** Every retrieved item identifies its project, meeting, source type, and source ID. Transcript evidence includes the original ASR text and start/end times. Generated summaries and interpretations are explicitly distinguishable from transcript evidence.

**CTX-04:** Relevant screenshots can be fetched on demand using stable frame references and capture times. Missing or deleted evidence must be reported as unavailable. An agent must not need every screenshot or the full transcript to start a task.

**CTX-05:** Responses include a content revision and meeting lifecycle state. Summary regeneration, new outputs, resumed recordings, reassignment, and deletion must not leave downstream consumers silently treating an old snapshot as current.

**CTX-06:** Evidence links open the correct meeting and focus the referenced passage or frame in Chumi. The current meeting-level URL support should be extended to support passage-level navigation.

**CTX-07:** Retrieval requires an explicit project scope or a user-selected meeting. Meeting content is supplied as source material; it does not authorize the receiving agent to perform actions.

### Reviewed task handoff

**HND-01:** Once a meeting has usable content, users can generate a handoff draft containing decisions, proposed actions, and open questions. Generation may use the existing AI provider abstraction.

**HND-02:** Each item contains a stable ID, project ID, meeting ID, description, evidence references, and review status. Action items can additionally contain a rationale, unresolved conditions, and proposed acceptance criteria. Owners, deadlines, and other unspecified facts remain unset.

**HND-03:** The review interface lets users edit, confirm, or reject items. AI-proposed actions and acceptance criteria must remain distinguishable from commitments explicitly made in the meeting. Only confirmed actions enter the actionable handoff; open questions travel as unresolved context.

**HND-04:** A confirmed handoff records the reviewed content and source revision. Regenerating a summary must not silently change a previously confirmed handoff. If the source changes, Chumi indicates that the handoff may need review.

**HND-05:** A visible continuation action prepares the handoff for the selected project and agent. It includes the project location, confirmed actions, unresolved conditions, and references for further evidence retrieval. Use supported client integration mechanisms; when direct opening is unavailable, provide a clear copyable instruction and accessible handoff reference.

**HND-06:** The receiving Claude Code or Codex agent reads the actual project and proposes or performs work under its existing user interaction and permission model. Chumi does not treat a successful launch or copied prompt as successful execution.

**HND-07:** Repeating a handoff operation preserves its identity. The UI distinguishes a draft, a confirmed handoff, and a handoff made available to the agent. Submission alone must never mark the underlying work complete.

### Connection and freshness feedback

**INT-01:** Integration setup includes an actual read check that retrieves a known meeting or handoff through the selected agent access path. Both Claude Code and Codex paths must be verified before they are described as supported.

**INT-02:** Status distinguishes local availability, export completion, downstream indexing when verifiable, and a successful agent read. Unsupported checks display an unknown or unverified state.

**INT-03:** Connection failures, unavailable project directories, missing evidence, and stale revisions provide a recovery action such as reconnect, choose a new location, refresh, or retry. Failures must not interrupt meeting capture.

## P1 requirements

### Project context before the meeting

Allow users or their project agent to provide a concise project brief containing the current objective, recent changes, relevant results, and questions to discuss. The brief records its origin and update time and is visible to the user before use.

Chumi includes the selected brief in meeting analysis while keeping project facts distinguishable from statements made during the meeting. Start with an explicit brief and selected materials; automatic repository-wide ingestion is unnecessary for this phase.

### Execution results and decision history

Allow confirmed action items to reference an agent conversation, changed files, commit, pull request, experiment report, or document. Manual linking is sufficient initially. Record execution states such as not started, in progress, blocked, and completed separately from handoff delivery.

Support explicit relationships between decisions, including a decision that supersedes an earlier one. Preserve both the earlier evidence and the reason for the change. A newer mention must not automatically override a confirmed decision.

Before a recurring meeting, show relevant open actions, linked results, unresolved conditions, and changed decisions for that project.

## P2 requirements

Expose new transcript segments and evidence from an active meeting through an incremental cursor. Consumers can reconnect without duplicates and see the latest covered time. Provisional ASR text remains distinguishable from finalized segments.

Use the selected project context to identify missing information that could block execution, such as an unspecified dataset split or comparison baseline. Present short, optional clarification prompts with supporting evidence. Measure whether these prompts reduce later clarification without distracting the listener.

Live access must not automatically authorize project modifications or promote a tentative statement to a confirmed task.

## Data and architecture guidance

The implementation should extend the existing store with project associations and structured handoff records. A conceptual minimum is:

| Record | Required information |
| --- | --- |
| Project | Stable ID, name, workspace location, optional repository metadata |
| Meeting association | Meeting ID and project ID |
| Evidence reference | Meeting ID, source kind, segment/output/frame ID, applicable timestamps and revision |
| Handoff | ID, project ID, meeting ID, reviewed revision, review and delivery state |
| Handoff item | ID, type, description, evidence references, review status, unresolved conditions |
| Execution reference in P1 | Action ID, result type and location, execution state, update time |

Use explicit database migrations when extending the existing schema. Preserve current recordings, outputs, settings, and unassigned meetings.

Keep `AIProvider.complete()` responsible for meeting analysis. Add project association, evidence retrieval, and handoff services around it. If Chumi later runs project agents itself, introduce a separate execution component for persistent sessions, tool events, permissions, cancellation, and results.

Reuse the existing session-end and output-completion hooks to refresh integration data. Keep mybot as a supported route to unified memory, while making Chumi's source evidence available through a stable interface. Avoid introducing a second search system before the existing retrieval has been evaluated for the project workflow.

## Acceptance scenarios

| Phase | Scenario | Required result |
| --- | --- | --- |
| P0 | Project isolation | With meetings assigned to projects A and B, a project A request returns only A's meetings unless the user explicitly selects another scope. |
| P0 | Existing data | An existing installation upgrades without losing meetings. Older meetings remain usable and can be assigned to projects afterward. |
| P0 | Suggestions and decisions | A tentative suggestion is not presented as an approved action. Unspecified owners, deadlines, and parameters remain unresolved. |
| P0 | Evidence access | An agent can retrieve the original passage and relevant frame behind an item, and the user can navigate to the same evidence in Chumi. |
| P0 | Source changes | Regenerating a summary or resuming a meeting produces an observable revision change and does not silently alter a confirmed handoff. |
| P0 | Removal or reassignment | New reads reflect deletion or reassignment; retained snapshots are identified as stale or unavailable rather than current evidence. |
| P0 | Claude Code handoff | In a sample project, Claude Code retrieves a confirmed meeting task and its evidence, reads the project, and produces a reviewable plan or change without the user pasting the transcript. |
| P0 | Codex handoff | The equivalent sample workflow succeeds independently in Codex. Passing one client does not establish support for the other. |
| P0 | Failed connection | A failed read or unavailable project path is visible and retryable. Meeting recording and saved data remain available. |
| P1 | Return path | A task can be linked to a result, and the next meeting displays its actual status without inferring completion from delivery. |

## Validation and success measures

Pilot the P0 workflow with 6–10 researchers over two weeks. Compare it with their existing process of reading a summary and manually briefing their project agent.

Measure time from meeting end to the first usable project plan or change, the number of additional explanations the user must supply, incorrect task interpretations, incorrect project associations, and voluntary reuse in the second week. Record the ability to trace an action back to its source as a separate quality measure.

Set numerical improvement targets after collecting the baseline. P0 release readiness requires passing all P0 acceptance scenarios, including independent handoff verification for both clients, with no known project-isolation or stale-handoff failures in that suite.

## Implementation sequence

1. Add project identity, database migration, meeting assignment, and project-filtered retrieval.
2. Add stable evidence references, content revisions, agent access, and connection checks.
3. Add structured handoff generation, user review, and continuation in Claude Code and Codex.
4. Validate the complete P0 workflow on representative projects.
5. Add project briefs, execution references, and decision history.
6. Extend the verified workflow to active meetings and timely clarification prompts.

The first release is complete when a user can associate a real meeting with a project, confirm the work it implies, and continue that work in their existing agent with the right evidence and minimal re-explanation.
