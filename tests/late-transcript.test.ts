import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Assistant } from '../server/ai/assistant.ts';
import type { SpeechService } from '../server/asr/speech.ts';
import type { WhisperResult } from '../server/asr/whisper.ts';
import type { Transcriber } from '../server/asr/transcriber.ts';

const root = mkdtempSync(join(tmpdir(), 'chumi-late-transcript-'));
process.env.CHUMI_DATA_DIR = root;
const { Store } = await import('../server/db.ts');
const { SessionManager } = await import('../server/session/manager.ts');
const { HelperCapture } = await import('../server/audio/capture.ts');
test.after(() => rmSync(root, { recursive: true, force: true }));

/**
 * Microphone sessions with a speech engine that answers only when the test says so, and an end() whose wait for
 * transcription has run out (as it does after 90 s), so a request is still in flight when the next session starts.
 */
function setup(t: TestContext) {
  t.mock.method(HelperCapture.prototype, 'start', async () => {});
  t.mock.method(HelperCapture.prototype, 'stop', async () => {});
  const store = new Store(':memory:');
  const requests: Array<{ resolve: (text: string) => void; reject: (e: Error) => void }> = [];
  const speech = {
    ensure: async () => {}, state: 'ready', partials: false,
    transcribe: () => new Promise<WhisperResult>((resolve, reject) => requests.push({
      resolve: (text) => resolve({ text, language: 'en', langProbs: { en: 1 }, segments: [{ start: 0, end: 1, text: ` ${text}` }], ms: 1 }), reject,
    })),
  } as unknown as SpeechService;
  const assistant = { onActivity: () => {}, summary: () => 'o_summary' } as unknown as Assistant;
  const notices: string[] = [];
  const manager = new SessionManager(store, speech, assistant, (event, data) => { if (event === 'notice') notices.push((data as { code: string }).code); });
  const transcriber = (manager as unknown as { transcriber: Transcriber }).transcriber;
  t.mock.method(transcriber, 'drain', async () => {});
  t.after(async () => { if (manager.status !== 'idle') await manager.end(); store.close(); });
  let id = 0;
  const speak = (startSec: number) => transcriber.pushFinal('mic', { id: ++id, startSec, endSec: startSec + 1, samples: new Int16Array(16_000), final: true });
  const texts = (sessionId: string) => store.segments(sessionId).map((s) => s.text);
  return { store, manager, requests, notices, speak, texts };
}

test('transcription that finishes after its session ended goes into that session, not the next one', { timeout: 5000 }, async (t) => {
  const { store, manager, requests, speak, texts } = setup(t);
  const a = await manager.start({ title: 'Lab meeting', type: 'other', source: 'mic' });
  speak(30);
  await manager.end(); // Gave up waiting; the request is still running.
  const b = await manager.start({ title: 'Advisor 1:1', type: 'other', source: 'mic' });
  speak(2);
  assert.equal(requests.length, 1, 'the next session waits behind the request in flight');

  requests[0].resolve('Last words of the lab meeting.');
  await setImmediate();
  assert.deepEqual(texts(a.id), ['Last words of the lab meeting.']);
  assert.deepEqual(texts(b.id), []);
  assert.ok(store.getSession(a.id)!.duration_ms >= 31_000, 'the ended session covers its late text');

  requests[1].resolve('Hello from the one-on-one.');
  await setImmediate();
  assert.deepEqual(texts(b.id), ['Hello from the one-on-one.']);
  assert.deepEqual(texts(a.id), ['Last words of the lab meeting.']);
});

test('a late request that fails is not retried or reported inside the next session', { timeout: 5000 }, async (t) => {
  const { manager, requests, notices, speak, texts } = setup(t);
  const a = await manager.start({ title: 'Lab meeting', type: 'other', source: 'mic' });
  speak(30);
  await manager.end();
  const b = await manager.start({ title: 'Advisor 1:1', type: 'other', source: 'mic' });
  requests[0].reject(new Error('engine restarted'));
  await setImmediate();
  speak(2);
  assert.equal(requests.length, 2, 'only the new session’s audio is sent');
  requests[1].resolve('Hello from the one-on-one.');
  await setImmediate();
  assert.deepEqual(texts(b.id), ['Hello from the one-on-one.']);
  assert.deepEqual(texts(a.id), []);
  assert.ok(!notices.includes('asr_error'));
});

test('late transcription for a deleted session is dropped', { timeout: 5000 }, async (t) => {
  const { store, manager, requests, speak } = setup(t);
  const a = await manager.start({ title: 'Lab meeting', type: 'other', source: 'mic' });
  speak(30);
  await manager.end();
  store.deleteSession(a.id);
  requests[0].resolve('Last words of the lab meeting.');
  await setImmediate();
  assert.equal(requests.length, 1, 'not retried');
  assert.equal(manager.status, 'idle');
});
