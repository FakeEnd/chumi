/** Real local model smoke test; synthetic transcript, isolated database, no AI provider or microphone. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const input = process.argv[2] ? resolve(process.argv[2]) : null;
if (!input || !existsSync(input)) throw new Error('Usage: node scripts/acceptance-speakers.ts /absolute/test-16khz-mono.wav');
const root = mkdtempSync(join(tmpdir(), 'chumi-speaker-acceptance-'));
process.env.CHUMI_DATA_DIR = root;
const { Store } = await import('../server/db.ts');
const { SpeakerRecorder, speakerAudioAvailable } = await import('../server/speakers/audio.ts');
const { SpeakerService } = await import('../server/speakers/service.ts');
const { speakerRuntime } = await import('../server/speakers/runtime.ts');
const { readWav } = await import('../server/audio/wav.ts');
const { exportSession } = await import('../server/export.ts');
const { renderSegments } = await import('../server/ai/context.ts');
const { Evidence } = await import('../server/projects/evidence.ts');
const store = new Store(join(root, 'test.db'));
const service = new SpeakerService(store, () => {});
try {
  assert.equal(speakerRuntime().ready, true, speakerRuntime().reason ?? 'Run npm run setup:speakers first.');
  const samples = readWav(input);
  const duration = samples.length / 16;
  const sessionId = 'speaker_acceptance';
  store.createProject({ id: 'test_project', name: 'Speaker acceptance', workspace: root });
  store.createSession({ id: sessionId, title: 'Speaker smoke test — synthetic transcript', type: 'other', audio_source: 'file' });
  store.assignSession(sessionId, 'test_project');
  // These artificial lines validate timestamp attribution only, not speech recognition accuracy.
  for (let t = 0; t < duration; t += 500) store.addSegment({ session_id: sessionId, source: 'file', run: 1,
    t_start: t, t_end: Math.min(t + 500, duration), text: `Synthetic transcript fixture at ${t} ms.`, lang: 'en' });
  store.updateSession(sessionId, { status: 'ended', ended_at: Date.now(), duration_ms: duration });
  const recorder = new SpeakerRecorder(sessionId, false);
  recorder.write('file', 0, samples); recorder.close();
  const started = performance.now();
  await service.analyze(sessionId);
  const elapsedMs = Math.round(performance.now() - started);
  const view = service.view(sessionId);
  assert.equal(view.analysis.status, 'done', view.analysis.error ?? 'Analysis failed.');
  assert.ok(view.speakers.length > 0, 'Use a fixture that contains speech.');
  const assigned = store.segments(sessionId).find((s) => s.speaker_state === 'assigned');
  assert.ok(assigned?.speaker_id, 'No synthetic line received a clear speaker assignment.');
  store.insertOutput({ id: 'old_summary', session_id: sessionId, kind: 'final_summary', status: 'done', content: 'Synthetic pre-naming summary.' });
  store.renameSpeaker(sessionId, assigned.speaker_id, 'Acceptance Speaker');
  const segments = store.segments(sessionId);
  assert.ok(renderSegments(segments, 1_000_000).text.includes('Acceptance Speaker'));
  assert.ok(exportSession(store, sessionId, 'md').body.includes('Acceptance Speaker'));
  const evidence = new Evidence(store, (id) => `http://localhost/?session=${id}`);
  const passages = evidence.passages({ meeting_id: sessionId, project_id: 'test_project', segment_ids: [assigned.id] });
  assert.ok(JSON.stringify(passages).includes('Acceptance Speaker'));
  assert.equal(store.getOutput('old_summary')?.stale_reason, 'speaker_labels_changed');
  assert.equal(speakerAudioAvailable(sessionId), false, 'Temporary audio must be deleted after analysis.');
  assert.equal(existsSync(input), true, 'The original fixture must remain untouched.');
  console.log(JSON.stringify({ status: 'passed', input, durationMs: Math.round(duration), elapsedMs,
    speakers: view.speakers.length, assignedLines: segments.filter((s) => s.speaker_state === 'assigned').length,
    mixedLines: segments.filter((s) => s.speaker_state === 'mixed').length,
    validated: ['local inference', 'timestamp assignment', 'naming', 'AI context', 'export', 'MCP evidence', 'stale summary', 'temporary cleanup'],
    note: 'Synthetic transcript boundaries; this smoke test does not measure diarization or ASR accuracy.' }, null, 2));
} finally {
  await service.shutdown();
  store.close();
  rmSync(root, { recursive: true, force: true });
}
