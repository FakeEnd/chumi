import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { echoContained, isMicEcho } from '../server/session/echo.ts';
import { SessionManager } from '../server/session/manager.ts';
import { Store } from '../server/db.ts';
import { HelperCapture } from '../server/audio/capture.ts';
import { Transcriber } from '../server/asr/transcriber.ts';
import type { SpeechService } from '../server/asr/speech.ts';
import type { Assistant } from '../server/ai/assistant.ts';

const systemText = 'We need to finish the experiment before Friday and share the results with the team. The next step is to review the measurements and decide whether the new method improves accuracy.';
const fragment = 'We need to finish the experiment before Friday and share the results';

test('echo containment recognizes short English and Chinese fragments without matching unrelated speech', () => {
  assert.equal(echoContained(systemText, fragment), true);
  assert.equal(echoContained('今天我们讨论贝叶斯优化的实验结果，然后安排下一步的工作。', '我们讨论贝叶斯优化的实验结果'), true);
  assert.equal(echoContained(systemText, 'I have a different question about the lunch schedule.'), false);
  assert.equal(echoContained('', fragment), false);
});

test('mic echo waits for active and queued system speech beyond four seconds, with a hard cap for real mic speech', async (t) => {
  t.mock.method(HelperCapture.prototype, 'start', async () => {});
  t.mock.method(HelperCapture.prototype, 'stop', async () => {});
  const store = new Store(':memory:');
  const manager = new SessionManager(store, { ensure: async () => {}, state: 'ready', partials: false, transcribe: async () => ({ text: systemText, segments: [], language: 'en', langProbs: {}, ms: 1 }) } as unknown as SpeechService,
    { onActivity: () => {}, summary: () => 'summary' } as unknown as Assistant, () => {});
  const session = await manager.start({ title: 'Echo', source: 'both', type: 'other', recordAudio: false });
  const { transcriber, run } = manager as unknown as { transcriber: Transcriber; run: { input: HelperCapture } };
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  t.after(async () => { t.mock.timers.reset(); await manager.suspendForShutdown(); store.close(); });
  run.input.emit('frames', 'system', 0, new Int16Array(6 * 16000).fill(4000));
  transcriber.emit('final', [{ session: session.id, source: 'mic', uttId: 1, startSec: 0, endSec: 5, text: fragment, lang: 'en' }]);
  t.mock.timers.tick(5000);
  assert.equal(store.segments(session.id).length, 0, 'active system speech keeps the fragment held');
  run.input.emit('frames', 'system', 6, new Int16Array(16000));
  await setImmediate();
  assert.deepEqual(store.segments(session.id).map((s) => s.source), ['system']);
  assert.equal(manager.droppedDuplicates, 1);
  transcriber.emit('final', [{ session: session.id, source: 'mic', uttId: 2, startSec: 20, endSec: 21, text: 'I have a different question about the lunch schedule.', lang: 'en' }]);
  t.mock.timers.tick(25_000);
  assert.equal(store.segments(session.id).at(-1)?.source, 'mic', 'missing system audio cannot hold mic speech forever');
});

test('a sleep jump keeps transcript session time and creates one gap for both sources', async (t) => {
  t.mock.method(HelperCapture.prototype, 'start', async () => {});
  t.mock.method(HelperCapture.prototype, 'stop', async () => {});
  const store = new Store(':memory:');
  const manager = new SessionManager(store, { ensure: async () => {}, state: 'ready' } as unknown as SpeechService, { onActivity: () => {} } as unknown as Assistant, () => {});
  const session = await manager.start({ title: 'Sleep', source: 'both', type: 'other', recordAudio: false });
  const { run } = manager as unknown as { run: { input: HelperCapture; capturedToMs: number } };
  for (const source of ['mic', 'system'] as const) run.input.emit('frames', source, 0, new Int16Array(16000));
  for (const source of ['mic', 'system'] as const) run.input.emit('frames', source, 601, new Int16Array(16000));
  assert.equal(run.capturedToMs, 602_000);
  const gaps = store.timeline(session.id).filter((e) => e.kind === 'gap');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].t, 1000);
  assert.match(gaps[0].detail!, /computer sleep/);
  await manager.suspendForShutdown();
  store.close();
});

