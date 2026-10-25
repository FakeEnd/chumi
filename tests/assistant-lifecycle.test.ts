import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type OutputRow } from '../server/db.ts';
import { Assistant } from '../server/ai/assistant.ts';
import { ProviderRegistry } from '../server/ai/registry.ts';
import type { CompletionRequest, CompletionResult } from '../server/ai/provider.ts';
import { HandoffService } from '../server/projects/handoff.ts';
import type { HandoffSource } from '../server/projects/handoff-model.ts';

const draft = (text = 'Implement the agreed experiment') => ({ decisions: [], actions: [{ text, origin: 'agreed', evidence: ['0:00'] }], open_questions: [] });
const overview = JSON.stringify({ current_topic: 'Experiment', overview: ['Plan the experiment'], topics: [], open_question: '' });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  assert.ok(check(), 'asynchronous task did not settle');
}

function setup(t: TestContext) {
  const store = new Store(':memory:');
  const settings = store.getSettings();
  store.saveSettings({ ...settings, devMode: true, ai: { ...settings.ai, provider: 'mock' }, assist: { ...settings.assist, autoOverview: true, autoExplain: false } });
  store.createProject({ id: 'a', name: 'Project A', workspace: '/tmp/project-a' });
  store.createProject({ id: 'b', name: 'Project B', workspace: '/tmp/project-b' });
  store.createSession({ id: 'meeting', title: 'Experiment review', type: 'advisor', audio_source: 'mic' });
  store.assignSession('meeting', 'a');
  store.addSegment({ session_id: 'meeting', t_start: 0, t_end: 3000, text: 'We agreed to implement the experiment. '.repeat(20), lang: 'en', source: 'mic', run: 1 });
  const registry = new ProviderRegistry(store);
  const calls: Array<{ request: CompletionRequest; finish: (text?: string) => void }> = [];
  t.mock.method(registry.mock, 'complete', (request: CompletionRequest): Promise<CompletionResult> => new Promise((resolve) => {
    calls.push({ request, finish: (text = 'Answer [0:00].') => resolve({ text, provider: 'mock', model: 'lifecycle-test', billing: 'none' }) });
  }));
  const assistant = new Assistant(store, registry, () => {});
  const handoffs = new HandoffService(store, assistant, () => {});
  t.after(async () => {
    for (const output of store.outputs('meeting')) assistant.cancel(output.id);
    for (const call of calls) call.finish();
    await tick(); await tick();
    await registry.shutdown();
    store.close();
  });
  const occupy = async () => {
    assistant.ask('meeting', 'First question?', null, 'standard');
    assistant.ask('meeting', 'Second question?', null, 'standard');
    await until(() => calls.length === 2);
  };
  return { store, assistant, calls, handoffs, occupy };
}

test('an overview that settles cannot mark another one, still running, as finished', { timeout: 3000 }, async (t) => {
  const { store, assistant, calls, occupy } = setup(t);
  let wall = Date.now();
  t.mock.method(Date, 'now', () => wall);
  await occupy();
  const cancelled = assistant.overview('meeting');
  const replacement = assistant.overview('meeting', true);
  assert.equal(assistant.cancel(cancelled), true);
  assert.equal(store.getOutput(cancelled)!.status, 'cancelled');
  assert.ok(store.getOutput(cancelled)!.completed_at);
  // Both slots free up: the cancelled overview settles there, the replacement starts.
  calls[0].finish(); calls[1].finish();
  await until(() => calls.length === 3);
  await tick(); await tick();
  assert.equal(calls[2].request.task, 'overview', 'the cancelled request never reached the provider');
  wall += 60_000;
  assistant.onActivity('meeting', 'segment');
  assert.equal(store.outputs('meeting', ['overview']).length, 2, 'no automatic overview while the replacement is still running');
  calls[2].finish(overview);
  await until(() => store.getOutput(replacement)?.status === 'done');
});

test('a provider result arriving after cancellation cannot publish handoff items', { timeout: 3000 }, async (t) => {
  const { store, assistant, calls, handoffs } = setup(t);
  const handoff = handoffs.generate('meeting');
  await until(() => calls.length === 1);
  assistant.cancel(handoff.output_id!);
  calls[0].finish(JSON.stringify(draft('Late result must not be published')));
  await until(() => store.getOutput(handoff.output_id!)!.status === 'cancelled');
  assert.equal(handoffs.view('meeting')!.status, 'error');
  assert.equal(store.handoffItems(handoff.id).length, 0);
});

