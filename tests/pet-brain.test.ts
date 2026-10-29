import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PetBrain, SLEEP_AFTER } from '../web/src/pet/brain.ts';

const recording = { status: 'recording', session: { id: 's1' } };

test('the pet listens while a meeting records and dozes off when nothing happens', () => {
  const b = new PetBrain();
  b.hello(0);
  assert.equal(b.mood(1), 'wave');
  assert.equal(b.mood(10), 'idle');
  assert.equal(b.mood(SLEEP_AFTER + 1), 'sleep');
  assert.match(b.activity(SLEEP_AFTER + 2)!.text, /napping/);
  assert.equal(b.mood(SLEEP_AFTER + 2.5), 'surprised');
  assert.equal(b.activity(SLEEP_AFTER + 5), null, 'only waking up says something');

  const t = 200;
  assert.equal(b.live({ status: 'starting', session: { id: 's1' } }, t - 0.5), null);
  assert.equal(b.live(recording, t)!.text, "I'm listening!");
  assert.equal(b.live(recording, t + 1), null, 'a repeated state is not news');
  assert.equal(b.mood(t + 5), 'listen');
  assert.equal(b.mood(t + 5 + SLEEP_AFTER * 3), 'listen', 'never sleeps through a meeting');
  assert.equal(b.live({ status: 'paused', session: { id: 's1' } }, t + 6)!.text, 'Taking a little break');
  assert.equal(b.mood(t + 7), 'paused');
  // A resume passes through 'starting' too.
  assert.equal(b.live({ status: 'starting', session: { id: 's1' } }, t + 7.5), null);
  assert.equal(b.live(recording, t + 8)!.text, 'Back to listening!');
});

test('the pet stops thinking about work that can no longer report back', () => {
  const b = new PetBrain();
  b.live(recording, 0);
  b.ai({ id: 'h', kind: 'handoff', status: 'streaming', session_id: 's1' }, 1);
  assert.equal(b.mood(2), 'think');
  b.deleted('s2');
  assert.equal(b.mood(3), 'think', "another meeting's deletion changes nothing");
  b.deleted('s1');
  assert.equal(b.mood(4), 'listen');
  b.ai({ id: 'a', kind: 'answer', status: 'pending', session_id: 's1' }, 10);
  assert.equal(b.mood(10 + 60), 'think');
  assert.equal(b.mood(10 + 16 * 60), 'listen', 'an answer that never finished is given up on');
});

test('requested answers make the pet think, then announce once with a way to open Chumi', () => {
  const b = new PetBrain();
  b.lang = 'zh';
  b.live(recording, 0);
  assert.equal(b.ai({ id: 'o1', kind: 'catchup', status: 'pending' }, 1), null);
  assert.equal(b.mood(2), 'think');
  const done = b.ai({ id: 'o1', kind: 'catchup', status: 'done' }, 3)!;
  assert.equal(done.text, '刚才讲的，帮你理好啦！');
  assert.equal(done.open, true);
  assert.equal(done.tag, 'meeting', 'the bubble filter sees it as a meeting card');
  assert.equal(b.ai({ id: 'q', kind: 'answer', status: 'done', data: { category: 'tangent' } }, 3.5)!.tag, 'tangent');
  assert.equal(b.tap(4)?.tag, undefined, 'taps are chatter');
  assert.equal(b.mood(3.5), 'happy');
  assert.equal(b.mood(10), 'listen');
  assert.equal(b.ai({ id: 'o1', kind: 'catchup', status: 'done' }, 11), null, 'later updates of the same answer stay quiet');

  // Background work never interrupts; a new term found automatically does.
  assert.equal(b.ai({ id: 'o2', kind: 'overview', status: 'pending', question: null }, 12), null);
  assert.equal(b.mood(13), 'listen');
  assert.equal(b.ai({ id: 'o2', kind: 'overview', status: 'done', question: null }, 14), null);
  assert.equal(b.ai({ id: 'o3', kind: 'auto_explain', status: 'done', question: 'KV cache' }, 15)!.text, '新词：KV cache');

  const failed = b.ai({ id: 'o4', kind: 'answer', status: 'error' }, 20)!;
  assert.equal(failed.tone, 'warn');
  assert.equal(failed.important, true, 'failures show whatever the bubble filter says');
  assert.equal(b.mood(21), 'worried');
});

test('the summary is celebrated, errors are rate-limited, and catch-up needs a live meeting', () => {
  const b = new PetBrain();
  assert.ok(b.catchupBlocked());
  assert.equal(b.menu().find((m) => m.id === 'catchup')!.enabled, false);
  b.live(recording, 0);
  assert.equal(b.catchupBlocked(), null);
  assert.equal(b.menu().find((m) => m.id === 'catchup')!.enabled, true);

  b.live({ status: 'idle', session: null }, 5);
  assert.equal(b.ended(4, false).text, 'Good meeting!', 'an empty meeting gets no summary to promise');
  assert.equal(b.ended(5, true).text, 'Good meeting! Writing it up…');
  assert.equal(b.mood(6), 'wave');
  b.ai({ id: 'f', kind: 'final_summary', status: 'pending' }, 8);
  assert.equal(b.mood(9), 'think');
  assert.equal(b.ai({ id: 'f', kind: 'final_summary', status: 'done' }, 10)!.text, 'The meeting summary is ready!');
  assert.equal(b.mood(11), 'celebrate');

  assert.ok(b.notice({ level: 'error' }, 30));
  assert.equal(b.notice({ level: 'error' }, 35), null);
  assert.equal(b.notice({ level: 'warning' }, 60), null);
  assert.ok(b.notice({ level: 'error' }, 60));
});

test('taps get a hop every time and a word every other time; petting speaks rarely', () => {
  const b = new PetBrain();
  const said = [0, 1, 2, 3].map((i) => b.tap(i * 3));
  assert.deepEqual(said.map((s) => !!s), [true, false, true, false]);
  assert.equal(b.mood(9.5), 'happy');
  assert.ok(b.petted(20));
  assert.equal(b.petted(25), null);
  assert.ok(b.petted(31));
});

test('answer bubbles retain their meeting and handoff destination across meeting switches', () => {
  const b = new PetBrain();
  b.live(recording, 0);
  b.live({ status: 'recording', session: { id: 's2' } }, 1);
  for (const kind of ['answer', 'final_summary', 'handoff', 'auto_explain']) {
    const line = b.ai({ id: kind, kind, status: 'done', session_id: 's1' }, 2)!;
    assert.equal(line.session, 's1');
    assert.equal(line.output, kind);
    assert.equal(line.dialog, kind === 'handoff' ? 'handoff' : undefined);
  }
});