const remote = "So the main thing I wanted to show you today is that the gradient estimates are much noisier than we thought, and I think that's why the training diverges after about ten thousand steps. If you look at this plot here, the variance goes up right when the learning rate warms up, so I'd like you to try a smaller warmup and see if that helps with the stability.";
const replies = ['Yes.', "Yeah, I think that's right.", 'Okay, that makes sense.', 'Thank you.', 'Right, I see.', 'I think so too.', 'Can you go back to the plot?', 'Sorry, what was the learning rate?', 'So I should try a smaller warmup?', "That's what I thought.", "I'll try that this week.", 'Did you look at the variance?', 'Okay.', 'Got it.', 'I agree with that.', 'What about the training steps?', 'Hmm, interesting.'];
const remoteZh = '我们今天主要讨论一下这个实验的结果，我觉得梯度的方差比我们想象的要大很多，所以训练在一万步之后就发散了。你看这张图，学习率预热的时候方差就上去了，所以我建议你试一下更小的预热。';
const repliesZh = ['对对对。', '好的，我明白了。', '我觉得也是。', '那我试一下更小的预热？', '学习率是多少？', '可以再看一下那张图吗？', '好的。', '谢谢老师。', '我这周试一下。'];

for (const late of [false, true]) test(`English and Chinese replies survive shared vocabulary ${late ? 'after End' : 'during recording'}`, async (t) => {
  t.mock.method(HelperCapture.prototype, 'start', async () => {});
  t.mock.method(HelperCapture.prototype, 'stop', async () => {});
  const store = new Store(':memory:');
  const manager = new SessionManager(store, { ensure: async () => {}, state: 'ready' } as unknown as SpeechService,
    { onActivity: () => {}, summary: () => 'summary' } as unknown as Assistant, () => {});
  const session = await manager.start({ title: 'Reply regression', source: 'both', type: 'other', recordAudio: false });
  const { transcriber, run } = manager as unknown as { transcriber: Transcriber; run: { input: HelperCapture } };
  t.after(async () => { await manager.suspendForShutdown(); store.close(); });
  run.input.emit('frames', 'system', 0, new Int16Array(20 * 16000));
  if (late) await manager.end();
  let uttId = 0;
  for (const [text, answers, lang] of [[remote, replies, 'en'], [remoteZh, repliesZh, 'zh']] as const) {
    transcriber.emit('final', [{ session: session.id, source: 'system', uttId: ++uttId, startSec: 0, endSec: 10, text, lang }]);
    for (const answer of answers) transcriber.emit('final', [{ session: session.id, source: 'mic', uttId: ++uttId, startSec: 10.5, endSec: 12.5, text: answer, lang }]);
  }
  transcriber.emit('settled');
  assert.deepEqual(store.segments(session.id).filter((s) => s.source === 'mic').map((s) => s.text), [...replies, ...repliesZh]);
  assert.equal(manager.droppedDuplicates, 0);
  transcriber.emit('final', [{ session: session.id, source: 'mic', uttId: ++uttId, startSec: 3, endSec: 5, text: 'the variance goes up right when the learning rate warms up', lang: 'en' }]);
  transcriber.emit('settled');
  assert.equal(manager.droppedDuplicates, 1, 'a simultaneous echo is still removed');
});

test('echo matching requires a substantial overlap with one specific system segment', () => {
  const line = { text: fragment, t_start: 0, t_end: 10_000 };
  assert.equal(isMicEcho({ ...line, t_start: 9500, t_end: 12_500 }, [line]), false, 'a small boundary overlap does not erase a reply');
  assert.equal(isMicEcho({ ...line, t_start: 2000, t_end: 5000 }, [line]), true);
  for (const reply of [...replies, ...repliesZh]) assert.equal(echoContained(/[\p{Script=Han}]/u.test(reply) ? remoteZh : remote, reply), false, reply);
  assert.equal(isMicEcho({ text: 'Check the experimental data and then send the updated report', t_start: 0, t_end: 2000 }, [
    { text: 'Check the experimental data', t_start: 0, t_end: 1000 },
    { text: 'and then send the updated report', t_start: 1000, t_end: 2000 },
  ]), false, 'separate system segments are not concatenated to manufacture a match');
});
