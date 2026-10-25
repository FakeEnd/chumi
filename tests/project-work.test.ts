import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION, type HandoffItemRow } from '../server/db.ts';
import { HandoffService } from '../server/projects/handoff.ts';
import { handoffForAgent, handoffPublic } from '../server/projects/handoff-model.ts';
import { ProjectWorkService, ProjectWorkError } from '../server/projects/work.ts';
import { isActionResultUrl, type ActionProgress } from '../shared/project-work.ts';
import type { Assistant } from '../server/ai/assistant.ts';

function setup(t: TestContext, path = ':memory:') {
  const store = new Store(path);
  store.createProject({ id: 'p', name: 'Project P', workspace: '/tmp/project-work-p' });
  store.createProject({ id: 'q', name: 'Project Q', workspace: '/tmp/project-work-q' });
  const work = new ProjectWorkService(store);
  const handoffs = new HandoffService(store, {} as never, () => {});
  t.after(() => store.close());
  const meeting = (id: string, projectId = 'p', at = 1000, kinds: HandoffItemRow['kind'][] = ['action']) => {
    store.createSession({ id, title: `Meeting ${id}`, type: 'other', audio_source: 'mic' });
    store.assignSession(id, projectId);
    store.updateSession(id, { started_at: at, status: 'ended' });
    store.addSegment({ session_id: id, t_start: 0, t_end: 1000, text: 'Synthetic meeting evidence.', lang: 'en', source: 'mic', run: 1 });
    const h = store.createHandoff({ id: `h_${id}`, session_id: id, project_id: projectId, status: 'draft' });
    const items = kinds.map((kind, i) => {
      const item: Omit<HandoffItemRow, 'updated_at'> = {
        id: `${id}_${i}`, handoff_id: h.id, project_id: projectId, kind, position: i, text: `${kind} for ${id} ${i}`,
        rationale: null, conditions_json: null, acceptance_json: null, origin: 'user', owner: 'Researcher', due: null,
        evidence_json: '[]', review: 'confirmed', edited: 1,
      };
      store.insertHandoffItem(item);
      return item.id;
    });
    handoffs.confirm(h.id);
    return { id, handoffId: h.id, items };
  };
  const progress = (id: string) => store.actionProgress(store.getHandoffItem(id)!);
  const update = (id: string, patch: Partial<Pick<ActionProgress, 'status' | 'note' | 'results'>>) => work.updateProgress(id, { expectedVersion: progress(id).version, ...patch }).progress;
  return { store, work, handoffs, meeting, progress, update };
}
const code = (status: number) => (error: unknown) => error instanceof ProjectWorkError && error.status === status;

test('v3 migration preserves existing meetings, handoffs, outputs and settings and seeds untouched progress', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-work-migration-'));
  const path = join(dir, 'meeting.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = new Store(path);
  old.createProject({ id: 'p', name: 'Original project', workspace: dir });
  old.createSession({ id: 's', title: 'Original meeting', type: 'other', audio_source: 'mic' });
  old.assignSession('s', 'p');
  old.createHandoff({ id: 'h', session_id: 's', project_id: 'p', status: 'confirmed' });
  old.insertHandoffItem({ id: 'i', handoff_id: 'h', project_id: 'p', kind: 'action', position: 0, text: 'Keep this action', rationale: null,
    conditions_json: null, acceptance_json: null, origin: 'agreed', owner: null, due: null, evidence_json: '[]', review: 'confirmed', edited: 0 });
  old.insertOutput({ id: 'o', session_id: 's', kind: 'answer', status: 'done', content: 'Keep this answer' });
  old.setKV('migration-fixture', { keep: true });
  const before = { session: old.getSession('s'), handoff: old.getHandoff('h'), item: old.getHandoffItem('i') };
  old.db.exec(`DROP TRIGGER work_item_created; DROP TRIGGER work_item_changed; DROP TRIGGER work_review_changed; DROP TRIGGER work_project_changed;
    DROP TABLE action_progress; DROP TABLE project_agendas; PRAGMA user_version = 3;`);
  old.close();
  const upgraded = new Store(path);
  assert.equal(upgraded.schemaVersion(), SCHEMA_VERSION);
  assert.deepEqual({ session: upgraded.getSession('s'), handoff: upgraded.getHandoff('h'), item: upgraded.getHandoffItem('i') }, before);
  assert.equal(upgraded.getOutput('o')!.content, 'Keep this answer');
  assert.deepEqual(upgraded.getKV('migration-fixture', null), { keep: true });
  assert.deepEqual(upgraded.actionProgress(upgraded.getHandoffItem('i')!), { status: 'not_started', note: '', results: [], updatedAt: null, version: 0 });
  assert.deepEqual(upgraded.projectAgenda('p'), { text: '', updatedAt: null, version: 0 });
  upgraded.close();
  const reopened = new Store(path);
  assert.equal(reopened.schemaVersion(), SCHEMA_VERSION);
  assert.equal(reopened.handoffItems('h').length, 1);
  reopened.close();
});

