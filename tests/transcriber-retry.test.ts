import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { Transcriber } from '../server/asr/transcriber.ts';

const utterance = (id: number, seconds = 1) => ({ id, startSec: id, endSec: id + seconds, samples: new Int16Array(16_000 * seconds), final: true });
const cfg = () => ({ language: 'en', glossary: [], chineseScript: 'simplified' });

test('failed finals survive repeated outages and keep their session across a reset', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let calls = 0;
  const transcriber = new Transcriber({ partials: false, transcribe: async () => {
    if (++calls < 3) throw new Error('offline');
    return { text: 'The closing action item is saved.', segments: [], language: 'en', langProbs: {}, ms: 1 };
  } }, cfg);
  const finals: string[] = [], gaps: unknown[] = [];
  transcriber.on('final', (pieces) => finals.push(...pieces.map((p) => p.session!)));
  transcriber.on('gap', (...args) => gaps.push(args));
  transcriber.reset('first');
  transcriber.pushFinal('mic', utterance(1));
  await setImmediate();
  transcriber.reset('second');
  for (const delay of [2000, 30_000]) { t.mock.timers.tick(delay); await setImmediate(); }
  assert.equal(calls, 3);
  assert.deepEqual(finals, ['first']);
  assert.deepEqual(gaps, []);
  assert.equal(transcriber.retrying, false);
  assert.equal(await transcriber.drain(), true);
  transcriber.stop();
});

test('retry expiry, queue overflow and shutdown report the exact missing ranges', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const transcriber = new Transcriber({ partials: false, transcribe: async () => { throw new Error('offline'); } }, cfg);
  const gaps: Array<[string | null, string, number, number, string]> = [];
  transcriber.on('gap', (...args) => gaps.push(args));
  transcriber.reset('meeting');
  transcriber.pushFinal('mic', utterance(1));
  await setImmediate();
  t.mock.timers.tick(15 * 60_000);
  await setImmediate();
  assert.match(gaps[0][4], /fifteen minutes/);
  assert.deepEqual(gaps[0].slice(0, 4), ['meeting', 'mic', 1, 2]);
  transcriber.pushFinal('system', utterance(10, 901));
  await setImmediate();
  assert.match(gaps[1][4], /queue reached/);
  transcriber.pushFinal('mic', utterance(20));
  transcriber.stop();
  assert.match(gaps[2][4], /app closed/);
  assert.equal(transcriber.pendingFinals, 0);
});

test('expired outage backlog becomes gaps together instead of spending another timeout on every clip', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let calls = 0;
  const transcriber = new Transcriber({ partials: false, transcribe: async () => { calls++; throw new Error('offline'); } }, cfg);
  const gaps: number[] = [];
  transcriber.on('gap', (_id, _source, start) => gaps.push(start));
  transcriber.reset('meeting');
  for (let i = 1; i <= 4; i++) transcriber.pushFinal('mic', utterance(i));
  await setImmediate();
  const drained = transcriber.whenSessionDrained('meeting');
  t.mock.timers.tick(15 * 60_000);
  await setImmediate();
  assert.equal(await drained, true);
  assert.equal(calls, 4, 'every fresh clip gets a chance before retries');
  assert.deepEqual(gaps, [1, 2, 3, 4]);
  assert.equal(transcriber.retrying, false);
  transcriber.stop();
});

test('a slow healthy engine transcribes all seventy 15-second finals without a gap or cap', async () => {
  const ready: Array<() => void> = [];
  const tr = new Transcriber({ partials: false, transcribe: () => new Promise((resolve) => ready.push(() => resolve({ text: 'This part of the meeting is preserved.', segments: [], language: 'en', langProbs: {}, ms: 1 }))) }, cfg);
  const gaps: unknown[] = [];
  let finals = 0;
  tr.on('gap', (...args) => gaps.push(args)); tr.on('final', () => { finals++; });
  tr.reset('meeting');
  for (let i = 0; i < 70; i++) tr.pushFinal('mic', utterance(i * 15, 15));
  assert.equal(tr.pendingFinals, 70);
  assert.deepEqual(gaps, []);
  while (ready.length) { ready.shift()!(); await setImmediate(); }
  assert.equal(finals, 70);
  assert.deepEqual(gaps, []);
  assert.equal(await tr.drain(), true);
  tr.stop();
});

test('one rejected clip gets three attempts while later audio and the next meeting continue', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let badCalls = 0;
  const tr = new Transcriber({ partials: false, transcribe: async (samples) => {
    if (samples.length === 3 * 16000) { badCalls++; throw new Error('HTTP 400: audio rejected'); }
    return { text: 'The later audio is transcribed successfully.', segments: [], language: 'en', langProbs: {}, ms: 1 };
  } }, cfg);
  const finals: string[] = [], gaps: unknown[] = [];
  tr.on('final', (pieces) => finals.push(pieces[0].session!)); tr.on('gap', (...args) => gaps.push(args));
  tr.reset('first');
  tr.pushFinal('mic', utterance(0, 3));
  for (let i = 0; i < 5; i++) tr.pushFinal('mic', utterance(5 + i * 5, 4));
  await setImmediate();
  assert.equal(finals.length, 5, 'the bad clip cannot block later clips');
  assert.equal(badCalls, 1);
  tr.reset('second');
  tr.pushFinal('mic', utterance(1, 4));
  await setImmediate();
  assert.equal(finals.at(-1), 'second');
  for (const delay of [2000, 30_000]) { t.mock.timers.tick(delay); await setImmediate(); }
  assert.equal(badCalls, 3);
  assert.equal(gaps.length, 1);
  assert.equal(tr.pendingFinals, 0);
  tr.pushFinal('mic', utterance(8, 4));
  await setImmediate();
  assert.equal(finals.length, 7, 'an empty queue carries no old retry delay');
  tr.stop();
});
