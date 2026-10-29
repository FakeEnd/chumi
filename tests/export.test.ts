import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type HandoffItemRow } from '../server/db.ts';
import { exportName, exportSession } from '../server/export.ts';

test('export filenames use the same local date as the header across UTC date boundaries', () => {
  const previousTZ = process.env.TZ;
  const store = new Store(':memory:');
  try {
    store.createSession({ id: 's', title: 'Lab meeting', type: 'lab_meeting', audio_source: 'mic' });
    for (const [tz, timestamp, expected] of [
      ['America/Chicago', '2026-10-22T01:30:00Z', '2026-10-21'],
      ['Asia/Shanghai', '2026-10-21T23:00:00Z', '2026-10-22'],
      ['America/Chicago', '2027-01-01T02:00:00Z', '2026-12-31'],
      ['Asia/Shanghai', '2026-12-31T23:00:00Z', '2027-01-01'],
    ]) {
      process.env.TZ = tz;
      const time = Date.parse(timestamp);
      store.updateSession('s', { started_at: time, created_at: time + 3 * 86400_000 });
      assert.equal(exportName(store.getSession('s')!), `${expected} Lab meeting`, tz);
      for (const format of ['md', 'txt'] as const) {
        const exported = exportSession(store, 's', format);
        assert.equal(exported.filename, `${expected} Lab meeting.${format}`, tz);
        assert.ok(exported.body.includes(`- Date: ${new Date(time).toLocaleString()}`));
      }
      store.updateSession('s', { started_at: null, created_at: time });
      assert.equal(exportName(store.getSession('s')!), `${expected} Lab meeting`, 'creation date is the fallback');
    }
    store.updateSession('s', { title: '模型 / meeting:*?' });
    assert.equal(exportName(store.getSession('s')!), '2027-01-01 模型  meeting');
  } finally {
    store.close();
    if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ;
  }
});

function handoff(store: Store, status: 'confirmed' | 'draft' = 'confirmed') {
  store.createSession({ id: 's', title: 'Lab meeting', type: 'lab_meeting', audio_source: 'mic' });
  store.createHandoff({ id: 'h', session_id: 's', project_id: null, status });
  store.updateHandoff('h', { confirmed_at: 1000, confirmed_revision: store.getSession('s')!.revision });
}
function item(store: Store, patch: Partial<HandoffItemRow>) {
  store.insertHandoffItem({
    id: 'action', handoff_id: 'h', project_id: null, kind: 'action', position: 0, text: 'Validate the holdout split',
    rationale: 'Check generalization', conditions_json: '["Wait for the dataset"]', acceptance_json: '["Plot held-out error"]',
    origin: 'suggested', owner: 'Maya', due: 'Friday', evidence_json: '[{"kind":"transcript","segment_ids":[1],"from_ms":1000,"to_ms":3000}]',
    review: 'confirmed', edited: 0, ...patch,
  });
}

