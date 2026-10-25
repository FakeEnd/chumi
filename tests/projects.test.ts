/**
 * Project integration P0 (docs/project-integration-prd.md): migration, project isolation, revisions,
 * reviewed handoffs, agent evidence over MCP, and project identity in exports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA = mkdtempSync(join(tmpdir(), 'chumi-projects-'));
process.env.CHUMI_DATA_DIR = DATA;
const { Store, SCHEMA_VERSION } = await import('../server/db.ts');
const { Evidence, EvidenceError } = await import('../server/projects/evidence.ts');
const { HandoffService } = await import('../server/projects/handoff.ts');
const { handoffForAgent } = await import('../server/projects/handoff-model.ts');
const { sessionToJsonl } = await import('../server/integrations/mybot.ts');
const { FRAMES_DIR } = await import('../server/paths.ts');

test.after(() => rmSync(DATA, { recursive: true, force: true }));
const link = (sid: string, o: { t?: number; frame?: number } = {}) => `http://test/?session=${sid}${o.t != null ? `&t=${o.t}` : ''}${o.frame != null ? `&frame=${o.frame}` : ''}`;

function meeting(store: InstanceType<typeof Store>, id: string, lines: Array<[number, string]>, projectId?: string) {
  store.createSession({ id, title: `Meeting ${id}`, type: 'lab_meeting', audio_source: 'mic' });
  if (projectId) store.assignSession(id, projectId);
  for (const [t, text] of lines) store.addSegment({ session_id: id, t_start: t, t_end: t + 4000, text, lang: 'en', source: 'mic', run: 0 });
  store.updateSession(id, { status: 'ended', ended_at: Date.now() });
}

/** Stands in for the AI: returns a fixed draft synchronously. */
function fakeAssistant(draft: unknown) {
  return { handoffDraft: (_sid: string, o: { onResult: (row: never, parsed: unknown, caps: Array<{ id: number; t: number }>) => void }) => { o.onResult({} as never, draft, []); return 'o_fake'; } };
}