test('manual execution progress is independent of review and delivery; agents do not receive completed work as pending', (t) => {
  const f = setup(t), m = f.meeting('s');
  const item = m.items[0];
  const h = f.store.getHandoff(m.handoffId)!;
  const revision = f.store.getSession(m.id)!.revision;
  f.handoffs.markDelivered(m.handoffId, 'codex');
  assert.equal(f.progress(item).status, 'not_started');
  f.update(item, { status: 'in_progress', note: 'Experiment running' });
  const done = f.update(item, { status: 'completed', note: 'Validated by hand', results: [{ label: 'Report', url: 'https://example.test/report' }, { label: 'Agent conversation', url: 'codex://threads/019abc-1234' }] });
  assert.equal(done.status, 'completed');
  assert.ok(done.updatedAt);
  assert.equal(f.store.getHandoff(m.handoffId)!.status, 'confirmed');
  assert.equal(f.store.getHandoff(m.handoffId)!.confirmed_revision, h.confirmed_revision);
  assert.equal(f.store.getHandoffItem(item)!.review, 'confirmed');
  assert.equal(f.store.getSession(m.id)!.revision, revision, 'a work update does not change meeting evidence');
  assert.deepEqual(handoffPublic(f.store, f.store.getHandoff(m.handoffId)!).items[0].progress, done);
  const agent = handoffForAgent(f.store, f.store.getHandoff(m.handoffId)!, () => null);
  assert.equal(agent.actions.length, 0);
  assert.equal(agent.completed_actions[0].progress!.results.length, 2);
  assert.match(agent.progress_notice, /do not repeat/i);
  assert.equal(f.work.brief('p').actions.length, 0);
  assert.equal(f.work.brief('p').completedActions[0].id, item);
});

test('progress and agenda reject stale versions without overwriting the first editor', (t) => {
  const f = setup(t), m = f.meeting('s'), id = m.items[0];
  const oldVersion = f.progress(id).version;
  const first = f.work.updateProgress(id, { expectedVersion: oldVersion, note: 'First editor', status: 'blocked' }).progress;
  assert.throws(() => f.work.updateProgress(id, { expectedVersion: oldVersion, note: 'Second editor' }), code(409));
  assert.deepEqual(f.progress(id), first);
  assert.throws(() => f.work.updateProgress(id, { status: 'completed' }), code(400));
  const agenda = f.work.updateAgenda('p', { expectedVersion: 0, text: 'Discuss the blocked experiment' });
  assert.equal(agenda.version, 1);
  assert.throws(() => f.work.updateAgenda('p', { expectedVersion: 0, text: 'Stale replacement' }), code(409));
  assert.deepEqual(f.work.brief('p').agenda, agenda);
  assert.equal(f.work.updateAgenda('p', { expectedVersion: 1, text: '' }).version, 2);
  assert.throws(() => f.work.updateAgenda('p', { expectedVersion: 2, text: 'x'.repeat(8001) }), code(400));
  assert.equal(f.work.brief('q').agenda.text, '');
});

