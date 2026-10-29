import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.ts';
import { Assistant } from '../server/ai/assistant.ts';
import { ProviderRegistry } from '../server/ai/registry.ts';
import { ProviderError, type CompletionRequest, type CompletionResult } from '../server/ai/provider.ts';
import { digests, undigestedChunks } from '../server/ai/context.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(); }
  assert.ok(check(), 'asynchronous task did not settle');
}
function setup(t: TestContext) {
  const store = new Store(':memory:');
  const settings = store.getSettings();
  store.saveSettings({ ...settings, devMode: true, ai: { ...settings.ai, provider: 'mock' } });
  store.createSession({ id: 'meeting', title: 'Experiment review', type: 'advisor', audio_source: 'mic' });
  for (let i = 0; i < 8; i++) store.addSegment({ session_id: 'meeting', t_start: i * 60_000, t_end: i * 60_000 + 5000, text: `Topic ${i}. ` + 'Evidence. '.repeat(900), lang: 'en', source: 'mic', run: 1 });
  store.addSegment({ session_id: 'meeting', t_start: 30 * 60_000, t_end: 30 * 60_000 + 5000, text: 'Closing remarks.', lang: 'en', source: 'mic', run: 1 });
  const registry = new ProviderRegistry(store);
  const calls: Array<{ request: CompletionRequest; finish: () => void; fail: () => void }> = [];
  t.mock.method(registry.mock, 'complete', (request: CompletionRequest): Promise<CompletionResult> => new Promise((resolve, reject) => {
    calls.push({ request, finish: () => resolve({ text: request.task === 'handoff' ? '{"decisions":[],"actions":[],"open_questions":[]}' : 'Evidence remains preliminary.', provider: 'mock', model: 'digest-test', billing: 'none' }), fail: () => reject(new ProviderError('network', 'Connection lost.')) });
  }));
  const events: any[] = [];
  const assistant = new Assistant(store, registry, (event, data) => { if (event === 'ai') events.push(data); });
  const handoff = () => assistant.handoffDraft('meeting', { onResult: () => {}, onFail: () => {} });
  const status = (id: string) => store.getOutput(id)!.status;
  const finish = async (ids: string[]) => {
    for (let i = 0; i < 100 && ids.some((id) => ['pending', 'streaming'].includes(status(id))); i++) {
      for (const call of calls) call.finish();
      await tick();
    }
    for (const id of ids) assert.equal(status(id), 'done', store.getOutput(id)!.error ?? '');
  };
  t.after(async () => { assistant.cancelSession('meeting'); for (const call of calls) call.finish(); await tick(); await tick(); await registry.shutdown(); store.close(); });
  return { store, assistant, calls, events, handoff, status, finish };
}

test('overlapping summary and handoff share one sequential digest rebuild and both receive progress', async (t) => {
  const { store, assistant, calls, events, handoff, finish } = setup(t);
  const count = undigestedChunks(store, 'meeting', 20 * 60_000).length;
  const summary = assistant.summary('meeting');
  const draft = handoff();
  await until(() => calls.length > 0);
  assert.equal(calls.length, 1, 'only one digest may run at a time');
  await finish([summary, draft]);
  assert.equal(calls.filter((c) => c.request.task === 'digest').length, count);
  const covered = digests(store, 'meeting').flatMap((d) => d.segmentIds);
  assert.equal(new Set(covered).size, covered.length, 'each transcript line has one digest');
  for (const id of [summary, draft]) {
    const progress = events.filter((e) => e.id === id && e.data?.progress).map((e) => e.data.progress.completed);
    assert.deepEqual(progress, Array.from({ length: count + 1 }, (_, i) => i));
    assert.equal(JSON.parse(store.getOutput(id)!.data_json!).progress, undefined);
  }
});

