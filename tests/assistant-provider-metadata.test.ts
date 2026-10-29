import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type OutputRow } from '../server/db.ts';
import { Assistant } from '../server/ai/assistant.ts';
import { ProviderRegistry } from '../server/ai/registry.ts';
import type { CompletionRequest, CompletionResult } from '../server/ai/provider.ts';

const cases: Array<{ name: string; metadata: Pick<CompletionResult, 'effort'>; expected: string | null }> = [
  { name: 'explicit null effort overrides the requested effort', metadata: { effort: null }, expected: null },
  { name: 'omitted effort preserves the legacy requested-effort fallback', metadata: {}, expected: 'high' },
];

for (const { name, metadata, expected } of cases) {
  test(`Assistant.ask: ${name}`, { timeout: 3000 }, async (t) => {
    const store = new Store(':memory:');
    const settings = store.getSettings();
    store.saveSettings({ ...settings, devMode: true, ai: { ...settings.ai, provider: 'mock' } });
    const registry = new ProviderRegistry(store);
    const assistant = new Assistant(store, registry, () => {});
    let outputId: string | undefined;
    t.after(async () => {
      if (outputId) assistant.cancel(outputId);
      await registry.shutdown();
      store.close();
    });

    const transcript = 'We agreed to rerun the experiment with the chromosome holdout.';
    const session = store.createSession({ id: 'metadata-test', title: 'Experiment review', type: 'advisor', audio_source: 'mic' });
    store.addSegment({ session_id: session.id, t_start: 1000, t_end: 5000, text: transcript, lang: 'en', source: 'mic', run: 1 });
    const requests: CompletionRequest[] = [];
    t.mock.method(registry.mock, 'complete', async (request: CompletionRequest): Promise<CompletionResult> => {
      requests.push(request);
      return { text: 'Rerun the experiment with the chromosome holdout [0:01].', provider: 'mock', model: 'metadata-test', billing: 'none', ...metadata };
    });
    const completed = new Promise<OutputRow>((resolve) => { assistant.onOutputDone = resolve; });

    outputId = assistant.ask(session.id, 'What did we agree to rerun?', null, 'standard', [], 'high');
    await completed;

    assert.equal(requests.length, 1);
    assert.equal(requests[0].effort, 'high');
    assert.ok(requests[0].input.includes(transcript), 'the request must use the inserted transcript');
    const saved = store.getOutput(outputId);
    assert.ok(saved);
    assert.equal(saved.status, 'done');
    assert.equal(saved.provider, 'mock');
    assert.equal(JSON.parse(saved.data_json!).effort, expected);
  });
}

test('a manual question preempts local background work even when both assistant slots are occupied', { timeout: 3000 }, async (t) => {
  const { CompatibleProvider } = await import('../server/ai/compatible.ts');
  const store = new Store(':memory:');
  const settings = store.getSettings();
  settings.ai.provider = 'compatible'; settings.ai.compatible.preset = 'lmstudio';
  Object.assign(settings.ai.compatible.profiles.lmstudio, { model: 'fixture', contextTokens: 32768 });
  store.saveSettings(settings);
  const registry = new ProviderRegistry(store);
  let started!: () => void;
  const entered = new Promise<void>((r) => { started = r; });
  let calls = 0;
  const provider = new CompatibleProvider(() => settings.ai.compatible, { readKey: async () => null, fetch: async () => {
    calls++;
    if (calls === 1) { started(); return new Promise<Response>(() => {}); }
    return Response.json({ choices: [{ message: { content: 'The answer [0:01].' }, finish_reason: 'stop' }] });
  } });
  registry.providers.compatible = provider;
  const assistant = new Assistant(store, registry, () => {});
  const session = store.createSession({ id: 'local-priority', title: 'Fixture', type: 'advisor', audio_source: 'mic' });
  store.addSegment({ session_id: session.id, t_start: 1000, t_end: 5000, text: 'The team agreed to repeat the experiment. '.repeat(2500), lang: 'en', source: 'mic', run: 1 });
  t.after(async () => { assistant.cancelSession(session.id); await registry.shutdown(); store.close(); });
  store.insertOutput({ id: 'previous-overview', session_id: session.id, kind: 'overview', status: 'done', content: 'Previous overview.', data_json: JSON.stringify({ current_topic: 'Previous topic', overview: ['Previous overview.'], topics: [], open_question: '', lastSegmentId: 0 }) });
  const first = assistant.overview(session.id);
  await entered;
  const second = assistant.overview(session.id);
  await new Promise<void>((r) => setImmediate(r));
  const done = new Promise<OutputRow>((r) => { assistant.onOutputDone = r; });
  const id = assistant.ask(session.id, 'What did we agree?', null, 'standard');
  assert.equal((await done).id, id);
  assert.equal(calls, 2, 'only the first background request and the manual answer reach the server');
  assert.equal(store.getOutput(first)!.status, 'cancelled');
  assert.equal(store.getOutput(second)!.status, 'cancelled');
  assert.equal(store.latestOutput(session.id, 'overview')!.id, 'previous-overview');
});