test('result links accept web references and exact Codex threads while rejecting unsafe schemes and excessive input', (t) => {
  const f = setup(t), id = f.meeting('s').items[0];
  for (const url of ['https://example.test/a?q=1#result', 'http://127.0.0.1:4777/', 'codex://threads/019abc_123-456']) assert.equal(isActionResultUrl(url), true, url);
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/a', 'https://user:secret@example.test', 'http://user@example.test', 'https://example.test/\nscript', 'http:\\example.test',
    'codex://threads/id?open=true', 'codex://threads/id#x', 'codex://threads:123/id', 'codex://user@threads/id', 'codex://threads/../id', 'codex://threads/id/extra', 'codex://threads/id%2Fextra']) {
    assert.equal(isActionResultUrl(url), false, url);
    assert.throws(() => f.update(id, { results: [{ label: 'Bad', url }] }), code(400));
  }
  for (const patch of [{ note: 'x'.repeat(4001) }, { results: Array.from({ length: 9 }, () => ({ label: 'Result', url: 'https://example.test' })) },
    { results: [{ label: 'x'.repeat(121), url: 'https://example.test' }] }, { results: [{ label: 'Result', url: `https://example.test/${'x'.repeat(2048)}` }] }]) {
    assert.throws(() => f.update(id, patch), code(400));
  }
  assert.equal(f.progress(id).status, 'not_started');
  assert.deepEqual(f.progress(id).results, []);
});

test('only confirmed actions in a confirmed handoff for the current project accept progress', (t) => {
  const f = setup(t), m = f.meeting('s', 'p', 1000, ['action', 'decision']);
  const id = m.items[0];
  assert.throws(() => f.update(m.items[1], { status: 'completed' }), code(400));
  f.store.updateHandoffItem(id, { review: 'pending' });
  assert.throws(() => f.update(id, { status: 'completed' }), code(409));
  f.store.updateHandoffItem(id, { review: 'confirmed' });
  f.handoffs.reopen(m.handoffId);
  assert.throws(() => f.update(id, { status: 'completed' }), code(409));
  assert.equal(f.work.brief('p').actions.length, 0);
  assert.equal(f.work.brief('p').reviewNeededCount, 1);
  f.handoffs.confirm(m.handoffId);
  f.store.updateHandoffItem(id, { project_id: 'q' });
  assert.throws(() => f.update(id, { status: 'completed' }), code(409));
  assert.equal(f.work.brief('p').actions.length, 0);
  f.store.assignSession(m.id, null);
  assert.throws(() => f.update(id, { status: 'completed' }), code(409));
  assert.throws(() => f.work.updateProgress('missing', { expectedVersion: 0, status: 'completed' }), code(404));
  assert.throws(() => f.work.brief('missing'), code(404));
});

test('reassignment hides old-project progress and invalidates old editors, including after retarget and confirmation', (t) => {
  const f = setup(t), m = f.meeting('s'), id = m.items[0];
  const old = f.update(id, { status: 'completed', note: 'Private project P result', results: [{ label: 'P report', url: 'https://example.test/p' }] });
  f.store.assignSession(m.id, 'q');
  assert.equal(f.work.brief('p').completedActions.length, 0);
  assert.equal(f.work.brief('q').actions.length, 0);
  assert.equal(f.work.brief('q').reviewNeededCount, 1);
  assert.equal(handoffPublic(f.store, f.store.getHandoff(m.handoffId)!).items[0].progress, null);
  assert.equal(handoffForAgent(f.store, f.store.getHandoff(m.handoffId)!, () => null).completed_actions.length, 0);
  f.handoffs.retarget(m.handoffId);
  f.handoffs.confirm(m.handoffId);
  const fresh = f.work.brief('q').actions[0].progress;
  assert.deepEqual({ ...fresh, version: 0 }, { status: 'not_started', note: '', results: [], updatedAt: null, version: 0 });
  assert.ok(fresh.version > old.version);
  assert.throws(() => f.work.updateProgress(id, { expectedVersion: old.version, status: 'completed' }), code(409));
  f.update(id, { note: 'New project Q work' });
  assert.equal(f.work.brief('q').actions[0].progress.note, 'New project Q work');
  assert.equal(f.work.brief('p').actions.length, 0);
});

