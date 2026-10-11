import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'chumi-mybot-test-'));
process.env.CHUMI_DATA_DIR = dir;
const { Store } = await import('../server/db.ts');
const { MybotExporter, sessionToJsonl } = await import('../server/integrations/mybot.ts');

test('mybot export: chumi-transcript/1 JSONL, private by default, removed on delete', () => {
  const store = new Store(join(dir, 'test.db'));
  const s = store.createSession({ id: 's_test', title: 'Advisor 1:1', type: 'advisor', audio_source: 'mic' });
  store.addSegment({ session_id: s.id, t_start: 1000, t_end: 5000, text: 'Please rerun with the chromosome holdout.', lang: 'en', source: 'mic', run: 1 });
  store.addSegment({ session_id: s.id, t_start: 6000, t_end: 9000, text: '好的，我下周给你结果。', lang: 'zh', source: 'mic', run: 1 });
  assert.equal(sessionToJsonl(store, s.id, false), null, 'live sessions are not exported');
  store.updateSession(s.id, { status: 'ended', ended_at: Date.now(), duration_ms: 9000 });
  store.insertOutput({ id: 'o1', session_id: s.id, kind: 'final_summary', status: 'done', content: '## Overview\nRerun requested [0:01].' });
  store.insertOutput({ id: 'o2', session_id: s.id, kind: 'answer', status: 'done', question: 'What did they ask?', content: 'A rerun [0:01].', covered_from: 0, covered_to: 9000 });
  const lines = sessionToJsonl(store, s.id, false)!.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'session');
  assert.equal(lines[0].format, 'chumi-transcript/1');
  assert.equal(lines[0].visibility, 'private');
  assert.deepEqual(lines.map((l) => l.type), ['session', 'segment', 'segment', 'qa', 'summary']);
  assert.equal(JSON.parse(sessionToJsonl(store, s.id, true)!.split('\n')[0]).visibility, 'shared');

  store.saveSettings({ ...store.getSettings(), integrations: { mybot: { enabled: true, exportDir: join(dir, 'exports'), shareWithTeam: false } } });
  const ex = new MybotExporter(store);
  assert.equal(ex.exportAll().exported, 1);
  const file = join(dir, 'exports', 's_test.jsonl');
  assert.ok(readFileSync(file, 'utf8').includes('chromosome holdout'));
  ex.remove(s.id);
  assert.equal(existsSync(file), false);
  store.close();
});
