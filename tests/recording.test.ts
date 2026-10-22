import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { Assistant } from '../server/ai/assistant.ts';
import type { SpeechService } from '../server/asr/speech.ts';
import { toPlayback, toSession } from '../shared/recording.ts';

const root = mkdtempSync(join(tmpdir(), 'chumi-recording-'));
process.env.CHUMI_DATA_DIR = root;
const { Store } = await import('../server/db.ts');
const { SessionManager } = await import('../server/session/manager.ts');
const { encodeWav, readWav } = await import('../server/audio/wav.ts');
const { SpeakerRecorder, hasRecordedAudio, recordedTakes, recoverOpenTakes } = await import('../server/speakers/audio.ts');
const { exportRecording, recordingBytes, sessionRecording } = await import('../server/session/recording.ts');
const { AUDIO_DIR } = await import('../server/paths.ts');
test.after(() => rmSync(root, { recursive: true, force: true }));

async function bytes(gen: AsyncGenerator<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of gen) parts.push(Buffer.from(b));
  return Buffer.concat(parts);
}
const fresh = () => mkdtempSync(join(root, 'audio-'));

test('session time and playback position map both ways across a collapsed gap', () => {
  const regions = [{ packed_ms: 0, start_ms: 1000, end_ms: 5000 }, { packed_ms: 5000, start_ms: 90_000, end_ms: 92_000 }];
  assert.equal(toPlayback(regions, 0), 0, 'before the first recorded audio');
  assert.equal(toPlayback(regions, 3000), 2000);
  assert.equal(toPlayback(regions, 30_000), 5000, 'a time in the gap plays from the next region');
  assert.equal(toPlayback(regions, 91_000), 6000);
  assert.equal(toPlayback(regions, 99_000), 7000, 'after the end');
  assert.equal(toSession(regions, 2000), 3000);
  assert.equal(toSession(regions, 4500), 5000, 'the break after a region shows its end');
  assert.equal(toSession(regions, 6000), 91_000);
  assert.equal(toSession([], 1000), 0);
});

test('a recording mixes overlapping sources and shrinks long gaps to a short break', async () => {
  const dir = fresh();
  const rec = new SpeakerRecorder('meeting', true, dir);
  rec.write('mic', 0, new Int16Array(16_000).fill(1000)); // 0–1 s
  rec.write('system', 500, new Int16Array(16_000).fill(32_000)); // 0.5–1.5 s, overlaps the microphone
  rec.write('mic', 60_000, new Int16Array(8_000).fill(-2000)); // after a pause: 60–60.5 s
  rec.close();
  const r = sessionRecording('meeting', dir)!;
  assert.deepEqual(r.regions, [{ packed_ms: 0, start_ms: 0, end_ms: 1500 }, { packed_ms: 2500, start_ms: 60_000, end_ms: 60_500 }]);
  assert.equal(r.duration_ms, 3000);
  const wav = await bytes(recordingBytes(r));
  assert.equal(wav.length, r.bytes);
  assert.equal(wav.readUInt32LE(40), 3000 * 32, 'WAV header data size');
  writeFileSync(join(dir, 'mix.wav'), wav);
  const pcm = readWav(join(dir, 'mix.wav'));
  assert.equal(pcm.length, 48_000);
  assert.equal(pcm[4000], 1000, 'microphone only');
  assert.equal(pcm[12_000], 32_767, 'both sources mix, clipped to the 16-bit range');
  assert.equal(pcm[20_000], 32_000, 'computer audio only');
  assert.equal(pcm[32_000], 0, 'the break between regions is silent');
  assert.equal(pcm[44_000], -2000, 'the audio after the pause');
  // Byte ranges may start and end inside samples and must match the whole file.
  for (const [from, to] of [[0, 10], [10, 50], [45, 46], [45, 47], [43, 32_045], [50_001, r.bytes]]) {
    assert.ok((await bytes(recordingBytes(r, from, to))).equals(wav.subarray(from, to)), `range ${from}–${to}`);
  }
  const other = new SpeakerRecorder('meeting', true, dir);
  other.write('mic', 70_000, new Int16Array(160));
  other.close();
  assert.notEqual(sessionRecording('meeting', dir)!.version, r.version, 'a resumed recording gets a new version');
});

test('only retained takes are the recording; temporary speaker copies are not', () => {
  const dir = fresh();
  const temporary = new SpeakerRecorder('meeting', false, dir);
  temporary.write('mic', 0, new Int16Array(160));
  temporary.close();
  assert.equal(hasRecordedAudio('meeting', dir), false);
  assert.equal(sessionRecording('meeting', dir), null);
  assert.throws(() => hasRecordedAudio('../escape', dir), /Invalid session/);
});