test('a successful redraft cannot silently retarget retained reviewed work or its progress', (t) => {
  const f = setup(t);
  const m = f.meeting('redrafted');
  const oldId = m.items[0];
  f.update(oldId, { status: 'completed', note: 'Private progress for Project P', results: [{ label: 'P result', url: 'https://example.test/p-result' }] });
  f.store.assignSession(m.id, 'q');
  f.handoffs.reopen(m.handoffId);
  const assistant = { handoffDraft: (sid: string, options: Parameters<Assistant['handoffDraft']>[1]) => {
    const session = f.store.getSession(sid)!;
    options.onResult({} as never, { decisions: [], actions: [{ text: 'Investigate turbine blade geometry', origin: 'agreed' }], open_questions: [] }, [], {
      revision: session.revision, segmentMax: f.store.maxSegmentId(sid), projectId: session.project_id, capturedAt: Date.now(),
    });
    return 'synthetic-draft';
  } };
  const handoffs = new HandoffService(f.store, assistant as never, () => {});
  handoffs.generate(m.id);
  const freshId = f.store.handoffItems(m.handoffId).find((i) => i.id !== oldId)!.id;
  handoffs.updateItem(freshId, { review: 'confirmed' });
  assert.equal(f.store.getHandoff(m.handoffId)!.project_id, 'q');
  assert.equal(f.store.getHandoffItem(oldId)!.project_id, 'p', 'redraft does not authorize moving reviewed work');
  assert.equal(handoffs.view(m.id)!.project_mismatch, true, 'the UI must offer the explicit review-for-project path');
  assert.throws(() => handoffs.confirm(m.handoffId), /another project/);
  assert.throws(() => handoffs.continuationPrompt(m.handoffId, () => null, false), /another project/);
  assert.equal(f.work.brief('q').actions.length, 0);

  // A mixed-project handoff already confirmed by an older app also stays non-actionable.
  f.store.updateHandoff(m.handoffId, { status: 'confirmed' });
  const agent = handoffForAgent(f.store, f.store.getHandoff(m.handoffId)!, () => null);
  assert.equal(agent.status, 'needs_review');
  assert.equal(agent.actionable, false);
  assert.deepEqual(agent.actions, []);
  assert.deepEqual(agent.completed_actions, []);
  assert.ok(handoffs.view(m.id)!.items.every((i) => i.progress === null));
  assert.throws(() => handoffs.continuationPrompt(m.handoffId, () => null, false), /another project/);
  assert.equal(f.work.brief('q').actions.length, 0, 'a partial mixed-project handoff is not presented as reviewed work');
  assert.equal(f.work.brief('q').reviewNeededCount, 1);
  assert.throws(() => f.update(freshId, { status: 'in_progress' }), code(409));

  handoffs.retarget(m.handoffId);
  assert.equal(handoffs.view(m.id)!.project_mismatch, false);
  assert.equal(f.store.getHandoff(m.handoffId)!.status, 'draft');
  handoffs.confirm(m.handoffId);
  const brief = f.work.brief('q');
  assert.equal(brief.actions.length, 2, 'explicit review retains both the old work and the new draft');
  assert.equal(brief.completedActions.length, 0);
  const moved = brief.actions.find((i) => i.id === oldId)!;
  assert.equal(moved.progress.status, 'not_started');
  assert.equal(moved.progress.note, '');
  assert.deepEqual(moved.progress.results, []);
  const prompt = handoffs.continuationPrompt(m.handoffId, () => null, false);
  assert.ok(prompt.includes(f.store.getHandoffItem(oldId)!.text));
  assert.ok(prompt.includes('Investigate turbine blade geometry'));
  assert.doesNotMatch(prompt, /Private progress|p-result/);
});

test('rejected old-project items do not block confirmed current-project work', (t) => {
  const f = setup(t);
  const m = f.meeting('rejected');
  f.store.assignSession(m.id, 'q');
  f.handoffs.updateItem(m.items[0], { review: 'rejected' });
  f.store.updateHandoff(m.handoffId, { project_id: 'q' });
  f.handoffs.addItem(m.handoffId, 'action', 'New Project Q work');
  assert.equal(f.handoffs.view(m.id)!.project_mismatch, false);
  f.handoffs.confirm(m.handoffId);
  const agent = handoffForAgent(f.store, f.store.getHandoff(m.handoffId)!, () => null);
  assert.deepEqual(agent.actions.map((i) => i.text), ['New Project Q work']);
  assert.match(f.handoffs.continuationPrompt(m.handoffId, () => null, false), /New Project Q work/);
});

