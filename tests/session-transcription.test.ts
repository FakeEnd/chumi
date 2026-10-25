import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate, setTimeout } from 'node:timers/promises';
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
    summary: (id: string) => { summaries.push({ id, text: store.segments(id).map((s) => s.text) }); return 'summary'; },
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

test('end deadline preserves all finals and reserves the meeting until its final transcript is summarized once', async (t) => {
  const f = fixture(t);
  const first = await f.start('First meeting');
  f.transcriber.pushFinal('mic', utterance(1));
  f.transcriber.pushFinal('mic', utterance(2));
  const ending = await f.manager.end();
  assert.equal(ending.pendingTranscription, true);
  assert.equal(f.manager.status, 'ending');
  assert.equal(f.manager.state().pendingTranscription, true);
  assert.equal(f.manager.session?.id, first.id); // The API's deletion guard still holds this session.
  assert.equal(f.store.getSession(first.id)?.status, 'recording');
  const stoppedClock = f.manager.nowT();
  await setTimeout(5);
  assert.equal(f.manager.nowT(), stoppedClock);
  await assert.rejects(f.start('Too early'), /already active/);
  await assert.rejects(f.manager.resumeSession(first.id, 'mic'), /active/);
  await assert.rejects(f.manager.end(), /No active session/);
  assert.throws(() => f.transcriber.reset(), /still being transcribed/);
  assert.deepEqual(f.summaries, []);
  assert.deepEqual(f.exports, []);

  f.calls[0].resolve(result('The first meeting began here.'));
  await setImmediate();
  assert.equal(f.calls.length, 2);
  assert.equal(f.manager.status, 'ending');
  f.calls[1].resolve(result('The first meeting concluded here.'));
  await setImmediate();
  assert.equal(f.manager.status, 'idle');
  assert.equal(f.manager.state().pendingTranscription, false);
  assert.deepEqual(f.summaries, [{ id: first.id, text: ['The first meeting began here.', 'The first meeting concluded here.'] }]);
  assert.deepEqual(f.exports, [first.id]);
  assert.equal(f.events.filter((e) => e.event === 'session-ended').length, 1);
  assert.equal(f.store.getSession(first.id)?.status, 'ended');

  const second = await f.start('Second meeting');
  f.transcriber.pushFinal('mic', utterance(3));
  f.calls[2].resolve(result('Only the second meeting belongs here.'));
  await setImmediate();
  await f.manager.end();
  assert.deepEqual(f.store.segments(second.id).map((s) => s.text), ['Only the second meeting belongs here.']);
  assert.equal(f.store.segments(first.id).length, 2);
});

test('a final retry after the end deadline stays attached to its original meeting', { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const first = await f.start('Retry meeting');
  f.transcriber.pushFinal('mic', utterance(1));
  assert.equal((await f.manager.end()).pendingTranscription, true);
  f.calls[0].reject(new Error('Temporary synthetic speech failure.'));
  await setTimeout(2050);
  assert.equal(f.manager.status, 'ending');
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve(result('Recovered after the temporary failure.'));
  await setImmediate();
  assert.equal(f.manager.status, 'idle');
  assert.deepEqual(f.summaries, [{ id: first.id, text: ['Recovered after the temporary failure.'] }]);
});

test('pending transcription finishes before speaker processing and a resume cancels the deferred summary', async (t) => {
  const f = fixture(t);
  const first = await f.start('Speaker meeting');
  let finishSpeakers!: () => void;
  let speakerRuns = 0;
  f.manager.beforeSummary = () => { speakerRuns++; return new Promise<void>((resolve) => { finishSpeakers = resolve; }); };
  f.transcriber.pushFinal('mic', utterance(1));
  await f.manager.pause();
  assert.equal((await f.manager.end()).pendingTranscription, true);
  assert.equal(speakerRuns, 0);
  f.calls[0].resolve(result('This transcript must precede speaker analysis.'));
  await setImmediate();
  assert.equal(speakerRuns, 1);
  assert.deepEqual(f.summaries, []);
  await f.manager.resumeSession(first.id, 'mic');
  finishSpeakers();
  await setImmediate();
  assert.deepEqual(f.summaries, []);
  f.manager.beforeSummary = null;
  await f.manager.end();
  assert.equal(f.summaries.length, 1);
});

test('shutdown during the pending background finish interrupts the meeting and invalidates late speech callbacks', async (t) => {
  const f = fixture(t);
  const first = await f.start('Closing meeting');
  f.transcriber.pushFinal('mic', utterance(1));
  f.transcriber.pushFinal('mic', utterance(2));
  await f.manager.end();
  await f.manager.suspendForShutdown();
  assert.equal(f.store.getSession(first.id)?.status, 'interrupted');
  assert.equal(f.manager.state().pendingTranscription, false);
  assert.match(f.store.timeline(first.id).at(-1)?.detail ?? '', /before transcription finished/);
  assert.match(f.store.timeline(first.id).at(-1)?.detail ?? '', /Audio recording was disabled/);
  await assert.rejects(f.start('After shutdown'), /shutting down/);
  f.calls[0].resolve(result('Late result must not revive the closed meeting.'));
  await setImmediate();
  assert.equal(f.calls.length, 1); // No queued job is started against a closing speech service.
  assert.equal(f.store.getSession(first.id)?.status, 'interrupted');
  assert.deepEqual(f.summaries, []);
  assert.deepEqual(f.exports, []);
  assert.equal(f.events.filter((e) => e.event === 'session-ended').length, 0);
});

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
  await f.manager.end();
  f.manager.beforeSummary = () => { throw new Error('Synthetic summary startup failure.'); };
  f.calls[0].resolve(result('The transcript is saved independently of the summary.'));
  await setImmediate();
  assert.equal(f.store.getSession(first.id)?.status, 'ended');
  assert.equal(f.manager.status, 'idle');
  assert.equal(f.manager.session, null);
  assert.equal(f.manager.state().pendingTranscription, false);
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
  transcriber.reset();
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
