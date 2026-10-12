import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../server/db.ts';
import { digests, formatSeg, latestOverview } from '../server/ai/context.ts';
import { Evidence } from '../server/projects/evidence.ts';
import { handoffFreshness } from '../server/projects/handoff-model.ts';
import { exportSession } from '../server/export.ts';
import { sessionToJsonl } from '../server/integrations/mybot.ts';
import type { SpeakerTurn } from '../shared/speakers.ts';

function meeting(store: Store, id = 'meeting') {
  store.createSession({ id, title: 'Speaker review', type: 'lab_meeting', audio_source: 'both' });
  store.updateSession(id, { status: 'ended', duration_ms: 6000 });
  return id;
}
function segment(store: Store, start: number, end: number, source = 'mic', session = 'meeting') {
  return store.addSegment({ session_id: session, t_start: start, t_end: end, source, text: `Original transcript ${start} ${source}`, lang: 'en', run: 1 });
}
function run(store: Store, generation: string, turns: SpeakerTurn[], coverage = [{ source: 'mic', start_ms: 0, end_ms: 6000 }], session = 'meeting') {
  store.setSpeakerAnalysis(session, { status: 'running', generation, error: null, updated_at: Date.now() });
  store.applySpeakerTurns(session, generation, turns, coverage);
}
const turn = (speaker: string, start_ms: number, end_ms: number, source = 'mic'): SpeakerTurn => ({ source, speaker, start_ms, end_ms });