test('reopening hides work until review and editing its text does not silently retain completion', (t) => {
  const f = setup(t), m = f.meeting('s'), id = m.items[0];
  const before = f.update(id, { status: 'completed', note: 'Old work is finished' });
  f.handoffs.reopen(m.handoffId);
  assert.equal(f.work.brief('p').completedActions.length, 0);
  assert.equal(handoffPublic(f.store, f.store.getHandoff(m.handoffId)!).items[0].progress, null);
  f.handoffs.confirm(m.handoffId);
  assert.equal(f.work.brief('p').completedActions[0].progress.status, 'completed');
  assert.throws(() => f.work.updateProgress(id, { expectedVersion: before.version, note: 'Old editor' }), code(409));
  const reviewedVersion = f.progress(id).version;
  f.store.addSegment({ session_id: m.id, t_start: 2000, t_end: 3000, text: 'Updated meeting evidence.', lang: 'en', source: 'mic', run: 1 });
  f.handoffs.confirm(m.handoffId);
  assert.throws(() => f.work.updateProgress(id, { expectedVersion: reviewedVersion, note: 'Editor before new review' }), code(409));
  f.handoffs.updateItem(id, { text: 'A substantially different follow-up task' });
  f.handoffs.confirm(m.handoffId);
  assert.equal(f.work.brief('p').actions[0].progress.status, 'not_started');
  assert.equal(f.work.brief('p').actions[0].progress.note, '');
});

test('deleting items, meetings or projects cascades work records and agendas', (t) => {
  const f = setup(t), a = f.meeting('a'), b = f.meeting('b');
  f.update(a.items[0], { note: 'Delete with item' });
  f.update(b.items[0], { note: 'Delete with meeting' });
  f.store.deleteHandoffItems(a.items);
  assert.equal(f.store.db.prepare('SELECT 1 FROM action_progress WHERE item_id = ?').get(a.items[0]), undefined);
  f.store.deleteSession(b.id);
  assert.equal(f.store.db.prepare('SELECT 1 FROM action_progress WHERE item_id = ?').get(b.items[0]), undefined);
  f.work.updateAgenda('p', { expectedVersion: 0, text: 'Delete with project' });
  f.store.db.prepare('DELETE FROM projects WHERE id = ?').run('p');
  assert.equal(f.store.db.prepare('SELECT 1 FROM project_agendas WHERE project_id = ?').get('p'), undefined);
  assert.throws(() => f.work.brief('p'), code(404));
});

test('brief retains old unfinished work, sorts status and recency, and reports bounded historical lists', (t) => {
  const f = setup(t);
  const old = f.meeting('old', 'p', 1), running = f.meeting('running', 'p', 2), blocked = f.meeting('blocked', 'p', 3);
  f.update(running.items[0], { status: 'in_progress' });
  f.update(blocked.items[0], { status: 'blocked' });
  for (let i = 0; i < 25; i++) {
    const m = f.meeting(`recent_${i}`, 'p', 100 + i, ['action', 'decision', 'question']);
    f.update(m.items[0], { status: 'completed' });
    f.store.db.prepare('UPDATE action_progress SET updated_at = ? WHERE item_id = ?').run(1000 + i, m.items[0]);
  }
  f.meeting('other_project', 'q', 9999);
  f.store.addSegment({ session_id: old.id, t_start: 2000, t_end: 3000, text: 'New evidence after review.', lang: 'en', source: 'mic', run: 1 });
  const brief = f.work.brief('p');
  assert.deepEqual(brief.actions.map((i) => i.id), [blocked.items[0], running.items[0], old.items[0]]);
  assert.equal(brief.actions[2].stale, true);
  assert.equal(brief.latestMeeting!.id, 'recent_24');
  assert.equal(brief.completedActions[0].id, 'recent_24_0');
  assert.equal(brief.decisions[0].id, 'recent_24_1');
  assert.equal(brief.questions[0].id, 'recent_24_2');
  assert.equal(brief.completedActions.length, 20);
  assert.deepEqual(brief.omitted, { completedActions: 5, decisions: 5, questions: 5 });
  assert.equal(brief.reviewNeededCount, 1);
  assert.ok(!JSON.stringify(brief).includes('other_project'));
});