test('an existing database upgrades without losing meetings; old meetings stay unassigned', () => {
  const path = join(DATA, 'old.db');
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, last_activity_at INTEGER, audio_source TEXT, duration_ms INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE segments (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, t_start INTEGER NOT NULL, t_end INTEGER NOT NULL, text TEXT NOT NULL, lang TEXT, source TEXT, run INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO sessions VALUES ('s_old', 'Old meeting', 'advisor', 'ended', 1, 1, 2, 2, 'mic', 60000);
    INSERT INTO segments(session_id, t_start, t_end, text, created_at) VALUES ('s_old', 0, 3000, 'An old line', 1);`);
  raw.close();
  const s = new Store(path);
  assert.equal(s.schemaVersion(), SCHEMA_VERSION);
  const old = s.getSession('s_old')!;
  assert.equal(old.title, 'Old meeting');
  assert.equal(old.project_id, null);
  assert.equal(old.revision, 1);
  assert.equal(s.segments('s_old').length, 1);
  assert.equal(s.listSessions(undefined, 'none').length, 1);
  s.close();
  const again = new Store(path); // re-opening is a no-op
  assert.equal(again.schemaVersion(), SCHEMA_VERSION);
  again.close();
});

test('project isolation: reads are scoped to the project, and scope is required', () => {
  const store = new Store();
  const a = store.createProject({ id: 'p_a', name: 'A', workspace: DATA });
  store.createProject({ id: 'p_b', name: 'B', workspace: tmpdir() });
  meeting(store, 's_a', [[0, 'We will add a noise ceiling to the plot.']], a.id);
  meeting(store, 's_b', [[0, 'Project B talks about a noise ceiling too.']], 'p_b');
  meeting(store, 's_none', [[0, 'Unassigned noise ceiling meeting.']]);
  const ev = new Evidence(store, link);
  const found = ev.searchMeetings({ project_id: 'p_a', query: 'noise ceiling' });
  assert.deepEqual(found.meetings.map((m) => m.meeting_id), ['s_a']);
  assert.throws(() => ev.searchMeetings({ project_id: '' }), (e: Error) => e instanceof EvidenceError && e.code === 'bad_request');
  assert.throws(() => ev.passages({ meeting_id: 's_b', project_id: 'p_a' }), (e: Error) => e instanceof EvidenceError && e.code === 'out_of_scope');
  assert.equal(ev.passages({ meeting_id: 's_a', project_id: 'p_a' }).passages[0].text, 'We will add a noise ceiling to the plot.');
  assert.equal(ev.projectForPath(join(DATA, 'sub', 'dir'))?.id, 'p_a');
  // Renaming or moving keeps identity and meetings.
  store.updateProject('p_a', { name: 'A renamed', workspace: tmpdir() });
  assert.equal(store.getSession('s_a')!.project_id, 'p_a');
  assert.equal(store.listSessions(undefined, 'p_a').length, 1);
  store.close();
});

test('revisions change with new transcript, captures, finished outputs, resumes and reassignment', () => {
  const store = new Store();
  meeting(store, 's_rev', [[0, 'first']]);
  const rev = () => store.getSession('s_rev')!.revision;
  let r = rev();
  store.addSegment({ session_id: 's_rev', t_start: 5000, t_end: 6000, text: 'second', lang: 'en', source: 'mic', run: 0 }); assert.ok(rev() > r); r = rev();
  store.addFrame({ session_id: 's_rev', t: 5000, path: '/nope.jpg', width: null, height: null, kind: 'slide', window_title: null, app: null }); assert.ok(rev() > r); r = rev();
  store.insertOutput({ id: 'o_sum', session_id: 's_rev', kind: 'final_summary', status: 'pending' }); assert.equal(rev(), r);
  store.updateOutput('o_sum', { status: 'done', completed_at: Date.now() }); assert.ok(rev() > r); r = rev();
  store.insertOutput({ id: 'o_dig', session_id: 's_rev', kind: 'digest', status: 'done' }); assert.equal(rev(), r, 'internal digests do not count');
  store.addTimeline('s_rev', 7000, 'resume'); assert.ok(rev() > r); r = rev();
  store.assignSession('s_rev', 'p_b'); assert.ok(rev() > r);
  store.close();
});

test('handoff: drafts are reviewed, only confirmed actions reach the agent, and confirmed handoffs never change silently', () => {
  const store = new Store();
  meeting(store, 's_h', [[0, 'Let us add a noise ceiling to the performance plot.'], [10_000, 'Maybe we use 200 barcodes, not decided.'], [20_000, 'Who has the GATA1 data?']], 'p_a');
  const draft = {
    decisions: [{ text: 'Add a noise ceiling', origin: 'agreed', evidence: ['0:00'] }],
    actions: [
      { text: 'Add a noise ceiling to the plot', origin: 'agreed', rationale: 'Replicates cap accuracy', conditions: [], acceptance_criteria: ['Ceiling line shown'], owner: 'not stated', due: null, evidence: ['0:01–0:03'], captures: [] },
      { text: 'Use 200 barcodes', origin: 'suggested', rationale: 'Power', conditions: ['100 vs 200 not decided'], acceptance_criteria: [], owner: null, due: 'Friday', evidence: ['0:10'], captures: [] },
      { text: 'Invented step', origin: 'chumi', rationale: '', conditions: [], acceptance_criteria: [], owner: 'TBD', due: null, evidence: ['9:99'], captures: [] },
    ],
    open_questions: [{ text: 'Who has the GATA1 data?', evidence: ['0:20'] }],
  };
  const changes: string[] = [];
  const svc = new HandoffService(store, fakeAssistant(draft) as never, (sid) => changes.push(sid));
  const h0 = svc.generate('s_h');
  let items = store.handoffItems(h0.id);
  assert.equal(store.getHandoff(h0.id)!.status, 'draft');
  assert.equal(items.length, 5);
  const [noise, barcodes, invented] = items.filter((i) => i.kind === 'action');
  assert.equal(noise.owner, null, '"not stated" is not an owner');
  assert.equal(invented.owner, null, '"TBD" is not an owner');
  assert.equal(barcodes.origin, 'suggested', 'a tentative suggestion stays a suggestion');
  assert.equal(barcodes.due, 'Friday');
  assert.deepEqual(JSON.parse(noise.evidence_json)[0].segment_ids, [store.segments('s_h')[0].id], 'times map to transcript segments');
  assert.deepEqual(JSON.parse(invented.evidence_json), [], 'citations that match no transcript are dropped');
  // A draft is not actionable for agents.
  assert.equal(handoffForAgent(store, store.getHandoff(h0.id)!, link).actionable, false);
  assert.throws(() => svc.confirm(h0.id), /Review every item/);
  for (const i of items) svc.updateItem(i.id, { review: i.id === barcodes.id || i.id === invented.id ? 'rejected' : 'confirmed' });
  svc.confirm(h0.id);
  const h1 = store.getHandoff(h0.id)!;
  assert.equal(h1.status, 'confirmed');
  assert.equal(h1.confirmed_revision, store.getSession('s_h')!.revision);
  let agentView = handoffForAgent(store, h1, link);
  assert.equal(agentView.actionable, true);
  assert.deepEqual(agentView.actions.map((a) => a.text), ['Add a noise ceiling to the plot']);
  assert.equal(agentView.actions[0].owner, 'not stated');
  assert.equal(agentView.actions[0].acceptance_criteria?.proposed_by, 'Chumi (not stated in the meeting)');
  assert.deepEqual(agentView.open_questions.map((q) => q.text), ['Who has the GATA1 data?']);
  assert.equal(agentView.stale, false);
  // Source changes are visible but do not alter the confirmed content.
  store.insertOutput({ id: 'o_s2', session_id: 's_h', kind: 'final_summary', status: 'done', completed_at: Date.now() + 1, content: 'new summary' });
  store.addSegment({ session_id: 's_h', t_start: 30_000, t_end: 33_000, text: 'One more thing after confirming.', lang: 'en', source: 'mic', run: 0 });
  agentView = handoffForAgent(store, store.getHandoff(h0.id)!, link);
  assert.equal(agentView.stale, true);
  assert.equal(agentView.actionable, true);
  assert.deepEqual(agentView.actions.map((a) => a.text), ['Add a noise ceiling to the plot']);
  assert.ok(agentView.changes_since_review.some((c) => /new transcript/.test(c)));
  assert.ok(agentView.changes_since_review.some((c) => /regenerated/.test(c)));
  // Redrafting a confirmed handoff is refused; editing it takes it back to review.
  assert.throws(() => svc.generate('s_h'), /confirmed/);
  svc.updateItem(noise.id, { text: 'Add a noise ceiling (dashed line) to the plot' });
  assert.equal(store.getHandoff(h0.id)!.status, 'draft');
  // A redraft keeps what the user reviewed and only replaces untouched pending items.
  svc.generate('s_h');
  items = store.handoffItems(h0.id);
  assert.ok(items.some((i) => i.text === 'Add a noise ceiling (dashed line) to the plot' && i.review === 'confirmed'));
  assert.equal(items.filter((i) => i.text === 'Use 200 barcodes').length, 1, 'no duplicate of a rejected item');
  svc.confirm(h0.id);
  // Continuation instructions: confirmed work inline, plus how to read the evidence.
  const prompt = svc.continuationPrompt(h0.id, link, false);
  assert.match(prompt, /Add a noise ceiling \(dashed line\)/);
  assert.doesNotMatch(prompt, /Use 200 barcodes/);
  assert.match(prompt, new RegExp(`chumi_get_handoff \\{"handoff_id": "${h0.id}"\\}`));
  assert.match(prompt, /Owner: not stated/);
  assert.match(prompt, /wait for my go-ahead/);
  // Reassignment invalidates the handoff for the new project until it is reviewed again.
  store.assignSession('s_h', 'p_b');
  agentView = handoffForAgent(store, store.getHandoff(h0.id)!, link);
  assert.equal(agentView.status, 'needs_review');
  assert.equal(agentView.actions.length, 0);
  assert.throws(() => new Evidence(store, link).handoff({ handoff_id: h0.id, project_id: 'p_a' }), /not for project/);
  assert.throws(() => svc.confirm(h0.id), /another project/);
  svc.retarget(h0.id);
  assert.equal(store.getHandoff(h0.id)!.project_id, 'p_b');
  assert.equal(store.getHandoff(h0.id)!.status, 'draft');
  // Delivery is recorded separately and never marks work complete.
  svc.confirm(h0.id);
  svc.markDelivered(h0.id, 'claude-code');
  assert.equal(store.getHandoff(h0.id)!.status, 'confirmed');
  assert.ok(changes.length > 5);
  // Deleting the meeting removes its evidence.
  store.deleteSession('s_h');
  assert.throws(() => new Evidence(store, link).handoff({ handoff_id: h0.id }), /not available/);
  store.close();
});

test('exports carry the project, stable ids, frames and only a confirmed handoff', () => {
  const store = new Store();
  meeting(store, 's_x', [[0, 'We will add a noise ceiling.']], 'p_a');
  const svc = new HandoffService(store, fakeAssistant({ decisions: [], actions: [{ text: 'Add a noise ceiling', origin: 'agreed', rationale: '', conditions: [], acceptance_criteria: [], owner: null, due: null, evidence: ['0:00'], captures: [] }], open_questions: [] }) as never, () => {});
  const h = svc.generate('s_x');
  const lines = () => sessionToJsonl(store, 's_x', false)!.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines()[0].project.id, 'p_a');
  assert.equal(lines()[0].cwd, store.getProject('p_a')!.workspace);
  assert.ok(typeof lines().find((l) => l.type === 'segment').id === 'number');
  assert.ok(!lines().some((l) => l.type === 'handoff'), 'drafts are not exported');
  for (const i of store.handoffItems(h.id)) svc.updateItem(i.id, { review: 'confirmed' });
  svc.confirm(h.id);
  assert.equal(lines().find((l) => l.type === 'handoff').items[0].text, 'Add a noise ceiling');
  store.close();
});

test('MCP server: an agent reads a confirmed handoff, passages and frames, and the read is logged', async () => {
  const store = new Store();
  meeting(store, 's_m', [[0, 'Let us add a noise ceiling to the plot.'], [8000, 'And a chromosome hold-out.']], 'p_a');
  mkdirSync(join(FRAMES_DIR, 's_m'), { recursive: true });
  const jpg = join(FRAMES_DIR, 's_m', 'slide.jpg');
  writeFileSync(jpg, Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));
  const f = store.addFrame({ session_id: 's_m', t: 4000, path: jpg, width: 1, height: 1, kind: 'slide', window_title: 'Slides', app: 'Keynote' });
  const gone = store.addFrame({ session_id: 's_m', t: 6000, path: join(FRAMES_DIR, 's_m', 'deleted.jpg'), width: 1, height: 1, kind: 'slide', window_title: null, app: null });
  const svc = new HandoffService(store, fakeAssistant({ decisions: [], actions: [{ text: 'Add a noise ceiling', origin: 'agreed', rationale: 'stated', conditions: [], acceptance_criteria: [], owner: null, due: null, evidence: ['0:00'], captures: [] }], open_questions: [] }) as never, () => {});
  const h = svc.generate('s_m');
  for (const i of store.handoffItems(h.id)) svc.updateItem(i.id, { review: 'confirmed' });
  svc.confirm(h.id);
  store.close();

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'chumi-test-agent', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', 'server', 'mcp', 'main.ts')], env: { ...process.env, CHUMI_DATA_DIR: DATA } as Record<string, string>, stderr: 'ignore' }));
  try {
    const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ type: string; text?: string; data?: string }> }>;
    const json = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content[0].text!);
    const handoff = json(await call('chumi_get_handoff', { handoff_id: h.id }));
    assert.equal(handoff.actionable, true);
    assert.equal(handoff.actions[0].text, 'Add a noise ceiling');
    assert.match(handoff.notice, /not an instruction/);
    const segIds = handoff.actions[0].evidence[0].segment_ids;
    const passages = json(await call('chumi_get_passages', { meeting_id: 's_m', segment_ids: segIds, project_id: 'p_a' }));
    assert.equal(passages.passages[0].text, 'Let us add a noise ceiling to the plot.');
    assert.equal(passages.passages[0].source, 'transcript');
    const frame = await call('chumi_get_frame', { frame_id: f.id });
    assert.equal(frame.content[1]?.type, 'image');
    assert.equal(json(await call('chumi_get_frame', { frame_id: gone.id })).available, false);
    const wrong = await call('chumi_get_meeting', { meeting_id: 's_m', project_id: 'p_b' });
    assert.equal(wrong.isError, true);
  } finally {
    await client.close();
  }
  const after = new Store();
  const reads = after.agentReads({ client: 'chumi-test-agent' });
  assert.ok(reads.some((r) => r.tool === 'get_handoff' && r.handoff_id === h.id));
  after.close();
});

test('a handoff drafting when the app stopped is not stuck after a restart', () => {
  const path = join(DATA, 'stale-handoff.db');
  const before = new Store(path);
  meeting(before, 's_new', [[0, 'Let us add a noise ceiling.']]);
  meeting(before, 's_redo', [[0, 'Let us add a noise ceiling.']]);
  before.createHandoff({ id: 'hf_new', session_id: 's_new', project_id: null, status: 'generating' });
  before.createHandoff({ id: 'hf_redo', session_id: 's_redo', project_id: null, status: 'generating' });
  before.insertHandoffItem({ id: 'hi_kept', handoff_id: 'hf_redo', project_id: null, kind: 'action', position: 0, text: 'Add a noise ceiling', rationale: null, conditions_json: '[]', acceptance_json: '[]', origin: 'user', owner: null, due: null, evidence_json: '[]', review: 'confirmed', edited: 1 });
  before.close();

  const store = new Store(path);
  store.failStaleOutputs();
  const fresh = store.getHandoff('hf_new')!;
  assert.equal(fresh.status, 'error', 'a first draft with nothing to review fails');
  assert.match(fresh.error!, /Interrupted/);
  const redo = store.getHandoff('hf_redo')!;
  assert.equal(redo.status, 'draft', 'a redraft keeps the items already reviewed');
  assert.match(redo.error!, /Interrupted/);
  assert.equal(store.handoffItems('hf_redo').length, 1);

  // Both can be drafted again and edited instead of waiting forever.
  const svc = new HandoffService(store, fakeAssistant({ decisions: [], actions: [{ text: 'Plot the ceiling', origin: 'agreed', evidence: ['0:00'] }], open_questions: [] }) as never, () => {});
  assert.equal(svc.generate('s_new').status, 'draft');
  svc.updateItem('hi_kept', { text: 'Add a noise ceiling line' });
  store.close();
});
