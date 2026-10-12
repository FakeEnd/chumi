import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpeakerRecorder, discardSpeakerAudio, mapSpeakerTurns, prepareSpeakerInputs, speakerAudioAvailable } from '../server/speakers/audio.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'chumi-speaker-audio-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('speaker audio maps input gaps and paused takes back to session time without shifting transcript IDs', async () => {
  const { root, cleanup } = fixture();
  try {
    const first = new SpeakerRecorder('session', false, root);
    first.write('mic', 2_000, new Int16Array(16_000).fill(100));
    first.write('mic', 10_000, new Int16Array(16_000).fill(200));
    first.write('system', 2_500, new Int16Array(8_000).fill(300));
    first.close(); first.close();
    const resumed = new SpeakerRecorder('session', false, root);
    resumed.write('mic', 20_000, new Int16Array(16_000).fill(400));
    resumed.close();
    assert.equal(readdirSync(join(root, 'session/speakers/temporary')).filter((f) => f.endsWith('.wav')).length, 3);
    const inputs = await prepareSpeakerInputs('session', new AbortController().signal, root);
    const mic = inputs.find((s) => s.source === 'mic')!;
    assert.deepEqual(mic.mapping, [
      { packed_start_ms: 0, start_ms: 2000, end_ms: 3000 },
      { packed_start_ms: 1250, start_ms: 10000, end_ms: 11000 },
      { packed_start_ms: 2500, start_ms: 20000, end_ms: 21000 },
    ]);
    assert.deepEqual(mapSpeakerTurns(mic, [{ start_ms: 500, end_ms: 2750, speaker: '0' }]), [
      { source: 'mic', speaker: '0', start_ms: 2500, end_ms: 3000 },
      { source: 'mic', speaker: '0', start_ms: 10000, end_ms: 11000 },
      { source: 'mic', speaker: '0', start_ms: 20000, end_ms: 20250 },
    ]);
    const wav = readFileSync(mic.path);
    assert.equal(wav.readInt16LE(44), 100);
    assert.equal(wav.readInt16LE(44 + 16000 * 2), 0, 'inserted silence separates takes');
    assert.equal(wav.readInt16LE(44 + 20000 * 2), 200);
    const fractional = { source: 'mic', path: '', mapping: [{ packed_start_ms: 0, start_ms: 0.123, end_ms: 1000.123 }] };
    assert.deepEqual(mapSpeakerTurns(fractional, [{ start_ms: 0, end_ms: 1000, speaker: '0' }]), [
      { source: 'mic', speaker: '0', start_ms: 0.123, end_ms: 1000.123 },
    ], 'fractional capture clocks must never round a turn outside its recorded coverage');
    discardSpeakerAudio('session', root);
    assert.equal(speakerAudioAvailable('session', root), false);
  } finally { cleanup(); }
});

test('temporary cleanup preserves retained takes; clock re-anchors keep capturing; traversal fails closed', async () => {
  const { root, cleanup } = fixture();
  try {
    assert.throws(() => new SpeakerRecorder('../escape', false, root), /Invalid session/);
    const retained = new SpeakerRecorder('session', true, root);
    retained.write('mic', 500, new Int16Array(16_000)); // 500–1500 ms
    retained.write('mic', 1400, new Int16Array(1_600)); // a 100 ms re-anchor continues the take: 1500–1600 ms
    retained.write('mic', 0, new Int16Array(160)); // a larger step back starts a new take for this source only
    retained.write('system', 2000, new Int16Array(160));
    retained.close();
    const inputs = await prepareSpeakerInputs('session', new AbortController().signal, root);
    assert.deepEqual(inputs.find((i) => i.source === 'mic')!.mapping.map((m) => [m.start_ms, m.end_ms]), [[0, 10], [500, 1600]]);
    assert.deepEqual(inputs.find((i) => i.source === 'system')!.mapping.map((m) => [m.start_ms, m.end_ms]), [[2000, 2010]]);
    discardSpeakerAudio('session', root);
    assert.equal(speakerAudioAvailable('session', root), true);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(prepareSpeakerInputs('session', controller.signal, root), /abort/i);
  } finally { cleanup(); }
});
