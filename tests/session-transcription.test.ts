import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { Store } from '../server/db.ts';
import { SessionManager } from '../server/session/manager.ts';
import { HelperCapture } from '../server/audio/capture.ts';
import { Transcriber } from '../server/asr/transcriber.ts';
import type { SpeechService } from '../server/asr/speech.ts';
import type { WhisperResult } from '../server/asr/whisper.ts';
import type { Assistant } from '../server/ai/assistant.ts';

const utterance = (id: number) => ({ id, startSec: id, endSec: id + 1, samples: new Int16Array(16_000), final: true });
const result = (text: string): WhisperResult => ({ text, language: 'en', langProbs: {}, segments: [{ start: 0, end: 1, text }], ms: 1 });
const cfg = () => ({ language: 'en', glossary: [], chineseScript: 'simplified' });

function deferredSpeech(partials = false) {
  const calls: Array<{ resolve: (r: WhisperResult) => void; reject: (error: Error) => void }> = [];
  const speech = {
    state: 'ready', partials, ensure: async () => {},
    transcribe: () => new Promise<WhisperResult>((resolve, reject) => { calls.push({ resolve, reject }); }),
  } as unknown as SpeechService;
  return { speech, calls };
}

function fixture(t: TestContext) {
  // No microphone, speech server, or network: feed synthetic final chunks directly into the queue.
  t.mock.method(HelperCapture.prototype, 'start', async () => {});
  t.mock.method(HelperCapture.prototype, 'stop', async () => {});
  const store = new Store(':memory:');
  const { speech, calls } = deferredSpeech();
  const summaries: Array<{ id: string; text: string[] }> = [];
  const exports: string[] = [];
  const events: Array<{ event: string; data: unknown }> = [];
  const assistant = {
    onActivity: () => {},
    summary: (id: string) => { summaries.push({ id, text: store.segments(id).map((s) => s.text) }); return store.insertOutput({ id: `summary-${summaries.length}`, session_id: id, kind: 'final_summary', status: 'done' }).id; },
  } as unknown as Assistant;
  const manager = new SessionManager(store, speech, assistant, (event, data) => { events.push({ event, data }); });
  manager.onEnded = (id) => { exports.push(id); };
  const transcriber = (manager as unknown as { transcriber: Transcriber }).transcriber;
  const originalDrain = transcriber.drain.bind(transcriber);
  t.mock.method(transcriber, 'drain', (timeout = 60_000) => originalDrain(timeout === 90_000 || timeout === 4000 ? 0 : timeout));
  const start = (title: string) => manager.start({ title, type: 'other', source: 'mic', recordAudio: false });
  t.after(async () => { await manager.suspendForShutdown(); store.close(); });
  return { store, manager, transcriber, calls, summaries, exports, events, start };
}

test('shutdown while end is still waiting cannot later mark the interrupted meeting ended', async (t) => {
  const f = fixture(t);
  const first = await f.start('Closing during end');
  f.transcriber.pushFinal('mic', utterance(1));
  // Exercise the real end/shutdown overlap, before the usual 90-second deadline fires.
  const originalDrain = Transcriber.prototype.drain.bind(f.transcriber);
  t.mock.method(f.transcriber, 'drain', (timeout = 60_000) => originalDrain(timeout === 4000 ? 0 : timeout));
  const ending = f.manager.end();
  await setImmediate();
  await f.manager.suspendForShutdown();
  await ending;
  f.calls[0].resolve(result('This completion belongs to an interrupted meeting.'));
  await setImmediate();
  assert.equal(f.store.getSession(first.id)?.status, 'interrupted');
  assert.equal(f.manager.status, 'idle');
  assert.deepEqual(f.summaries, []);
});

test('a capture startup finishing after shutdown cannot revive a recording or schedule its summary', async (t) => {
  const f = fixture(t);
  let captureReady!: () => void;
  t.mock.method(HelperCapture.prototype, 'start', () => new Promise<void>((resolve) => { captureReady = resolve; }));
  const starting = f.start('Closing during capture startup');
  const rejected = assert.rejects(starting, /shutting down/);
  await setImmediate();
  const id = f.manager.session!.id;
  assert.equal(f.manager.status, 'starting');
  await f.manager.suspendForShutdown();
  captureReady();
  await rejected;
  assert.equal(f.manager.status, 'idle');
  assert.equal(f.store.getSession(id)?.status, 'interrupted');
  assert.deepEqual(f.summaries, []);
  assert.deepEqual(f.exports, []);
});

