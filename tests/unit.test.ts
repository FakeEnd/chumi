import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameParser } from '../server/audio/capture.ts';
import { Segmenter, type Utterance } from '../server/audio/vad.ts';
import { encodeWav, SAMPLE_RATE } from '../server/audio/wav.ts';
import { cleanSegmentText, collapseRepeats, keepSegment, toSimplified } from '../server/asr/clean.ts';
import { checkRefs } from '../server/ai/assistant.ts';
import { evaluateCodexQuota } from '../server/ai/codex.ts';
import { parseJsonLoose } from '../server/ai/provider.ts';
import { keywords, renderSegments } from '../server/ai/context.ts';
import { DEPTH_GUIDE, renderProfile, summaryInstructions } from '../server/ai/prompts.ts';
import { DEFAULT_PROFILE } from '../server/settings.ts';
import { fmtT, parseT, similarity, termKey } from '../server/util.ts';
import type { SegmentRow } from '../server/db.ts';

function frame(src: number, ts: number, samples: number[]): Buffer {
  const b = Buffer.alloc(20 + samples.length * 2);
  b.write('CHA1', 0); b.writeUInt8(src, 4); b.writeDoubleLE(ts, 8); b.writeUInt32LE(samples.length, 16);
  samples.forEach((s, i) => b.writeInt16LE(s, 20 + i * 2));
  return b;
}

test('frame parser handles split chunks and multiple sources', () => {
  const got: Array<[number, number, number]> = [];
  const p = new FrameParser((src, ts, s) => got.push([src, ts, s.length]));
  const all = Buffer.concat([frame(1, 0.5, [1, 2, 3]), frame(2, 0.75, [4, 5])]);
  p.push(all.subarray(0, 7)); p.push(all.subarray(7, 30)); p.push(all.subarray(30));
  assert.deepEqual(got, [[1, 0.5, 3], [2, 0.75, 2]]);
});

function tone(sec: number, amp: number): Int16Array {
  const n = Math.round(sec * SAMPLE_RATE); const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * (0.6 + 0.4 * Math.sin(i / 900)));
  return a;
}

test('segmenter emits one final per utterance, progress snapshots, and pause events', () => {
  const sg = new Segmenter();
  const finals: Utterance[] = []; let progress = 0; let pauses = 0;
  sg.on('final', (u) => finals.push(u)); sg.on('progress', () => progress++); sg.on('pause', () => pauses++);
  const audio = [tone(1, 0), tone(3, 8000), tone(1.2, 0), tone(2.5, 9000), tone(3, 0)];
  let t = 0;
  for (const chunk of audio) { for (let i = 0; i < chunk.length; i += 800) { const c = chunk.subarray(i, i + 800); sg.push(t, c); t += c.length / SAMPLE_RATE; } }
  sg.flush();
  assert.equal(finals.length, 2);
  assert.ok(Math.abs(finals[0].startSec - 1) < 0.4, `start ${finals[0].startSec}`);
  assert.ok(finals[1].startSec > 4.8 && finals[1].startSec < 5.3, `second start ${finals[1].startSec} (speech at 5.2 s minus 300 ms preroll)`);
  assert.ok(progress >= 1);
  assert.ok(pauses >= 1);
});

test('segmenter splits long monologues', () => {
  const sg = new Segmenter({ maxUtteranceSec: 6 });
  const finals: Utterance[] = [];
  sg.on('final', (u) => finals.push(u));
  const speech = tone(14, 8000);
  for (let i = 0; i < speech.length; i += 800) sg.push(i / SAMPLE_RATE, speech.subarray(i, i + 800));
  sg.flush();
  assert.ok(finals.length >= 2);
  assert.ok(finals.every((u) => u.samples.length / SAMPLE_RATE <= 6.1));
});

test('wav encoding header', () => {
  const w = encodeWav(new Int16Array([1, -1, 2]));
  assert.equal(w.toString('ascii', 0, 4), 'RIFF'); assert.equal(w.readUInt32LE(40), 6); assert.equal(w.length, 50);
});

