import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../server/db.ts';
import { Assistant } from '../server/ai/assistant.ts';
import { ProviderRegistry } from '../server/ai/registry.ts';
import { ProviderError, type CompletionRequest, type CompletionResult } from '../server/ai/provider.ts';
import { HandoffService } from '../server/projects/handoff.ts';

/**
 * A provider whose requests wait until released (or cancelled), so the two queue slots can be held busy
 * while later jobs wait in the queue.
 */
function setup(t: TestContext) {
  const store = new Store(':memory:');
  const settings = store.getSettings();
  store.saveSettings({ ...settings, devMode: true, ai: { ...settings.ai, provider: 'mock' } });
  const registry = new ProviderRegistry(store);
  const assistant = new Assistant(store, registry, () => {});
  const calls: CompletionRequest[] = [];
  const waiting: Array<() => void> = [];
  t.mock.method(registry.mock, 'complete', (req: CompletionRequest) => new Promise<CompletionResult>((resolve, reject) => {
    calls.push(req);
    const abort = () => reject(new ProviderError('aborted', 'Request cancelled.'));
    if (req.signal?.aborted) return abort();
    req.signal?.addEventListener('abort', abort, { once: true });
    waiting.push(() => resolve({ text: '{"current_topic":"t","overview":["a"],"topics":[],"open_question":""}', provider: 'mock', model: 'test', billing: 'none' }));
  }));
  const release = () => { for (const r of waiting.splice(0)) r(); };
  t.after(async () => { release(); await registry.shutdown(); store.close(); });
  const meeting = (id: string) => {
    store.createSession({ id, title: `Meeting ${id}`, type: 'advisor', audio_source: 'mic' });
    store.addSegment({ session_id: id, t_start: 0, t_end: 4000, text: 'We agreed to rerun the experiment with the chromosome holdout.', lang: 'en', source: 'mic', run: 1 });
  };
  return { store, registry, assistant, calls, release, meeting };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(5);
  }
}

test('a recap cancelled while queued settles and no longer blocks automatic overviews', { timeout: 5000 }, async (t) => {
  const { store, assistant, calls, release, meeting } = setup(t);
  meeting('s_busy'); meeting('s_recap');
  assistant.ask('s_busy', 'one?', null, 'standard');
  assistant.ask('s_busy', 'two?', null, 'standard');
  await until(() => calls.length === 2); // Both queue slots are taken.

  const recap = assistant.overview('s_recap', true);
  assert.equal(assistant.cancel(recap), true);
  assert.equal(store.getOutput(recap)!.status, 'cancelled');
  release();
  const inflight = (assistant as unknown as { overviewInflight: Set<string> }).overviewInflight;
  await until(() => !inflight.has('s_recap'));
  assert.equal(calls.length, 2, 'the cancelled recap never reached the provider');
  assert.equal(store.getOutput(recap)!.status, 'cancelled');
  assert.equal(assistant.cancel(recap), false, 'its controller is released');
});

test('a handoff draft cancelled while queued leaves the handoff retryable', { timeout: 5000 }, async (t) => {
  const { store, assistant, calls, release, meeting } = setup(t);
  meeting('s_busy'); meeting('s_handoff');
  assistant.ask('s_busy', 'one?', null, 'standard');
  assistant.ask('s_busy', 'two?', null, 'standard');
  await until(() => calls.length === 2);

  const handoffs = new HandoffService(store, assistant, () => {});
  const h = handoffs.generate('s_handoff');
  assert.equal(h.status, 'generating');
  assistant.cancel(h.output_id!);
  release();
  await until(() => store.getHandoff(h.id)!.status !== 'generating');
  assert.equal(store.getHandoff(h.id)!.status, 'error');
  assert.equal(calls.length, 2);
});

