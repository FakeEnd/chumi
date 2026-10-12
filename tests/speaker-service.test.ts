import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Store } from '../server/db.ts';
import { SpeakerService } from '../server/speakers/service.ts';
import { SpeakerRecorder, speakerAudioAvailable } from '../server/speakers/audio.ts';

const ready = () => ({ ready: true, reason: null, setupCommand: 'npm run setup:speakers' });
function fixture(retain = false) {
  const root = mkdtempSync(join(tmpdir(), 'chumi-speaker-service-'));
  const store = new Store(join(root, 'test.db'));
  const meeting = (id: string) => {
    store.createSession({ id, title: id, type: 'other', audio_source: 'mic' });
    store.addSegment({ session_id: id, source: 'mic', run: 1, t_start: 2000, t_end: 4000, text: 'A useful meeting sentence.', lang: 'en' });
    store.updateSession(id, { status: 'ended', ended_at: Date.now(), duration_ms: 4000 });
    const recorder = new SpeakerRecorder(id, retain, root);
    recorder.write('mic', 2000, new Int16Array(32_000)); recorder.close();
  };
  meeting('one');
  return { root, store, meeting, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('after-meeting service commits labels and removes temporary audio before reporting availability', async () => {
  const f = fixture();
  try {
    const changes: string[] = [];
    const service = new SpeakerService(f.store, (id) => changes.push(id), { audioRoot: f.root, runtime: ready, run: async () => [{ start_ms: 0, end_ms: 2000, speaker: '0' }] });
    await service.analyze('one');
    assert.equal(service.view('one').analysis.status, 'done');
    assert.equal(service.view('one').canRun, false);
    assert.equal(f.store.segments('one')[0].speaker_state, 'assigned');
    assert.equal(speakerAudioAvailable('one', f.root), false);
    assert.ok(changes.length >= 3);
  } finally { f.cleanup(); }
});

test('cancel terminates the running worker, clears queued jobs and prevents late labels', async () => {
  const f = fixture(); f.meeting('two');
  try {
    let calls = 0;
    const service = new SpeakerService(f.store, () => {}, { audioRoot: f.root, runtime: ready,
      run: async (_path, { signal }) => {
        calls++;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return [{ start_ms: 0, end_ms: 2000, speaker: '0' }];
      },
    });
    const first = service.analyze('one');
    const second = service.analyze('two');
    await service.cancel('two'); await second;
    while (!calls) await setImmediate();
    await service.cancel('one'); await first;
    assert.equal(calls, 1);
    assert.equal(service.view('one').analysis.status, 'cancelled');
    assert.equal(service.view('two').analysis.status, 'cancelled');
    assert.equal(f.store.speakers('one').length, 0);
    assert.equal(speakerAudioAvailable('one', f.root), false);
  } finally { f.cleanup(); }
});

test('a failed analysis preserves retained audio for retry and old jobs recover without automatic inference', async () => {
  const f = fixture(true);
  try {
    let fail = true;
    const service = new SpeakerService(f.store, () => {}, { audioRoot: f.root, runtime: ready, run: async () => {
      if (fail) throw new Error('Synthetic model failure.');
      return [{ start_ms: 0, end_ms: 2000, speaker: '0' }];
    } });
    await service.analyze('one');
    assert.equal(service.view('one').analysis.status, 'failed');
    assert.equal(service.view('one').canRun, true);
    fail = false; await service.analyze('one');
    assert.equal(service.view('one').analysis.status, 'done');
    f.store.setSpeakerAnalysis('one', { status: 'running', generation: 'crashed', error: null, updated_at: Date.now() });
    service.recover();
    assert.equal(service.view('one').analysis.status, 'failed');
    assert.equal(speakerAudioAvailable('one', f.root), true);
  } finally { f.cleanup(); }
});