test('a handoff started after a speaker rename rebuilds with the new labels instead of joining the old job', async (t) => {
  const { store, assistant, calls, events, handoff, status, finish } = setup(t);
  store.setSpeakerAnalysis('meeting', { status: 'running', generation: 'first', error: null, updated_at: Date.now() });
  store.applySpeakerTurns('meeting', 'first', [{ source: 'mic', speaker: '0', start_ms: 0, end_ms: 500_000 }], [{ source: 'mic', start_ms: 0, end_ms: 500_000 }]);
  const summary = assistant.summary('meeting');
  await until(() => calls.length === 1);
  store.renameSpeaker('meeting', store.speakers('meeting')[0].id, 'Maya');
  const draft = handoff();
  await until(() => calls.length === 2);
  assert.match(calls[1].request.input, /Maya/);
  assert.doesNotMatch(calls[0].request.input, /Maya/);
  calls[0].finish();
  await until(() => status(summary) === 'error');
  assert.equal(store.getOutput(summary)!.error, 'Speaker labels changed. Regenerate the response to use the updated names.');
  assert.equal(digests(store, 'meeting').length, 0, 'the old-label result is discarded');
  const catchup = assistant.catchup('meeting', 'all');
  await until(() => events.some((e) => e.id === catchup && e.data?.progress));
  assert.equal(calls.length, 2, 'settling the old job must not remove the current job from the map');
  await finish([draft, catchup]);
  assert.ok(calls.filter((c) => c.request.task === 'digest').slice(1).every((c) => c.request.input.includes('Maya')));
  const covered = digests(store, 'meeting').flatMap((d) => d.segmentIds);
  assert.equal(new Set(covered).size, covered.length);
});

test('cancelling one caller leaves the shared digest rebuild running for the other', async (t) => {
  const { assistant, calls, handoff, status, finish } = setup(t);
  const summary = assistant.summary('meeting');
  const draft = handoff();
  await until(() => calls.length === 1);
  assistant.cancel(summary);
  await until(() => status(summary) === 'cancelled');
  assert.equal(calls[0].request.signal!.aborted, false);
  await finish([draft]);
});

test('cancelling every caller discards a late digest result and a subsequent request can rebuild', async (t) => {
  const { store, assistant, calls, handoff, status, finish } = setup(t);
  const summary = assistant.summary('meeting');
  const draft = handoff();
  await until(() => calls.length === 1);
  assistant.cancel(summary); assistant.cancel(draft);
  await until(() => status(summary) === 'cancelled' && status(draft) === 'cancelled');
  assert.equal(calls[0].request.signal!.aborted, true);
  const retry = assistant.summary('meeting');
  calls[0].finish();
  await until(() => calls.length === 2);
  assert.equal(digests(store, 'meeting').length, 0);
  await finish([retry]);
});

test('a shared failure reaches both callers and retry reuses already completed chunks', async (t) => {
  const { store, assistant, calls, handoff, status, finish } = setup(t);
  const count = undigestedChunks(store, 'meeting', 20 * 60_000).length;
  const summary = assistant.summary('meeting');
  const draft = handoff();
  await until(() => calls.length === 1);
  calls[0].finish();
  await until(() => calls.length === 2);
  calls[1].fail();
  await until(() => status(summary) === 'error' && status(draft) === 'error');
  assert.equal(digests(store, 'meeting').length, 1);
  const retry = assistant.summary('meeting');
  await finish([retry]);
  assert.equal(calls.filter((c) => c.request.task === 'digest').length, count + 1, 'only the failed chunk is repeated');
});

test('a waiting caller with a later cutoff also digests the newly eligible earlier transcript', async (t) => {
  const { store, assistant, calls, handoff, finish } = setup(t);
  const summary = assistant.summary('meeting');
  await until(() => calls.length === 1);
  const added = store.addSegment({ session_id: 'meeting', t_start: 22 * 60_000, t_end: 22 * 60_000 + 5000, text: 'Newly eligible commitment.', lang: 'en', source: 'mic', run: 1 });
  store.addSegment({ session_id: 'meeting', t_start: 40 * 60_000, t_end: 40 * 60_000 + 5000, text: 'Later closing remarks.', lang: 'en', source: 'mic', run: 1 });
  const draft = handoff();
  await finish([summary, draft]);
  assert.equal(digests(store, 'meeting').filter((d) => d.segmentIds.includes(added.id)).length, 1);
  assert.equal(undigestedChunks(store, 'meeting', 30 * 60_000).length, 0);
});

test('a manual caller promotes the shared background digest, including its running request', async (t) => {
  const { assistant, calls, handoff, status, finish } = setup(t);
  const background = assistant.overview('meeting');
  await until(() => calls.length === 1);
  assert.equal(calls[0].request.task, 'digest');
  assert.equal(calls[0].request.priority, 2);
  const draft = handoff();
  assert.equal(calls[0].request.priority, 10, 'promotion happens before local preemption');
  assistant.cancel(background);
  await until(() => status(background) === 'cancelled');
  await finish([draft]);
  assert.ok(calls.filter((c) => c.request.task === 'digest').every((c) => c.request.priority === 10));
});
