import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDiarization, speakerRuntime } from '../server/speakers/runtime.ts';

function fixture(t: TestContext, script: string) {
  const directory = mkdtempSync(join(tmpdir(), 'chumi-speaker-runtime-'));
  const python = join(directory, 'fake-python.mjs');
  const models = join(directory, 'models');
  mkdirSync(join(models, 'sherpa-onnx-pyannote-segmentation-3-0'), { recursive: true });
  writeFileSync(join(models, 'sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx'), 'test model');
  writeFileSync(join(models, '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'), 'test model');
  writeFileSync(python, '#!/usr/bin/env node\n' + script);
  chmodSync(python, 0o700);
  const wav = join(directory, 'recording.wav');
  writeFileSync(wav, 'test audio; the fake worker checks only the protocol');
  const previous = { python: process.env.CHUMI_SPEAKER_PYTHON, models: process.env.CHUMI_SPEAKER_MODELS };
  process.env.CHUMI_SPEAKER_PYTHON = python;
  process.env.CHUMI_SPEAKER_MODELS = models;
  t.after(() => {
    if (previous.python === undefined) delete process.env.CHUMI_SPEAKER_PYTHON; else process.env.CHUMI_SPEAKER_PYTHON = previous.python;
    if (previous.models === undefined) delete process.env.CHUMI_SPEAKER_MODELS; else process.env.CHUMI_SPEAKER_MODELS = previous.models;
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, python, models, wav };
}

const response = (value: unknown, exitCode = 0) => `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(JSON.stringify(value))}); process.exitCode = ${exitCode}; });`;
const valid = { v: 1, type: 'result', duration_ms: 2000, turns: [{ start_ms: 0, end_ms: 1000, speaker: 'speaker_0' }, { start_ms: 900, end_ms: 1500, speaker: 'speaker_1' }] };

test('speaker runtime checks executable and nonempty model files', { timeout: 3000 }, (t) => {
  const f = fixture(t, response(valid));
  assert.deepEqual(speakerRuntime(), { ready: true, reason: null, setupCommand: 'npm run setup:speakers' });
  writeFileSync(join(f.models, 'sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx'), '');
  assert.match(speakerRuntime().reason!, /models are missing/);
  rmSync(f.python);
  assert.match(speakerRuntime().reason!, /not installed/);
});

test('diarization subprocess sends paths via JSON and preserves overlapping turns', { timeout: 3000 }, async (t) => {
  const f = fixture(t, `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { const request = JSON.parse(input); if (request.v !== 1 || !request.wav.endsWith('recording.wav') || !request.models.endsWith('models')) process.exit(2); process.stdout.write(${JSON.stringify(JSON.stringify(valid))}); });`);
  assert.deepEqual(await runDiarization(f.wav, { signal: new AbortController().signal }), valid.turns);
});

test('diarization accepts a successful recording without speech', { timeout: 3000 }, async (t) => {
  const f = fixture(t, response({ ...valid, turns: [] }));
  assert.deepEqual(await runDiarization(f.wav, { signal: new AbortController().signal }), []);
});

for (const [name, result] of [
  ['invalid envelope', { ...valid, v: 2 }],
  ['excessive duration', { ...valid, duration_ms: 3 * 60 * 60 * 1000 }],
  ['negative time', { ...valid, turns: [{ start_ms: -1, end_ms: 1000, speaker: 'speaker_0' }] }],
  ['outside recording', { ...valid, turns: [{ start_ms: 0, end_ms: 3000, speaker: 'speaker_0' }] }],
  ['invalid identity', { ...valid, turns: [{ start_ms: 0, end_ms: 1000, speaker: '../person' }] }],
  ['unsorted turns', { ...valid, turns: [...valid.turns].reverse() }],
] as const) {
  test(`diarization rejects ${name}`, { timeout: 3000 }, async (t) => {
    const f = fixture(t, response(result));
    await assert.rejects(runDiarization(f.wav, { signal: new AbortController().signal }), /speaker worker returned/);
  });
}

test('diarization does not accept a result from a failed process', { timeout: 3000 }, async (t) => {
  const f = fixture(t, response(valid, 1));
  await assert.rejects(runDiarization(f.wav, { signal: new AbortController().signal }), /stopped before finishing/);
});

test('diarization reports fixed worker errors without echoing arbitrary details', { timeout: 3000 }, async (t) => {
  const f = fixture(t, response({ v: 1, type: 'error', code: 'missing_dependency', message: 'do not expose this' }, 1));
  await assert.rejects(runDiarization(f.wav, { signal: new AbortController().signal }), { message: 'Local speaker dependencies are missing. Run the speaker setup command.' });
});

test('diarization rejects truncated JSON and excessive output', { timeout: 3000 }, async (t) => {
  const f = fixture(t, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{'));");
  await assert.rejects(runDiarization(f.wav, { signal: new AbortController().signal }), /invalid output/);
  writeFileSync(f.python, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write('x'.repeat(5 * 1024 * 1024)));");
  await assert.rejects(runDiarization(f.wav, { signal: new AbortController().signal }), /too much output/);
});

test('diarization aborts before spawning and kills an uncooperative process', { timeout: 5000 }, async (t) => {
  const f = fixture(t, "process.stdin.resume(); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  await assert.rejects(runDiarization(f.wav, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const start = Date.now();
  await assert.rejects(runDiarization(f.wav, { signal: AbortSignal.timeout(200) }), { name: 'AbortError' });
  assert.ok(Date.now() - start < 2500, 'cancellation must kill the child promptly');
});

test('diarization enforces its subprocess deadline', { timeout: 3000 }, async (t) => {
  const f = fixture(t, 'process.stdin.resume(); setInterval(() => {}, 1000);');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = runDiarization(f.wav, { signal: new AbortController().signal });
  const rejected = assert.rejects(result, /timed out/);
  t.mock.timers.tick(30 * 60_000);
  await rejected;
});