test('whisper text cleaning drops hallucinations and keeps real speech', () => {
  assert.equal(cleanSegmentText(' [BLANK_AUDIO] '), '');
  assert.equal(keepSegment({ start: 0, end: 2, text: '', no_speech_prob: 0.01, avg_logprob: -0.2 }, '字幕由Amara.org社区提供', 2), false);
  assert.equal(keepSegment({ start: 0, end: 1, text: '', no_speech_prob: 0.5, avg_logprob: -0.9 }, 'Thank you.', 1), false);
  assert.equal(keepSegment({ start: 0, end: 3, text: '', no_speech_prob: 0.0, avg_logprob: -0.2 }, 'Thank you.', 3), true);
  assert.equal(keepSegment({ start: 0, end: 3, text: '', no_speech_prob: 0.0, avg_logprob: -0.3 }, 'We used an MPRA to validate.', 3), true);
  assert.equal(collapseRepeats('the model the model the model the model works'), 'the model works');
});

test('traditional to simplified conversion keeps English terms', () => {
  assert.equal(toSimplified('對,Accessibility和Activity真的不一樣。我們'), '对,Accessibility和Activity真的不一样。我们');
});

test('time formatting round-trips', () => {
  assert.equal(fmtT(65_000), '1:05'); assert.equal(fmtT(3_725_000), '1:02:05');
  assert.equal(parseT('1:05'), 65_000); assert.equal(parseT('1:02:05'), 3_725_000);
});

test('term keys dedupe variants', () => {
  assert.equal(termKey('Massively Parallel Reporter Assays'), termKey('massively-parallel reporter assay'));
  assert.equal(termKey('MPRA (massively parallel reporter assay)'), 'mpra');
  assert.ok(similarity('so it might be a batch effect', 'So it might be a batch effect.') > 0.8);
  assert.ok(similarity('negative binomial model', '我们需要第三个replicate') < 0.1);
});

const segs: SegmentRow[] = [
  { id: 1, session_id: 's', t_start: 60_000, t_end: 66_000, text: 'GATA motif in two of three replicates', lang: 'en', source: 'mic', run: 1, created_at: 0 },
  { id: 2, session_id: 's', t_start: 120_000, t_end: 126_000, text: 'rerun with chromosome holdout', lang: 'en', source: 'mic', run: 1, created_at: 0 },
];

test('reference checker flags citations with no supporting transcript', () => {
  const r = checkRefs('Found it [1:02], action [2:01–2:05], invented [9:59].', segs);
  assert.equal(r.total, 3);
  assert.deepEqual(r.invalid, ['9:59']);
});

test('segment rendering keeps the most recent lines within budget', () => {
  const r = renderSegments(segs, 50);
  assert.ok(r.truncated); assert.ok(r.text.includes('[2:00] rerun')); assert.ok(!r.text.includes('GATA'));
});

test('keywords pick technical terms and CJK trigrams', () => {
  const k = keywords('Why are they using MPRA and a negative binomial model? 负二项分布');
  assert.ok(k.includes('MPRA')); assert.ok(k.includes('binomial')); assert.ok(k.some((x) => /[一-鿿]{3}/.test(x)));
});

test('loose JSON parsing tolerates fences and prose', () => {
  assert.deepEqual(parseJsonLoose('Sure:\n```json\n{"cards": []}\n```'), { cards: [] });
  assert.equal(parseJsonLoose('no json here'), null);
});

test('Codex quota gate blocks when included usage is exhausted unless credits are explicitly allowed', () => {
  const base = { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_800_000_000 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: '100' }, spendControlReached: false, planType: 'pro', rateLimitReachedType: null } };
  const ok = evaluateCodexQuota(base, false);
  assert.equal(ok.exhausted, false); assert.equal(ok.credits?.willUse, false); assert.equal(ok.known, true);
  const full = { ...base, rateLimits: { ...base.rateLimits, primary: { ...base.rateLimits.primary, usedPercent: 100 } } };
  assert.equal(evaluateCodexQuota(full, false).exhausted, true);
  assert.equal(evaluateCodexQuota(full, false).credits?.willUse, false, 'never spends credits by default');
  assert.equal(evaluateCodexQuota(full, true).credits?.willUse, true, 'only with explicit opt-in');
  assert.equal(evaluateCodexQuota({ ...base, ordinaryUsageAllowed: false }, false).exhausted, true);
  const unknown = evaluateCodexQuota(null, false);
  assert.equal(unknown.known, false); assert.match(unknown.summary, /unavailable/);
});