test('after a crash, an open take keeps its audio, including what came after the last checkpoint', () => {
  const dir = fresh();
  const rec = new SpeakerRecorder('meeting', true, dir);
  rec.write('mic', 1000, new Int16Array(16_000).fill(7)); // a new span checkpoints at once
  rec.write('mic', 2000, new Int16Array(8_000).fill(9)); // continues the span: no checkpoint yet
  // The app "crashes" here: the take is never closed.
  assert.equal(hasRecordedAudio('meeting', dir), true);
  assert.deepEqual(recordedTakes('meeting', dir), [], 'an open take is not played back');
  assert.equal(recoverOpenTakes('meeting', dir), 1);
  assert.equal(recoverOpenTakes('meeting', dir), 0, 'recovery runs once');
  const [take] = recordedTakes('meeting', dir);
  assert.equal(take.samples, 24_000);
  assert.deepEqual(take.spans, [{ sample_start: 0, sample_count: 24_000, start_ms: 1000 }]);
  const pcm = readWav(take.path);
  assert.equal(pcm.length, 24_000);
  assert.equal(pcm[20_000], 9);
});

test('recovery trims a manifest that is ahead of its audio and removes takes with none', () => {
  const dir = fresh();
  const takes = join(dir, 'meeting', 'speakers', 'retained');
  const empty = new SpeakerRecorder('meeting', true, dir);
  empty.write('mic', 0, new Int16Array(16_000));
  const [name] = readdirSync(takes).filter((n) => n.endsWith('.json'));
  const manifest = JSON.parse(readFileSync(join(takes, name), 'utf8'));
  writeFileSync(join(takes, name), JSON.stringify({ ...manifest, samples: 32_000, spans: [...manifest.spans, { sample_start: 16_000, sample_count: 16_000, start_ms: 5000 }] }));
  recoverOpenTakes('meeting', dir);
  assert.deepEqual(recordedTakes('meeting', dir)[0].spans, [{ sample_start: 0, sample_count: 16_000, start_ms: 0 }]);
  const lost = new SpeakerRecorder('lost', true, dir);
  lost.write('mic', 0, new Int16Array(160));
  const lostDir = join(dir, 'lost', 'speakers', 'retained');
  for (const n of readdirSync(lostDir).filter((f) => f.endsWith('.wav'))) writeFileSync(join(lostDir, n), Buffer.alloc(44));
  recoverOpenTakes('lost', dir);
  assert.deepEqual(readdirSync(lostDir), []);
});

test('the Record audio choice belongs to each session and continues when it is resumed', { timeout: 10_000 }, async () => {
  // Silence: the stand-in speech service has nothing to transcribe.
  const file = join(root, 'silence.wav');
  writeFileSync(file, encodeWav(new Int16Array(16_000)));
  const store = new Store(':memory:');
  const assistant = { onActivity: () => {}, summary: () => 'summary' } as unknown as Assistant;
  const manager = new SessionManager(store, { ensure: async () => {}, state: 'ready' } as unknown as SpeechService, assistant, () => {});
  const play = async (start: () => Promise<unknown>) => {
    manager.warnings = [];
    await start();
    while (!manager.warnings.some((w) => w.code === 'file_finished')) await setTimeout(10);
    await manager.end();
  };
  try {
    let recorded = '';
    await play(async () => { recorded = (await manager.start({ title: 'Recorded', type: 'other', source: 'file', filePath: file, speed: 16, recordAudio: true })).id; });
    assert.equal(store.getSession(recorded)?.record_audio, 1);
    const first = sessionRecording(recorded)!;
    assert.ok(first.duration_ms >= 900, `about one second of audio, got ${first.duration_ms} ms`);
    await play(() => manager.resumeSession(recorded, 'file', { path: file, speed: 16 }));
    const resumed = sessionRecording(recorded)!;
    assert.equal(recordedTakes(recorded).length, 2, 'the resumed run adds its own take');
    const resume = store.timeline(recorded).findLast((e) => e.kind === 'resume')!;
    assert.equal(resumed.regions.at(-1)!.end_ms, resume.t + 1000, 'the resumed audio sits at its session time');

    let unrecorded = '';
    await play(async () => { unrecorded = (await manager.start({ title: 'Not recorded', type: 'other', source: 'file', filePath: file, speed: 16, recordAudio: false })).id; });
    assert.equal(store.getSession(unrecorded)?.record_audio, 0);
    assert.equal(existsSync(join(AUDIO_DIR, unrecorded)), false, 'nothing is written without Record audio or speaker labeling');
  } finally { await manager.suspendForShutdown(); store.close(); }
});

test('export encodes the recording as one AAC file on macOS and reuses it', { skip: process.platform !== 'darwin' }, async () => {
  const dir = fresh();
  const rec = new SpeakerRecorder('meeting', true, dir);
  const tone = Int16Array.from({ length: 32_000 }, (_, i) => Math.round(8000 * Math.sin(i / 10)));
  rec.write('mic', 0, tone);
  rec.close();
  const r = sessionRecording('meeting', dir)!;
  const out = await exportRecording('meeting', r, dir);
  assert.equal(out.ext, 'm4a');
  assert.ok(out.path && statSync(out.path).size > 1000);
  assert.equal(readFileSync(out.path).toString('ascii', 4, 8), 'ftyp', 'an MPEG-4 audio file');
  assert.deepEqual(readdirSync(join(dir, 'meeting')).filter((n) => n.includes('tmp')), [], 'temporary files are removed');
  assert.deepEqual(await exportRecording('meeting', r, dir), out);
});