test('a summary startup failure still releases the saved session for the next meeting', async (t) => {
  const f = fixture(t);
  const first = await f.start('Summary failure');
  f.transcriber.pushFinal('mic', utterance(1));
  f.calls[0].resolve(result('The transcript is saved independently of the summary.'));
  await setImmediate();
  f.manager.beforeSummary = () => { throw new Error('Synthetic summary startup failure.'); };
  await f.manager.end();
  assert.equal(f.store.getSession(first.id)?.status, 'ended');
  assert.equal(f.manager.status, 'idle');
  assert.equal(f.manager.session, null);
  assert.equal(f.manager.warnings.at(-1)?.code, 'summary_failed');
  assert.deepEqual(f.exports, [first.id]);
  f.manager.beforeSummary = null;
  await f.start('Meeting after summary failure');
  await f.manager.end();
});

test('an old speaker completion cannot consume a newer summary token after the same session is resumed', async (t) => {
  const f = fixture(t);
  const first = await f.start('Repeated speaker analysis');
  const speakersReady: Array<() => void> = [];
  f.manager.beforeSummary = () => new Promise<void>((resolve) => { speakersReady.push(resolve); });
  f.transcriber.pushFinal('mic', utterance(1));
  f.calls[0].resolve(result('The original transcript remains available.'));
  await setImmediate();
  await f.manager.end();
  await f.manager.resumeSession(first.id, 'mic');
  await f.manager.end();
  assert.equal(speakersReady.length, 2);
  speakersReady[0]();
  await setImmediate();
  assert.deepEqual(f.summaries, []);
  speakersReady[1]();
  await setImmediate();
  assert.equal(f.summaries.length, 1);
});

test('deleting a saved meeting invalidates its deferred summary before old speaker work returns', async (t) => {
  const f = fixture(t);
  const first = await f.start('Deleted after saving');
  let speakersReady!: () => void;
  f.manager.beforeSummary = () => new Promise<void>((resolve) => { speakersReady = resolve; });
  f.transcriber.pushFinal('mic', utterance(1));
  f.calls[0].resolve(result('This saved meeting will be deleted.'));
  await setImmediate();
  await f.manager.end();
  f.manager.invalidateDeferredSummary(first.id);
  f.store.deleteSession(first.id);
  speakersReady();
  await setImmediate();
  assert.deepEqual(f.summaries, []);
  assert.equal(f.store.getSession(first.id), undefined);
});

test('an obsolete in-flight partial neither delays drain nor leaks into a reset transcriber', async () => {
  const { speech, calls } = deferredSpeech(true);
  const transcriber = new Transcriber(speech, cfg);
  const partials: string[] = [], finals: string[] = [], errors: string[] = [];
  transcriber.on('partial', (_source, _id, _start, text) => { partials.push(text); });
  transcriber.on('final', (pieces) => { finals.push(...pieces.map((p) => p.text)); });
  transcriber.on('error', (error) => { errors.push(error); });
  transcriber.pushProgress('mic', utterance(1));
  assert.equal(await transcriber.drain(0), true);
  transcriber.reset('next-meeting');
  transcriber.pushFinal('mic', utterance(2));
  calls[0].resolve(result('An obsolete partial from a prior meeting.'));
  await setImmediate();
  assert.equal(transcriber.pendingFinals, 1); // The obsolete finally cannot clear the newer active job.
  calls[1].resolve(result('A final from the current meeting.'));
  assert.equal(await transcriber.drain(), true);
  assert.deepEqual(partials, []);
  assert.deepEqual(finals, ['A final from the current meeting.']);
  assert.deepEqual(errors, []);
});

test('stopping a transcriber invalidates failures and retry continuations from an old generation', async () => {
  const { speech, calls } = deferredSpeech();
  const transcriber = new Transcriber(speech, cfg);
  const errors: string[] = [];
  transcriber.on('error', (error) => { errors.push(error); });
  transcriber.pushFinal('mic', utterance(1));
  const drained = transcriber.drain();
  transcriber.stop();
  assert.equal(await drained, false);
  calls[0].reject(new Error('Late failure after the database has closed.'));
  await setImmediate();
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 1);
});