test('deleting a meeting stops its running and queued AI work', { timeout: 5000 }, async (t) => {
  const { store, assistant, calls, release, meeting } = setup(t);
  meeting('s_gone'); meeting('s_other');
  const running = assistant.ask('s_gone', 'one?', null, 'standard');
  assistant.ask('s_other', 'two?', null, 'standard');
  await until(() => calls.length === 2);
  assistant.summary('s_gone'); // Queued behind both.
  const recap = assistant.overview('s_gone', true);

  assistant.cancelSession('s_gone');
  assert.equal(calls[0].signal?.aborted, true, 'the running request is aborted');
  assert.equal(calls[1].signal?.aborted, false, 'other meetings are untouched');
  await until(() => store.getOutput(running)!.status === 'cancelled');
  store.deleteSession('s_gone');
  release();
  const inflight = (assistant as unknown as { overviewInflight: Set<string> }).overviewInflight;
  await until(() => !inflight.has('s_gone'));
  assert.equal(assistant.cancel(recap), false, 'the queued recap settled');
  assert.equal(calls.length, 2, 'queued work for the deleted meeting never reached the provider');
});

test('a speaker rename during digest generation keeps the explanation and allows a retry', { timeout: 5000 }, async (t) => {
  const { store, assistant, calls, release, meeting } = setup(t);
  meeting('s_long');
  store.addSegment({ session_id: 's_long', t_start: 5000, t_end: 10_000, text: 'Discussion. '.repeat(6000), lang: 'en', source: 'mic', run: 1 });
  store.addSegment({ session_id: 's_long', t_start: 900_000, t_end: 904_000, text: 'Closing remarks.', lang: 'en', source: 'mic', run: 1 });
  store.setSpeakerAnalysis('s_long', { status: 'running', generation: 'first', error: null, updated_at: Date.now() });
  store.applySpeakerTurns('s_long', 'first', [{ source: 'mic', speaker: '0', start_ms: 0, end_ms: 10_000 }], [{ source: 'mic', start_ms: 0, end_ms: 10_000 }]);

  const summary = assistant.summary('s_long');
  await until(() => calls.length === 1);
  assert.equal(calls[0].task, 'digest');
  store.renameSpeaker('s_long', store.speakers('s_long')[0].id, 'Maya');
  release();
  await until(() => store.getOutput(summary)!.status !== 'streaming');
  const failed = store.getOutput(summary)!;
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'Speaker labels changed. Regenerate the response to use the updated names.');
  assert.equal(JSON.parse(failed.data_json!).errorKind, 'aborted');
  assert.equal(failed.stale_reason, 'speaker_labels_changed');
  assert.equal(store.outputs('s_long', ['digest']).length, 0, 'the old-label digest is not saved');

  const retry = assistant.refresh(summary);
  assert.ok(retry);
  await until(() => calls.length === 2);
  assert.match(calls[1].input, /Maya/);
  while (store.getOutput(retry)!.status === 'streaming' || store.getOutput(retry)!.status === 'pending') { release(); await sleep(5); }
  assert.equal(store.getOutput(retry)!.status, 'done');
});

test('a user-cancelled summary retains the cancelled status and message', { timeout: 5000 }, async (t) => {
  const { store, assistant, calls, meeting } = setup(t);
  meeting('s_cancel');
  const id = assistant.summary('s_cancel');
  await until(() => calls.length === 1);
  assert.equal(assistant.cancel(id), true);
  await until(() => store.getOutput(id)!.status === 'cancelled');
  assert.equal(store.getOutput(id)!.error, 'Cancelled.');
  assert.equal(JSON.parse(store.getOutput(id)!.data_json!).errorKind, 'aborted');
});

test('an unsolicited provider abort is an error, not a cancellation', { timeout: 5000 }, async (t) => {
  const { store, registry, assistant, meeting } = setup(t);
  meeting('s_abort');
  t.mock.method(registry, 'complete', async () => { throw new ProviderError('aborted', 'Provider stopped unexpectedly.'); });
  const id = assistant.summary('s_abort');
  await until(() => store.getOutput(id)!.status === 'error' || store.getOutput(id)!.status === 'cancelled');
  assert.equal(store.getOutput(id)!.status, 'error');
  assert.equal(store.getOutput(id)!.error, 'Provider stopped unexpectedly.');
});
