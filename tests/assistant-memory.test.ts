import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.ts';
import { Assistant } from '../server/ai/assistant.ts';
import { ProviderRegistry } from '../server/ai/registry.ts';
import type { CompletionRequest, CompletionResult } from '../server/ai/provider.ts';
import { digests, undigestedChunks } from '../server/ai/context.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(); }
  assert.ok(check(), 'asynchronous task did not settle');
}
const overview = (digest = 'The experiment is preliminary [0:40].') => JSON.stringify({ current_topic: 'Experiment', overview: ['Plan the experiment'], topics: [], open_question: '', digest });

function setup(t: TestContext) {
  const store = new Store(':memory:');
  const settings = store.getSettings();
  store.saveSettings({ ...settings, devMode: true, ai: { ...settings.ai, provider: 'mock' }, assist: { ...settings.assist, autoOverview: true, autoExplain: false } });
  store.createSession({ id: 'meeting', title: 'Experiment review', type: 'advisor', audio_source: 'both' });
  let wall = Date.now();
  t.mock.method(Date, 'now', () => ++wall);
  const registry = new ProviderRegistry(store);
  const requests: CompletionRequest[] = [];
  let respond = async (request: CompletionRequest): Promise<string> => request.task === 'overview' ? overview() : request.task === 'handoff' ? '{"decisions":[],"actions":[],"open_questions":[]}' : request.input;
  t.mock.method(registry.mock, 'complete', async (request: CompletionRequest): Promise<CompletionResult> => {
    requests.push(request);
    return { text: await respond(request), provider: 'mock', model: 'memory-test', billing: 'none' };
  });
  const assistant = new Assistant(store, registry, () => {});
  t.after(async () => { assistant.cancelSession('meeting'); await tick(); await registry.shutdown(); store.close(); });
  const add = (from: number, to: number, text: string, source = 'mic') => store.addSegment({ session_id: 'meeting', t_start: from, t_end: to, text, lang: 'en', source, run: 1 });
  const done = async (id: string) => { await until(() => ['done', 'error', 'cancelled'].includes(store.getOutput(id)!.status)); assert.equal(store.getOutput(id)!.status, 'done', store.getOutput(id)!.error ?? ''); };
  return { store, assistant, requests, add, done, advance: (ms: number) => { wall += ms; }, respond: (fn: typeof respond) => { respond = fn; } };
}

test('late mic lines remain uncovered and reach the next automatic overview, even inside the old time span', async (t) => {
  const { store, assistant, requests, add, done, advance, respond } = setup(t);
  const first = add(40_000, 105_000, 'The experiment is preliminary.', 'system');
  let finish!: (text: string) => void;
  respond(async (req) => req.task === 'overview' ? new Promise<string>((resolve) => { finish = resolve; }) : req.input);
  const id = assistant.overview('meeting');
  await until(() => requests.length === 1);
  const during = add(98_000, 103_000, 'I will rerun the barcode analysis by Friday. '.repeat(15));
  finish(overview());
  await done(id);
  const after = add(99_000, 104_000, 'I will send the results to Maya.');
  assert.deepEqual(digests(store, 'meeting')[0].segmentIds, [first.id]);
  assert.deepEqual(undigestedChunks(store, 'meeting', 105_000).flat().map((s) => s.id), [during.id, after.id]);
  advance(60_000);
  assistant.onActivity('meeting', 'pause');
  await until(() => requests.length === 2);
  assert.match(requests[1].input, /rerun the barcode analysis by Friday/);
  assert.match(requests[1].input, /send the results to Maya/);
  finish(overview('Rerun the barcode analysis by Friday and send the results to Maya [1:38].'));
  await done(store.latestOutput('meeting', 'overview', 'streaming')!.id);
  assert.equal(undigestedChunks(store, 'meeting', 105_000).length, 0);
  assert.equal(store.latestOutput('meeting', 'overview')!.covered_to, 105_000, 'late arrivals do not move the overview clock backward');
});

test('overview activity reads only newer IDs in a long meeting, including late lines in transcript order', async (t) => {
  const { store, assistant, requests, add, done, respond } = setup(t);
  for (let i = 0; i < 3000; i++) add(i * 1000, i * 1000 + 500, 'Already included discussion.');
  const lastSegmentId = store.maxSegmentId('meeting');
  store.insertOutput({ id: 'previous', session_id: 'meeting', kind: 'overview', status: 'done', content: 'Previous overview.', covered_from: 0, covered_to: 3_000_000, data_json: JSON.stringify({ ...JSON.parse(overview()), lastSegmentId }) });
  const later = add(20_000, 21_000, 'Late line at twenty seconds.');
  const earlier = add(5000, 6000, 'Late line at five seconds.');
  store.createSession({ id: 'other', title: 'Another meeting', type: 'advisor', audio_source: 'mic' });
  store.addSegment({ session_id: 'other', t_start: 0, t_end: 5000, text: 'Another meeting.', lang: 'en', source: 'mic', run: 1 });
  const prepare = t.mock.method(store.db, 'prepare');
  assert.deepEqual(store.segmentsAfterId('meeting', lastSegmentId).map((s) => s.id), [earlier.id, later.id]);
  const sql = prepare.mock.calls[0].arguments[0];
  prepare.mock.restore();
  const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('meeting', lastSegmentId);
  assert.ok(plan.some((row) => String(row.detail).includes('seg_session_id (session_id=? AND id>?)')), 'the lookup uses both parts of the ID index');
  const reads = t.mock.method(store, 'segments');
  let finish!: (text: string) => void;
  respond(async () => new Promise<string>((resolve) => { finish = resolve; }));
  assistant.onActivity('meeting', 'segment');
  const id = assistant.overview('meeting');
  await until(() => requests.length === 1);
  assert.equal(reads.mock.callCount(), 0, 'the activity trigger and overview build do not load the whole transcript');
  assert.match(requests[0].input, /Late line at five seconds[\s\S]*Late line at twenty seconds/);
  assert.doesNotMatch(requests[0].input, /Already included discussion|Another meeting/);
  finish(overview());
  await done(id);
});