test('a timed-out end waits for its own closing lines and speaker work, even while another meeting transcribes', async (t) => {
  const f = fixture(t);
  const first = await f.start('Closing action items');
  f.transcriber.pushFinal('mic', utterance(30));
  f.transcriber.pushFinal('mic', utterance(31));
  let speakersReady!: () => void;
  const speakerTexts: string[][] = [];
  f.manager.beforeSummary = (id) => {
    speakerTexts.push(f.store.segments(id).map((s) => s.text));
    return new Promise<void>((resolve) => { speakersReady = resolve; });
  };
  await f.manager.end();
  assert.deepEqual(f.summaries, []);
  assert.deepEqual(speakerTexts, []);
  assert.equal(f.store.timeline(first.id).find((e) => e.kind === 'stop')?.t, 32_000);
  await f.start('Next meeting');
  f.transcriber.pushFinal('mic', utterance(1));
  f.calls[0].resolve(result('We agreed to publish the results.'));
  await setImmediate();
  assert.deepEqual(f.summaries, []);
  f.calls[1].resolve(result('The deadline is next Monday.'));
  await setImmediate();
  assert.deepEqual(speakerTexts, [['We agreed to publish the results.', 'The deadline is next Monday.']]);
  assert.deepEqual(f.summaries, []);
  speakersReady();
  await setImmediate();
  assert.deepEqual(f.summaries, [{ id: first.id, text: speakerTexts[0] }]);
  assert.equal(f.transcriber.pendingFinals, 1, 'the next meeting does not delay the first summary');
  f.calls[2].resolve(result('New meeting opening words.'));
});

test('End returns promptly when only failed audio remains, and retries continue in the background', { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  const session = await f.start('Offline');
  t.mock.method(f.transcriber, 'drain', Transcriber.prototype.drain.bind(f.transcriber));
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  f.transcriber.pushFinal('mic', utterance(1));
  f.calls[0].reject(new Error('Cannot reach ElevenLabs'));
  await setImmediate();
  const ended = await f.manager.end();
  assert.equal(ended.sessionId, session.id);
  assert.equal(f.manager.status, 'idle');
  assert.equal(f.transcriber.pendingFinals, 1);
  assert.deepEqual(f.summaries, []);
  t.mock.timers.tick(2000);
  f.calls[1].resolve(result('The speech service came back.'));
  await setImmediate();
  assert.deepEqual(f.summaries, [{ id: session.id, text: ['The speech service came back.'] }]);
});


test('a hung final bounds the summary wait and marks summaries stale when it finally arrives', async (t) => {
  const f = fixture(t);
  const session = await f.start('Hung final');
  f.transcriber.pushFinal('mic', utterance(1));
  f.calls[0].resolve(result('The opening discussion was transcribed.'));
  await setImmediate();
  f.transcriber.pushFinal('mic', utterance(2));
  t.mock.method(f.transcriber, 'drain', async () => false);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  await f.manager.end();
  t.mock.timers.tick(20 * 60_000 - 1);
  await setImmediate();
  assert.equal(f.summaries.length, 0);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(f.summaries.length, 1);
  assert.equal(f.store.outputs(session.id)[0].stale_reason, 'transcription_pending');
  assert.ok(f.events.some((e) => e.event === 'ai' && (e.data as { stale_reason: string }).stale_reason === 'transcription_pending'));
  f.calls[1].resolve(result('The closing action items arrived much later.'));
  await setImmediate();
  assert.equal(f.store.outputs(session.id)[0].stale_reason, 'transcript_completed_late');
  assert.equal(f.store.segments(session.id).length, 2);
});

test('adjacent failed finals share a gap marker, including out-of-order sources and shutdown', async (t) => {
  const f = fixture(t);
  const session = await f.start('Gap markers');
  f.transcriber.emit('gap', session.id, 'mic', 0, 1, 'service offline');
  f.transcriber.emit('gap', session.id, 'system', 2, 3, 'service offline');
  f.transcriber.emit('gap', session.id, 'mic', 1, 2, 'service offline');
  for (let i = 3; i < 100; i++) f.transcriber.pushFinal('mic', utterance(i));
  f.transcriber.stop();
  const gaps = f.store.timeline(session.id).filter((e) => e.kind === 'gap');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].t, 0);
  assert.match(gaps[0].detail!, /0:00–1:40/);
  assert.ok(f.events.some((e) => e.event === 'timeline' && (e.data as { replaces: number[] }).replaces?.length > 0));
});

test('utterance pauses do not split an outage but recovered speech does', async (t) => {
  const f = fixture(t);
  const session = await f.start('Outage and recovery');
  f.transcriber.emit('gap', session.id, 'mic', 0, 5, 'service offline');
  f.transcriber.emit('gap', session.id, 'mic', 10, 15, 'service offline');
  assert.equal(f.store.timeline(session.id).filter((e) => e.kind === 'gap').length, 1);
  f.transcriber.emit('final', [{ session: session.id, source: 'mic', uttId: 1, startSec: 20, endSec: 25, text: 'The service recovered for this part.', lang: 'en' }]);
  f.transcriber.emit('gap', session.id, 'mic', 30, 35, 'another failure');
  assert.equal(f.store.timeline(session.id).filter((e) => e.kind === 'gap').length, 2);
});