test('Markdown and text exports include reviewed decisions, actions and questions with their context', () => {
  const store = new Store(':memory:');
  try {
    handoff(store);
    item(store, {});
    item(store, { id: 'decision', kind: 'decision', position: 1, text: 'Keep the baseline', origin: 'agreed' });
    item(store, { id: 'question', kind: 'question', position: 2, text: 'Which cohort is next?', origin: 'user' });
    item(store, { id: 'rejected', text: 'Rejected task', review: 'rejected' });
    item(store, { id: 'pending', text: 'Pending task', review: 'pending' });
    for (const format of ['md', 'txt'] as const) {
      const { body } = exportSession(store, 's', format);
      for (const text of ['Handoff (reviewed)', 'Decisions', 'Actions', 'Open questions', 'Validate the holdout split', 'Keep the baseline', 'Which cohort is next?',
        'Maya', 'Friday', 'Check generalization', 'Wait for the dataset', 'Plot held-out error', 'suggested in the meeting', '0:01–0:03']) assert.ok(body.includes(text), text);
      assert.doesNotMatch(body, /Rejected task|Pending task|draft, unreviewed|meeting revision/);
      if (format === 'txt') assert.doesNotMatch(body, /^#{1,6} /m);
    }
  } finally { store.close(); }
});

test('unfinished handoffs export as unreviewed drafts with per-item review, excluding rejected items', () => {
  const store = new Store(':memory:');
  try {
    handoff(store, 'draft');
    item(store, { review: 'pending' });
    item(store, { id: 'kept', text: 'Already reviewed item', review: 'confirmed' });
    item(store, { id: 'rejected', text: 'Rejected task', review: 'rejected' });
    for (const status of ['draft', 'generating', 'error'] as const) {
      store.updateHandoff('h', { status });
      for (const format of ['md', 'txt'] as const) {
        const { body } = exportSession(store, 's', format);
        assert.match(body, /Handoff \(draft, unreviewed\)/);
        assert.match(body, /not confirmed/);
        assert.match(body, /Validate the holdout split/);
        assert.match(body, /Already reviewed item/);
        assert.match(body, /Review: pending/);
        assert.match(body, /Review: confirmed/);
        assert.doesNotMatch(body, /Handoff \(reviewed\)|Rejected task/);
      }
    }
  } finally { store.close(); }
});

test('empty failed or still-generating handoffs do not add a draft section to exports', () => {
  const store = new Store(':memory:');
  try {
    handoff(store, 'draft');
    for (const status of ['error', 'generating'] as const) {
      store.updateHandoff('h', { status });
      for (const format of ['md', 'txt'] as const) assert.doesNotMatch(exportSession(store, 's', format).body, /Handoff|handoff items/);
    }
    item(store, { review: 'rejected' });
    assert.doesNotMatch(exportSession(store, 's', 'md').body, /Handoff|handoff items/);
  } finally { store.close(); }
});

test('reviewed handoff exports retain notices when the meeting changes or moves projects', () => {
  const store = new Store(':memory:');
  try {
    handoff(store); item(store, {});
    store.addSegment({ session_id: 's', t_start: 0, t_end: 1000, text: 'Later discussion', lang: null, source: 'mic', run: 0 });
    assert.match(exportSession(store, 's', 'md').body, /meeting has changed since/);
    store.createProject({ id: 'p', name: 'P', workspace: '/tmp/chumi-export-project' });
    store.assignSession('s', 'p');
    assert.match(exportSession(store, 's', 'txt').body, /project.*review/i);
  } finally { store.close(); }
});

test('export descriptions cover any speech engine and list captures without local paths', () => {
  const store = new Store(':memory:');
  try {
    store.createSession({ id: 's', title: 'Lab meeting', type: 'lab_meeting', audio_source: 'mic' });
    store.addSegment({ session_id: 's', t_start: 1000, t_end: 3000, text: 'Original speech', lang: 'en', source: 'mic', run: 0 });
    store.addFrame({ session_id: 's', t: 1000, path: '/Users/private-user/Library/Application Support/Chumi/frames/a.jpg', width: 10, height: 10, kind: 'slide', window_title: 'Experiment slides', app: 'Zoom' });
    store.addFrame({ session_id: 's', t: 2000, path: 'C:\\Users\\private-user\\Chumi\\frames\\b.jpg', width: 10, height: 10, kind: 'snapshot', window_title: null, app: null });
    for (const source of ['mic', 'both', 'mobile']) {
      store.updateSession('s', { audio_source: source });
      for (const format of ['md', 'txt'] as const) {
        const { body } = exportSession(store, 's', format);
        assert.match(body, /raw automatic speech recognition/);
        assert.match(body, /images are stored on this computer/);
        assert.match(body, /\[0:01\] Experiment slides/);
        assert.match(body, /\[0:02\] Window capture \(on-demand capture\)/);
        assert.match(body, /Original speech/);
        assert.doesNotMatch(body, /local Whisper|this Mac|private-user|a\.jpg|b\.jpg|Handoff/);
      }
    }
  } finally { store.close(); }
});