for (const task of ['summary', 'handoff', 'catchup'] as const) {
  test(`${task} includes a late mic commitment through digests in a long meeting`, async (t) => {
    const { store, assistant, requests, add, done } = setup(t);
    add(40_000, 105_000, 'The experiment is preliminary.', 'system');
    await done(assistant.overview('meeting'));
    const late = add(98_000, 103_000, 'I will rerun the barcode analysis by Friday.');
    for (let i = 2; i < 85; i++) add(i * 60_000, i * 60_000 + 5000, `Discussion ${i}. ` + 'Evidence is preliminary. '.repeat(40));
    const id = task === 'summary' ? assistant.summary('meeting') : task === 'catchup' ? assistant.catchup('meeting', 'all') : assistant.handoffDraft('meeting', { onResult: () => {}, onFail: () => {} });
    await done(id);
    const final = requests.find((r) => r.task === (task === 'summary' ? 'final_summary' : task));
    assert.ok(final);
    assert.match(final.input, /rerun the barcode analysis by Friday/);
    assert.equal(digests(store, 'meeting').filter((d) => d.segmentIds.includes(late.id)).length, 1);
    assert.equal(undigestedChunks(store, 'meeting', 70 * 60_000).length, 0);
  });
}

test('oversized transcript lines are actually sent before being marked as digested', async (t) => {
  const { store, assistant, requests, add, done } = setup(t);
  const huge = add(1000, 5000, 'Important commitment. '.repeat(3200));
  add(900_000, 905_000, 'Closing remarks.');
  await done(assistant.summary('meeting'));
  assert.ok(requests.find((r) => r.task === 'digest')!.input.includes(huge.text));
  assert.equal(digests(store, 'meeting').length, 1);
  assert.equal(undigestedChunks(store, 'meeting', 10_000).length, 0);
});

test('legacy digests cover only lines in their time window that existed when they completed', async (t) => {
  const { store, add } = setup(t);
  const before = add(40_000, 105_000, 'Existing discussion.');
  const atCompletion = add(98_000, 103_000, 'An existing commitment.');
  const completedAt = store.segments('meeting').find((s) => s.id === atCompletion.id)!.created_at;
  const late = add(99_000, 104_000, 'A commitment that arrived later.');
  const outside = add(120_000, 125_000, 'A different part of the meeting.');
  store.insertOutput({ id: 'legacy', session_id: 'meeting', kind: 'digest', status: 'done', content: 'Saved notes.', covered_from: 40_000, covered_to: 105_000, completed_at: completedAt });
  assert.equal(digests(store, 'meeting').length, 1);
  assert.deepEqual(undigestedChunks(store, 'meeting', 130_000).flat().map((s) => s.id), [late.id, outside.id]);
  store.updateOutput('legacy', { stale_reason: 'speaker_labels_changed' });
  assert.deepEqual(undigestedChunks(store, 'meeting', 130_000).flat().map((s) => s.id), [before.id, atCompletion.id, late.id, outside.id]);
});

for (const task of ['summary', 'handoff', 'catchup'] as const) {
  test(`${task} reuses legacy digests in a saved long meeting and only digests later arrivals`, async (t) => {
    const { store, assistant, requests, add, done } = setup(t);
    for (let i = 0; i < 8; i++) add(i * 60_000, i * 60_000 + 5000, 'Saved discussion. '.repeat(600));
    add(30 * 60_000, 30 * 60_000 + 5000, 'Closing remarks.');
    store.insertOutput({ id: 'legacy', session_id: 'meeting', kind: 'digest', status: 'done', content: 'Saved notes on the experiment.', covered_from: 0, covered_to: 8 * 60_000, completed_at: Date.now() });
    const run = () => task === 'summary' ? assistant.summary('meeting') : task === 'catchup' ? assistant.catchup('meeting', 'all') : assistant.handoffDraft('meeting', { onResult: () => {}, onFail: () => {} });
    await done(run());
    assert.equal(requests.length, 1, 'saved digests need no provider rebuild');
    assert.match(requests[0].input, /Saved notes on the experiment/);
    add(98_000, 103_000, 'I will rerun the barcode analysis by Friday.');
    await done(run());
    const rebuilt = requests.filter((r) => r.task === 'digest');
    assert.equal(rebuilt.length, 1);
    assert.match(rebuilt[0].input, /rerun the barcode analysis by Friday/);
    assert.doesNotMatch(rebuilt[0].input, /Saved discussion/);
    assert.equal(undigestedChunks(store, 'meeting', 20 * 60_000).length, 0);
  });
}