test('speaker migration upgrades an existing v1 database and keeps transcript IDs and settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-speaker-migration-')), file = join(dir, 'meeting.db');
  let store = new Store(file);
  try {
    meeting(store); const original = segment(store, 0, 2000); store.setKV('preserved', { enabled: true });
    store.db.exec('DROP TABLE segment_speakers; DROP TABLE speaker_turns; DROP TABLE speaker_analyses; DROP TABLE session_speakers; ALTER TABLE ai_outputs DROP COLUMN stale_reason; PRAGMA user_version = 1');
    store.close(); store = new Store(file);
    assert.equal(store.schemaVersion(), SCHEMA_VERSION);
    assert.equal(store.segments('meeting')[0].id, original.id);
    assert.equal(store.segments('meeting')[0].text, original.text);
    assert.deepEqual(store.getKV('preserved', null), { enabled: true });
    assert.deepEqual(store.speakerAnalysis('meeting'), { status: 'not_run', generation: null, error: null, updated_at: null });
    store.close(); store = new Store(file);
    assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('durable annotation distinguishes assigned, mixed, unknown and independent audio sources', () => {
  const store = new Store(':memory:');
  try {
    meeting(store); const a = segment(store, 0, 2000); segment(store, 2000, 4000); segment(store, 4000, 6000); const remote = segment(store, 0, 2000, 'system');
    const before = store.getSession('meeting')!.revision;
    run(store, 'first', [turn('0', 0, 3000), turn('1', 3000, 4000), turn('0', 0, 2000, 'system')], [
      { source: 'mic', start_ms: 0, end_ms: 6000 }, { source: 'system', start_ms: 0, end_ms: 2000 },
    ]);
    const rows = store.segments('meeting');
    assert.equal(rows.find((s) => s.id === a.id)?.speaker_label, 'Speaker A');
    assert.equal(rows.find((s) => s.t_start === 2000)?.speaker_state, 'mixed');
    assert.equal(rows.find((s) => s.t_start === 4000)?.speaker_state, 'unknown');
    assert.notEqual(rows.find((s) => s.id === remote.id)?.speaker_id, rows.find((s) => s.id === a.id)?.speaker_id);
    assert.deepEqual(store.speakers('meeting').map((s) => s.label), ['A', 'B', 'C']);
    assert.equal(store.getSession('meeting')!.revision, before + 1, 'one revision for an atomic analysis');
    assert.equal(store.speakerAnalysis('meeting').status, 'done');
    assert.equal(store.searchSegments('meeting', ['Original'])[0].speaker_origin, 'automatic');
    assert.equal(store.firstSegment('meeting')?.speaker_state, 'assigned');
    assert.equal(store.lastSegment('meeting')?.speaker_state, 'unknown');
    assert.equal(store.segmentsAfter('meeting', 1000)[0].speaker_state, 'mixed');
  } finally { store.close(); }
});

test('reruns preserve temporal identity, human names and manual corrections, with automatic reset', () => {
  const store = new Store(':memory:');
  try {
    meeting(store); const a = segment(store, 0, 2000), b = segment(store, 2000, 4000);
    run(store, 'first', [turn('0', 0, 2000), turn('1', 2000, 4000)]);
    const [speakerA, speakerB] = store.speakers('meeting');
    store.renameSpeaker('meeting', speakerA.id, 'Advisor');
    store.correctSegmentSpeaker('meeting', b.id, { mode: 'speaker', speakerId: speakerA.id });
    store.correctSegmentSpeaker('meeting', a.id, { mode: 'unknown' });
    run(store, 'second', [turn('new-1', 0, 2000), turn('new-0', 2000, 4000)]);
    assert.equal(store.speakers('meeting').length, 2);
    assert.equal(store.speakers('meeting')[0].name, 'Advisor');
    assert.equal(store.segmentsByIds('meeting', [a.id])[0].speaker_state, 'unknown');
    assert.equal(store.segmentsByIds('meeting', [b.id])[0].speaker_label, 'Advisor');
    assert.equal(store.segmentsByIds('meeting', [b.id])[0].speaker_origin, 'manual');
    store.correctSegmentSpeaker('meeting', b.id, { mode: 'automatic' });
    assert.equal(store.segmentsByIds('meeting', [b.id])[0].speaker_id, speakerB.id);
    store.renameSpeaker('meeting', speakerA.id, null);
    store.correctSegmentSpeaker('meeting', a.id, { mode: 'automatic' });
    assert.equal(store.segmentsByIds('meeting', [a.id])[0].speaker_label, 'Speaker A');
  } finally { store.close(); }
});

test('partial analysis preserves old coverage and never reuses a worker ID for an unobserved person', () => {
  const store = new Store(':memory:');
  try {
    meeting(store); const old = segment(store, 0, 2000);
    run(store, 'first', [turn('0', 0, 2000)], [{ source: 'mic', start_ms: 0, end_ms: 2000 }]);
    const previous = store.segmentsByIds('meeting', [old.id])[0];
    const recent = segment(store, 10_000, 12_000);
    run(store, 'resumed', [turn('0', 10_000, 12_000)], [{ source: 'mic', start_ms: 10_000, end_ms: 12_000 }]);
    assert.equal(store.segmentsByIds('meeting', [old.id])[0].speaker_id, previous.speaker_id);
    assert.notEqual(store.segmentsByIds('meeting', [recent.id])[0].speaker_id, previous.speaker_id);
    assert.equal(store.segmentsByIds('meeting', [recent.id])[0].speaker_label, 'Speaker B');
    run(store, 'partial-old', [turn('new', 500, 1500)], [{ source: 'mic', start_ms: 500, end_ms: 1500 }]);
    assert.equal(store.segmentsByIds('meeting', [old.id])[0].speaker_id, previous.speaker_id);
    assert.equal(store.segmentsByIds('meeting', [old.id])[0].speaker_state, 'assigned');
    assert.equal(store.segmentsByIds('meeting', [recent.id])[0].speaker_label, 'Speaker B');
  } finally { store.close(); }
});

test('stale or cancelled analyses cannot commit; session/source ownership is enforced', () => {
  const store = new Store(':memory:');
  try {
    meeting(store); meeting(store, 'other'); const own = segment(store, 0, 2000); const foreign = segment(store, 0, 2000, 'mic', 'other'); const remote = segment(store, 0, 2000, 'system');
    store.setSpeakerAnalysis('meeting', { status: 'running', generation: 'current', error: null, updated_at: null });
    const revision = store.getSession('meeting')!.revision;
    store.applySpeakerTurns('meeting', 'obsolete', [turn('0', 0, 2000)]);
    assert.equal(store.speakers('meeting').length, 0);
    assert.equal(store.getSession('meeting')!.revision, revision);
    store.setSpeakerAnalysis('meeting', { status: 'cancelled', generation: 'current', error: null, updated_at: null });
    store.applySpeakerTurns('meeting', 'current', [turn('0', 0, 2000)]);
    assert.equal(store.speakers('meeting').length, 0);
    run(store, 'success', [turn('0', 0, 2000)]);
    const speaker = store.speakers('meeting')[0];
    assert.throws(() => store.renameSpeaker('other', speaker.id, 'Name'), /belong/);
    assert.throws(() => store.renameSpeaker('meeting', speaker.id, 'Invalid\nName'), /name/);
    assert.throws(() => store.renameSpeaker('meeting', speaker.id, 'x'.repeat(81)), /name/);
    assert.throws(() => store.correctSegmentSpeaker('meeting', foreign.id, { mode: 'unknown' }), /belong/);
    assert.throws(() => store.correctSegmentSpeaker('other', foreign.id, { mode: 'speaker', speakerId: speaker.id }), /belong/);
    assert.throws(() => store.correctSegmentSpeaker('meeting', remote.id, { mode: 'speaker', speakerId: speaker.id }), /audio source/);
    assert.throws(() => store.applySpeakerTurns('meeting', 'bad', [turn('0', -1, 2000)]), /Invalid/);
    assert.throws(() => store.applySpeakerTurns('meeting', 'bad', [turn('0', 0, 2000)], [{ source: 'mic', start_ms: 0, end_ms: 1000 }]), /outside/);
    assert.equal(store.segmentsByIds('meeting', [own.id])[0].text, own.text);
    store.deleteSession('meeting');
    for (const table of ['session_speakers', 'speaker_analyses', 'speaker_turns', 'segment_speakers']) assert.equal((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    assert.throws(() => store.setSpeakerAnalysis('meeting', { status: 'running', generation: 'gone', error: null, updated_at: null }), /not found/);
  } finally { store.close(); }
});

test('corrections stale derived context and reviewed handoffs and propagate to evidence and exports', () => {
  const store = new Store(':memory:');
  try {
    meeting(store); const raw = segment(store, 0, 2000);
    run(store, 'first', [turn('0', 0, 2000)]);
    store.insertOutput({ id: 'digest', session_id: 'meeting', kind: 'digest', status: 'done', content: 'Old attribution', covered_from: 0, covered_to: 2000 });
    store.insertOutput({ id: 'overview', session_id: 'meeting', kind: 'overview', status: 'done', content: 'Old overview', data_json: JSON.stringify({ current_topic: 'topic', overview: ['Old attribution'], topics: [], open_question: '' }) });
    store.insertOutput({ id: 'summary', session_id: 'meeting', kind: 'final_summary', status: 'done', content: 'Old summary' });
    store.insertOutput({ id: 'inflight', session_id: 'meeting', kind: 'answer', status: 'streaming' });
    const h = store.createHandoff({ id: 'handoff', session_id: 'meeting', project_id: null, status: 'confirmed' });
    store.updateHandoff(h.id, { confirmed_revision: store.getSession('meeting')!.revision, confirmed_at: Date.now(), confirmed_segment_max: raw.id });
    store.renameSpeaker('meeting', store.speakers('meeting')[0].id, 'Lin');
    assert.equal(digests(store, 'meeting').length, 0);
    assert.equal(latestOverview(store, 'meeting'), null);
    assert.equal(store.getOutput('summary')?.content, 'Old summary', 'generated history retained');
    assert.equal(store.getOutput('inflight')?.stale_reason, 'speaker_labels_changed');
    assert.equal(handoffFreshness(store, store.getHandoff(h.id)!).detail.speaker_labels_changed, true);
    assert.equal(handoffFreshness(store, store.getHandoff(h.id)!).stale, true);
    const evidence = new Evidence(store, () => null);
    assert.equal(evidence.passages({ meeting_id: 'meeting', segment_ids: [raw.id] }).passages[0].speaker_label, 'Lin');
    assert.equal(evidence.passages({ meeting_id: 'meeting', from: 0, to: 2000 }).passages[0].speaker_label, 'Lin');
    assert.equal(evidence.meetingOverview({ meeting_id: 'meeting' }).summary?.stale_reason, 'speaker_labels_changed');
    const text = exportSession(store, 'meeting', 'md').body;
    assert.match(text, /\] \(Lin\) /, 'automatic attribution is a short tag; the rules explain it once');
    assert.match(text, /predate a speaker annotation change/);
    assert.match(formatSeg({ ...raw, speaker_state: 'mixed' }), /\(mixed speakers\)/);
    assert.match(formatSeg({ ...raw, speaker_state: 'assigned', speaker_label: 'Lin', speaker_origin: 'manual' }), /\(Lin ✓\)/);
    assert.equal(formatSeg({ ...raw, speaker_state: null, speaker_id: null, speaker_label: null }), `[0:00] ${raw.text}`, 'unanalysed lines carry no tag');
    const lines = sessionToJsonl(store, 'meeting', false)!.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.find((l) => l.type === 'segment').speaker_label, 'Lin');
    assert.equal(lines.find((l) => l.type === 'summary').stale_reason, 'speaker_labels_changed');
    assert.equal(lines.find((l) => l.type === 'handoff').freshness.stale, true);
    assert.equal(store.segments('meeting')[0].text, raw.text);
    assert.equal(store.segments('meeting')[0].t_start, raw.t_start);
  } finally { store.close(); }
});

test('unanalysed lines carry no tag, budgets count tags, first labels keep AI output, relabels mark it stale', async () => {
  const { totalChars, renderSegments } = await import('../server/ai/context.ts');
  const store = new Store(':memory:');
  try {
    meeting(store);
    const long = segment(store, 0, 9000); // one voice for 4 s, then a pause or music
    segment(store, 9000, 10000);
    assert.equal(store.segments('meeting')[0].speaker_state, null, 'never analysed: no "unknown" state');
    assert.equal(formatSeg(store.segments('meeting')[0]), `[0:00] ${long.text}`);
    store.insertOutput({ id: 'early', session_id: 'meeting', kind: 'digest', status: 'done', content: 'Notes before labels.', covered_from: 0, covered_to: 9000 });

    run(store, 'g1', [turn('x', 500, 4500), turn('y', 9000, 9300)], [{ source: 'mic', start_ms: 0, end_ms: 10000 }]);
    const [a, b] = store.segments('meeting');
    assert.equal(a.speaker_state, 'assigned', 'the only voice in a fully analysed line is its speaker, even under half its length');
    assert.equal(b.speaker_state, 'unknown', 'a short covered fraction is still too little evidence');
    assert.equal(store.getOutput('early')?.stale_reason ?? null, null, 'output from before any labels is not wrong, so it is kept');
    assert.equal(digests(store, 'meeting').length, 1);
    const all = store.segments('meeting');
    assert.equal(totalChars(all), all.map((s) => formatSeg(s).length + 1).reduce((x, y) => x + y));
    assert.equal(renderSegments(all, totalChars(all)).truncated, false, 'a transcript within budget is sent whole');

    store.renameSpeaker('meeting', a.speaker_id!, 'Lin');
    assert.equal(store.getOutput('early')?.stale_reason, 'speaker_labels_changed', 'a rename makes earlier output outdated');
    store.setSpeakerAnalysis('meeting', { status: 'running', generation: 'g2', error: null, updated_at: Date.now() });
    assert.equal(store.applySpeakerTurns('meeting', 'stale-generation', [], [{ source: 'mic', start_ms: 0, end_ms: 10000 }]), false, 'a superseded result reports that nothing was applied');
  } finally { store.close(); }
});