test('handoff freshness and evidence retain the input revision, project and segment boundary', { timeout: 3000 }, async (t) => {
  const { store, calls, handoffs } = setup(t);
  let wall = Date.now();
  t.mock.method(Date, 'now', () => wall);
  const revision = store.getSession('meeting')!.revision;
  const segmentMax = store.maxSegmentId('meeting');
  const handoff = handoffs.generate('meeting');
  await until(() => calls.length === 1);
  assert.match(calls[0].request.instructions, /Project A/);
  wall += 1000;
  const added = store.addSegment({ session_id: 'meeting', t_start: 2000, t_end: 4000, text: 'Cancel the earlier experiment.', lang: 'en', source: 'mic', run: 1 });
  store.addFrame({ session_id: 'meeting', t: 4000, path: '/not-read.jpg', width: null, height: null, kind: 'slide', window_title: null, app: null });
  store.addTimeline('meeting', 4000, 'resume');
  store.assignSession('meeting', 'b');
  assert.throws(() => handoffs.retarget(handoff.id), /Wait for the draft/);
  wall += 1000;
  calls[0].finish(JSON.stringify(draft()));
  await until(() => handoffs.view('meeting')!.status === 'draft');
  const view = handoffs.view('meeting')!;
  assert.equal(view.source_revision, revision);
  assert.equal(view.confirmed_segment_max, segmentMax);
  assert.equal(view.project_id, 'a');
  assert.equal(view.project_mismatch, true);
  assert.equal(view.freshness.stale, true);
  assert.equal(view.freshness.detail.new_transcript_lines, 1);
  assert.equal(view.freshness.detail.new_frames, 1);
  assert.equal(view.freshness.detail.resumed, true);
  assert.equal(view.freshness.detail.reassigned, true);
  const item = store.handoffItems(handoff.id)[0];
  assert.equal(item.project_id, 'a');
  assert.ok(!JSON.parse(item.evidence_json)[0].segment_ids.includes(added.id), 'a late nearby transcript line was never part of the cited input');
  const savedSource = JSON.parse(store.getOutput(handoff.output_id!)!.data_json!).handoffSource;
  assert.equal(savedSource.revision, revision);
  assert.equal(savedSource.capturedAt, wall - 2000);
});

test('a queued handoff captures the project and transcript when it actually starts', { timeout: 3000 }, async (t) => {
  const { store, calls, handoffs, occupy } = setup(t);
  await occupy();
  handoffs.generate('meeting');
  store.assignSession('meeting', 'b');
  store.addSegment({ session_id: 'meeting', t_start: 10_000, t_end: 13_000, text: 'The new input before generation starts.', lang: 'en', source: 'mic', run: 1 });
  const segmentMax = store.maxSegmentId('meeting');
  calls[0].finish();
  await until(() => calls.length === 3);
  assert.match(calls[2].request.instructions, /Project B/);
  assert.match(calls[2].request.input, /new input before generation starts/);
  calls[2].finish(JSON.stringify(draft()));
  await until(() => handoffs.view('meeting')!.status === 'draft');
  const view = handoffs.view('meeting')!;
  assert.equal(view.project_id, 'b');
  assert.equal(view.confirmed_segment_max, segmentMax);
  assert.equal(view.freshness.stale, false);
});

test('superseded draft callbacks cannot overwrite a newer generation', () => {
  const store = new Store(':memory:');
  try {
    store.createSession({ id: 'meeting', title: 'Review', type: 'advisor', audio_source: 'mic' });
    store.addSegment({ session_id: 'meeting', t_start: 0, t_end: 3000, text: 'Agreed action', lang: 'en', source: 'mic', run: 1 });
    const source: HandoffSource = { revision: store.getSession('meeting')!.revision, segmentMax: store.maxSegmentId('meeting'), projectId: null, capturedAt: Date.now() };
    const callbacks: Array<Parameters<Assistant['handoffDraft']>[1]> = [];
    const fake = { handoffDraft: (_sid: string, callback: Parameters<Assistant['handoffDraft']>[1]) => { callbacks.push(callback); return `output-${callbacks.length}`; } };
    const handoffs = new HandoffService(store, fake as Assistant, () => {});
    const first = handoffs.generate('meeting');
    callbacks[0].onFail({ error: 'Cancelled.' } as OutputRow);
    const second = handoffs.generate('meeting');
    callbacks[0].onResult({} as OutputRow, draft('Old draft'), [], source);
    callbacks[0].onFail({ error: 'Old failure' } as OutputRow);
    assert.equal(store.getHandoff(first.id)!.status, 'generating');
    assert.equal(store.getHandoff(first.id)!.output_id, second.output_id);
    assert.equal(store.handoffItems(first.id).length, 0);
    callbacks[1].onResult({} as OutputRow, draft('Current draft'), [], source);
    assert.equal(store.handoffItems(first.id)[0].text, 'Current draft');
    assert.equal(store.getHandoff(first.id)!.status, 'draft');
  } finally { store.close(); }
});
