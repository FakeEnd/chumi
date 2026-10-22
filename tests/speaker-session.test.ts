import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import type { Assistant } from '../server/ai/assistant.ts';
import type { SpeechService } from '../server/asr/speech.ts';

const root = mkdtempSync(join(tmpdir(), 'chumi-speaker-session-'));
process.env.CHUMI_DATA_DIR = root;
const { Store } = await import('../server/db.ts');
const { SessionManager } = await import('../server/session/manager.ts');
const { encodeWav } = await import('../server/audio/wav.ts');
const { speakerAudioAvailable } = await import('../server/speakers/audio.ts');
const file = join(root, 'silence.wav');
writeFileSync(file, encodeWav(new Int16Array(16_000)));
test.after(() => rmSync(root, { recursive: true, force: true }));

test('capture closes safely when ending a paused meeting, then waits for local speakers before its summary', { timeout: 5000 }, async () => {
  const store = new Store(':memory:');
  const settings = store.getSettings(); settings.asr.diarization = true; store.saveSettings(settings);
  const summaries: string[] = [];
  const assistant = { onActivity: () => {}, summary: (id: string) => { summaries.push(id); return 'summary'; } } as unknown as Assistant;
  const speech = { ensure: async () => {}, state: 'ready' } as unknown as SpeechService;
  const manager = new SessionManager(store, speech, assistant, () => {});
  let finish!: () => void;
  manager.beforeSummary = () => new Promise<void>((resolve) => { finish = resolve; });
  try {
    const session = await manager.start({ title: 'Speaker capture', type: 'other', source: 'file', filePath: file, speed: 16 });
    while (!manager.warnings.some((w) => w.code === 'file_finished')) await setTimeout(10);
    await manager.pause();
    store.addSegment({ session_id: session.id, source: 'file', run: 1, t_start: 0, t_end: 1000, text: 'Synthetic transcript fixture.', lang: 'en' });
    const result = await manager.end();
    assert.equal(result.summaryId, null);
    assert.equal(manager.status, 'idle');
    assert.equal(speakerAudioAvailable(session.id), true);
    assert.deepEqual(summaries, []);
    finish(); await setImmediate();
    assert.deepEqual(summaries, [session.id]);
  } finally { await manager.suspendForShutdown(); store.close(); }
});

test('resuming a meeting invalidates its pending automatic summary before cancelling speaker work', { timeout: 5000 }, async () => {
  const store = new Store(':memory:');
  const summaries: string[] = [];
  const assistant = { onActivity: () => {}, summary: (id: string) => { summaries.push(id); return 'summary'; } } as unknown as Assistant;
  const manager = new SessionManager(store, { ensure: async () => {}, state: 'ready' } as unknown as SpeechService, assistant, () => {});
  let finish!: () => void;
  manager.beforeSummary = () => new Promise<void>((resolve) => { finish = resolve; });
  manager.beforeResume = async () => { finish(); await setImmediate(); };
  try {
    const session = await manager.start({ title: 'Resume', type: 'other', source: 'file', filePath: file, speed: 16 });
    store.addSegment({ session_id: session.id, source: 'file', run: 1, t_start: 0, t_end: 1000, text: 'Synthetic transcript fixture.', lang: 'en' });
    await manager.end();
    await manager.resumeSession(session.id, 'file', { path: file, speed: 16 });
    assert.deepEqual(summaries, []);
    manager.beforeSummary = null;
    await manager.end();
    assert.deepEqual(summaries, [session.id]);
  } finally { await manager.suspendForShutdown(); store.close(); }
});

test('resume reserves the active session while speaker cancellation waits and rolls back on failure', async () => {
  const store = new Store(':memory:');
  store.createSession({ id: 'old', title: 'Old meeting', type: 'other', audio_source: 'file' });
  store.updateSession('old', { status: 'ended' });
  const manager = new SessionManager(store, { ensure: async () => {} } as unknown as SpeechService, {} as Assistant, () => {});
  let fail!: (error: Error) => void;
  manager.beforeResume = () => new Promise<void>((_resolve, reject) => { fail = reject; });
  try {
    const pending = manager.resumeSession('old', 'file', { path: file, speed: 16 });
    assert.equal(manager.status, 'starting');
    assert.equal(manager.session?.id, 'old');
    await assert.rejects(manager.start({ title: 'Concurrent start', type: 'other', source: 'file', filePath: file }), /already active/);
    fail(new Error('Synthetic cancellation failure.'));
    await assert.rejects(pending, /cancellation failure/);
    assert.equal(manager.status, 'idle');
    assert.equal(manager.session, null);
    assert.equal(store.getSession('old')?.status, 'ended');
  } finally { store.close(); }
});
