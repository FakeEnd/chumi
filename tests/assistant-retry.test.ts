import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.ts';
import { Assistant } from '../server/ai/assistant.ts';
import { ProviderRegistry } from '../server/ai/registry.ts';
import { ProviderError, type CompletionRequest, type CompletionResult } from '../server/ai/provider.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(); }
  assert.ok(check(), 'asynchronous task did not settle');
}
function setup(t: TestContext) {
  const store = new Store(':memory:');
  const settings = store.getSettings();
  store.saveSettings({ ...settings, devMode: true, ai: { ...settings.ai, provider: 'mock' }, screen: { ...settings.screen, sendImagesToAI: true } });
  store.createSession({ id: 'meeting', title: 'Experiment review', type: 'advisor', audio_source: 'mic' });
  store.addSegment({ session_id: 'meeting', t_start: 0, t_end: 5000, text: 'Discussing the slide.', lang: 'en', source: 'mic', run: 1 });
  const addFrame = (t: number) => store.addFrame({ session_id: 'meeting', t, path: `/tmp/slide-${t}.jpg`, width: null, height: null, kind: 'slide', window_title: null, app: null });
  const slide = addFrame(1000);
  const registry = new ProviderRegistry(store);
  const calls: Array<{ request: CompletionRequest; finish: () => void; fail: () => void }> = [];
  t.mock.method(registry.mock, 'complete', (request: CompletionRequest): Promise<CompletionResult> => new Promise((resolve, reject) => {
    calls.push({ request, finish: () => resolve({ text: 'The slide supports the hypothesis.', provider: 'mock', model: 'retry-test', billing: 'none', effort: null }), fail: () => reject(new ProviderError('network', 'Connection lost.')) });
  }));
  const assistant = new Assistant(store, registry, () => {});
  let snapshots = 0;
  assistant.visual = { framesFor: (id) => store.frames(id), snapshotNow: async () => { snapshots++; return null; } };
  const status = (id: string) => store.getOutput(id)!.status;
  const data = (id: string) => JSON.parse(store.getOutput(id)!.data_json!);
  t.after(async () => { assistant.cancelSession('meeting'); for (const call of calls) call.finish(); await tick(); await tick(); await registry.shutdown(); store.close(); });
  return { store, assistant, calls, slide, addFrame, status, data, snapshots: () => snapshots };
}

test('failed slide answers retain captures, effort, selection and project context through repeated retries', async (t) => {
  const { store, assistant, calls, slide, addFrame, status, data, snapshots } = setup(t);
  assistant.clock = () => 5000;
  let projectCalls = 0;
  assistant.projectContext = async () => { projectCalls++; return { text: 'Earlier project context.', meta: {} }; };
  const selection = { fromT: 0, toT: 5000, text: 'Discussing the slide.' };
  const original = assistant.ask('meeting', 'Explain this slide.', selection, 'deep', [slide.id], 'high', { projectContext: true });
  assert.deepEqual(data(original).frameIds, [slide.id], 'captures are saved before build starts');
  assert.equal(data(original).requestedEffort, 'high');
  await until(() => calls.length === 1);
  calls[0].fail();
  await until(() => status(original) === 'error');
  assert.deepEqual(data(original).images, [{ id: slide.id, t: slide.t }]);
  assert.equal(data(original).askedT, 5000);
  assert.equal(data(original).errorKind, 'network');
  addFrame(10_000);
  const settings = store.getSettings();
  store.saveSettings({ ...settings, ai: { ...settings.ai, effort: 'low' } });
  const retry = assistant.refresh(original)!;
  assert.equal(assistant.refresh(original), retry, 'double-clicking retry reuses its active replacement');
  await until(() => calls.length === 2);
  assert.equal(store.getOutput(retry)!.parent_id, original);
  assert.equal(store.getOutput(retry)!.selection_json, JSON.stringify(selection));
  assert.equal(store.getOutput(retry)!.scope, 'project');
  assert.equal(store.getOutput(retry)!.depth, 'deep');
  assert.deepEqual(calls[1].request.images, calls[0].request.images);
  assert.equal(calls[1].request.effort, 'high');
  calls[1].fail();
  await until(() => status(retry) === 'error');
  const second = assistant.refresh(retry)!;
  await until(() => calls.length === 3);
  assert.equal(store.getOutput(second)!.parent_id, retry);
  assert.deepEqual(calls[2].request.images, calls[0].request.images);
  calls[2].finish();
  await until(() => status(second) === 'done');
  assert.equal(projectCalls, 3);
  assert.equal(snapshots(), 0, 'an explicit slide retry never captures the current screen');
  assert.equal(data(second).effort, null, 'provider-reported effort remains distinct from the saved request');
  assert.equal(data(second).requestedEffort, 'high');
});

test('retry reuses automatically picked images instead of newer slides', async (t) => {
  const { assistant, calls, slide, addFrame, status, snapshots } = setup(t);
  const original = assistant.ask('meeting', 'What does the slide show?', null, 'standard', [], 'medium');
  await until(() => calls.length === 1);
  calls[0].fail();
  await until(() => status(original) === 'error');
  addFrame(10_000); addFrame(20_000);
  const retry = assistant.refresh(original)!;
  await until(() => calls.length === 2);
  assert.equal(snapshots(), 1);
  assert.deepEqual(calls[1].request.images?.map((i) => i.path), [slide.path]);
  calls[1].finish();
  await until(() => status(retry) === 'done');
});

test('answers cancelled before building still retain their selected slide and effort for retry', async (t) => {
  const { assistant, calls, slide, status, data } = setup(t);
  const first = assistant.ask('meeting', 'Busy one', null, 'standard');
  const second = assistant.ask('meeting', 'Busy two', null, 'standard');
  await until(() => calls.length === 2);
  const queued = assistant.ask('meeting', 'This slide?', null, 'quick', [slide.id], 'high');
  assistant.cancel(queued);
  assert.equal(status(queued), 'cancelled');
  assert.deepEqual(data(queued).frameIds, [slide.id]);
  calls[0].finish(); calls[1].finish();
  await until(() => status(first) === 'done' && status(second) === 'done' && !assistant.cancel(queued));
  assert.equal(calls.length, 2);
  const retry = assistant.refresh(queued)!;
  await until(() => calls.length === 3);
  assert.equal(calls[2].request.effort, 'high');
  assert.deepEqual(calls[2].request.images?.map((i) => i.path), [slide.path]);
  calls[2].finish();
  await until(() => status(retry) === 'done');
});

test('refresh of older successful answers reuses saved images and effort and links the replacement', async (t) => {
  const { store, assistant, calls, slide, addFrame, status } = setup(t);
  addFrame(20_000);
  store.insertOutput({ id: 'legacy', session_id: 'meeting', kind: 'answer', status: 'done', question: 'This slide?', depth: 'standard', content: 'Old answer.', stale_reason: 'speaker_labels_changed', data_json: JSON.stringify({ images: [{ id: slide.id, t: slide.t }], effort: 'high' }) });
  const retry = assistant.refresh('legacy')!;
  await until(() => calls.length === 1);
  assert.equal(store.getOutput(retry)!.parent_id, 'legacy');
  assert.equal(calls[0].request.effort, 'high');
  assert.deepEqual(calls[0].request.images?.map((i) => i.path), [slide.path]);
  calls[0].finish();
  await until(() => status(retry) === 'done');
});