test('prompts: depth guides differ and profile is rendered per domain', () => {
  assert.notEqual(DEPTH_GUIDE.quick, DEPTH_GUIDE.deep);
  assert.match(DEPTH_GUIDE.deep, /equations|statistical/);
  const p = renderProfile(DEFAULT_PROFILE);
  assert.match(p, /Immunology: new to this/);
  assert.match(p, /Machine learning \/ deep learning: strong/);
  assert.match(summaryInstructions('lab_meeting'), /not stated/);
  assert.match(summaryInstructions('advisor'), /My tasks/);
  assert.match(summaryInstructions('lecture'), /Topics to review/);
  assert.match(summaryInstructions('wip'), /Hypotheses/);
});

import { shouldStore, thumbChange } from '../server/screen/watcher.ts';
import { languageRule } from '../server/ai/prompts.ts';
import { normalizeLanguage } from '../server/settings.ts';

test('window capture keeps new slides and throttles continuous motion', () => {
  const N = 64 * 48;
  const base = Buffer.alloc(N, 230);
  const textSlide = Buffer.from(base); for (let i = 0; i < 70; i++) textSlide[i * 17] = 60;   // ~2% changed: small-font text slide
  const scene = Buffer.from(base); for (let i = 0; i < N * 0.4; i++) scene[i] = 20;           // 40%: new scene
  const caret = Buffer.from(base); caret[100] = 0;                                             // blinking caret
  assert.equal(thumbChange(base, base), 0);
  assert.ok(thumbChange(base, textSlide) > 0.015 && thumbChange(base, textSlide) < 0.03);
  assert.equal(shouldStore(thumbChange(base, textSlide), 0, 5000), true, 'text slide change kept once settled');
  assert.equal(shouldStore(thumbChange(base, textSlide), 0.02, 5000), false, 'still moving: wait');
  assert.equal(shouldStore(thumbChange(base, caret), thumbChange(base, caret), 5000), false, 'caret blink ignored');
  assert.equal(shouldStore(thumbChange(base, scene), 0.4, 3500), true, 'big scene change in video kept');
  assert.equal(shouldStore(0.05, 0.05, 10_000), false, 'moving video not kept every few seconds');
  assert.equal(shouldStore(0.05, 0.05, 46_000), true, 'moving video sampled every 45 s');
});

test('explanation language is English or Simplified Chinese', () => {
  assert.equal(normalizeLanguage('English'), 'English');
  assert.equal(normalizeLanguage('中文'), 'Simplified Chinese');
  assert.equal(normalizeLanguage('Simplified Chinese'), 'Simplified Chinese');
  assert.equal(normalizeLanguage('zh'), 'Simplified Chinese');
  assert.match(languageRule({ ...DEFAULT_PROFILE, explanationLanguage: 'English' }), /Write everything in English/);
  assert.match(languageRule({ ...DEFAULT_PROFILE, explanationLanguage: 'Simplified Chinese' }), /Simplified Chinese/);
});

test('segmenter survives a forced split that lands inside a fading pause (regression: negative length crash)', () => {
  const sg = new Segmenter({ maxUtteranceSec: 3 });
  const finals: Utterance[] = [];
  sg.on('final', (u) => finals.push(u));
  const frames: Int16Array[] = [];
  const speech = tone(2.54, 8000);
  for (let i = 0; i < speech.length; i += 320) frames.push(speech.subarray(i, i + 320));
  // A pause whose level keeps falling (reverb tail / noise gate), so the quietest window is at its very end.
  for (let k = 0; k < 60; k++) frames.push(tone(0.02, Math.max(0, 110 - k * 5)));
  let t = 0;
  assert.doesNotThrow(() => { for (const f of frames) { sg.push(t, f); t += f.length / SAMPLE_RATE; } sg.flush(); });
  assert.ok(finals.length >= 1);
  assert.ok(finals.every((u) => u.samples.length > 0));
});

import { clampEffort } from '../server/ai/codex.ts';

test('effort maps to the closest supported level without going higher', () => {
  const luna = ['low', 'medium', 'high', 'xhigh', 'max'];
  assert.equal(clampEffort(luna, 'xhigh'), 'xhigh');
  assert.equal(clampEffort(['low', 'medium', 'high'], 'max'), 'high');
  assert.equal(clampEffort(['medium', 'high'], 'low'), 'medium');
  assert.equal(clampEffort([], 'max'), 'max');
});
