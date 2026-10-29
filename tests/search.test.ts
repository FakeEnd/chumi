import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.ts';
import { Evidence } from '../server/projects/evidence.ts';

function meeting(store: Store, id: string, lines: string[] = [], title = 'Meeting', projectId?: string) {
  store.createSession({ id, title, type: 'lab_meeting', audio_source: 'mic' });
  if (projectId) store.assignSession(id, projectId);
  for (const [i, text] of lines.entries()) store.addSegment({ session_id: id, t_start: i * 1000, t_end: (i + 1) * 1000, text, lang: null, source: 'mic', run: 0 });
}
const ids = (store: Store, query?: string, projectId?: string) => store.listSessions(query, projectId).map((s) => s.id).sort();

test('meeting search requires every word in any order across titles, transcript lines and outputs', () => {
  const store = new Store(':memory:');
  try {
    meeting(store, 'transcript', ['The schedule for the learning rate needs another look.']);
    meeting(store, 'title', [], 'Rate learning: schedule');
    meeting(store, 'summary');
    store.insertOutput({ id: 'summary', session_id: 'summary', kind: 'final_summary', status: 'done', content: 'Schedule another look at the rate of learning.' });
    meeting(store, 'spread', ['Learning from the data.', 'Change the rate.'], 'Schedule');
    meeting(store, 'mixed', ['Check the learning.'], 'Schedule');
    store.insertOutput({ id: 'mixed', session_id: 'mixed', kind: 'overview', status: 'done', content: 'Reduce the rate.' });
    meeting(store, 'partial', ['Learning rate is fine.']);
    assert.deepEqual(ids(store, '  learning\tRATE  schedule '), ['mixed', 'spread', 'summary', 'title', 'transcript']);
    assert.deepEqual(ids(store, 'learning learning rate schedule'), ['mixed', 'spread', 'summary', 'title', 'transcript']);
    assert.deepEqual(ids(store, 'learning rate missing'), []);
    assert.equal(store.listSessions('learning rate schedule').every((s) => !!s.snippet), true);
  } finally { store.close(); }
});

test('short words and CJK terms return matching transcript evidence, including mixed queries', () => {
  const store = new Store(':memory:');
  try {
    store.createProject({ id: 'p', name: 'Project', workspace: '/tmp/chumi-search-project' });
    meeting(store, 's', ['模型需要验证', 'The learning rate needs a change.', '模型 learning'], 'Meeting', 'p');
    meeting(store, 'partial', ['模型'], 'Meeting', 'p');
    const evidence = new Evidence(store, (sid) => `http://test/?session=${sid}`);
    const found = evidence.searchMeetings({ project_id: 'p', query: '模型' });
    assert.equal(found.total, 2);
    assert.equal(found.meetings.every((m) => m.matches.length > 0 && m.matches.every((g) => g.text.includes('模型'))), true);
    assert.deepEqual(ids(store, '模型 learning'), ['s']);
    assert.deepEqual(ids(store, '模 验'), ['s']);
    const matches = store.searchSegments('s', ['learning', '模型', '模型'], 12);
    assert.equal(matches.length, 3);
    assert.equal(new Set(matches.map((s) => s.id)).size, 3);
    assert.equal(store.searchSegments('s', ['模型'], 1).length, 1);
    assert.deepEqual(store.searchSegments('s', [' ', '']), []);
  } finally { store.close(); }
});

test('frequent transcript hits cannot hide other meetings or exhaust a project search', () => {
  const store = new Store(':memory:');
  try {
    store.createProject({ id: 'p', name: 'P', workspace: '/tmp/chumi-search-p' });
    store.createProject({ id: 'q', name: 'Q', workspace: '/tmp/chumi-search-q' });
    meeting(store, 'busy', Array(600).fill('dataset 实验'), 'Meeting', 'q');
    meeting(store, 'quiet', ['A longer discussion of the dataset and 实验, with much less repetition.'], 'Meeting', 'p');
    meeting(store, 'unassigned', ['dataset 实验']);
    for (const query of ['dataset', '实验', 'dataset 实验']) {
      assert.deepEqual(ids(store, query), ['busy', 'quiet', 'unassigned']);
      assert.deepEqual(ids(store, query, 'p'), ['quiet']);
      assert.deepEqual(ids(store, query, 'none'), ['unassigned']);
      const found = new Evidence(store, (sid) => `http://test/?session=${sid}`).searchMeetings({ project_id: 'p', query });
      assert.equal(found.total, 1);
      assert.equal(found.meetings[0].meeting_id, 'quiet');
      assert.ok(found.meetings[0].matches.length);
    }
    assert.equal(store.listSessions('dataset').find((s) => s.id === 'busy')?.segment_count, 600);
  } finally { store.close(); }
});

test('search returns every matching meeting even beyond the old transcript and output caps', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 510; i++) {
      meeting(store, `s${i}`, ['enhancer activity']);
      store.insertOutput({ id: `o${i}`, session_id: `s${i}`, kind: 'answer', status: 'done', content: 'validation summary' });
    }
    assert.equal(store.listSessions('enhancer activity').length, 510);
    assert.equal(store.listSessions('validation summary').length, 510);
  } finally { store.close(); }
});

test('search treats LIKE wildcards and FTS syntax as literal text', () => {
  const store = new Store(':memory:');
  try {
    meeting(store, 'literal', ['p_value is 5% in C:\\tmp; a "quote" AND OR C++'], 'A_B');
    meeting(store, 'other', ['pXvalue is 50 in C:tmp; a quotation'], 'AXB');
    for (const query of ['p_value', '5%', 'C:\\tmp', '"quote"', 'AND OR', 'A_B', 'C++', '(p_value).', '“5%”', '[C++].']) assert.deepEqual(ids(store, query), ['literal'], query);
    assert.deepEqual(ids(store, 'NOT'), []);
    for (const term of ['%', '_', '\\']) {
      assert.deepEqual(ids(store, term), ['literal'], term);
      assert.equal(store.searchSegments('literal', [term]).length, 0, 'short non-CJK terms do not fill evidence slots');
      assert.equal(store.searchSegments('other', [term]).length, 0);
    }
  } finally { store.close(); }
});

test('search handles keyword punctuation and quoted queries consistently in meeting lists and evidence', () => {
  const store = new Store(':memory:');
  try {
    store.createProject({ id: 'p', name: 'P', workspace: '/tmp/chumi-search-p' });
    meeting(store, 's', ['Validate the split using a holdout.', '训练这个模型'], 'Meeting', 'p');
    const evidence = new Evidence(store, (sid) => `http://test/?session=${sid}`);
    for (const query of ['holdout, split', 'holdout;split', 'holdout，split', 'holdout、split', 'holdout；split', 'split.', '"holdout split"',
      '“holdout split”', '(holdout) [split.]', '【holdout】 《split》！', '模型，训练', '「模型」；（训练）。']) {
      assert.deepEqual(ids(store, query), ['s'], query);
      const result = evidence.searchMeetings({ project_id: 'p', query });
      assert.equal(result.total, 1, query);
      assert.ok(result.meetings[0].matches.length, query);
    }
    for (const query of ['""', '[]', '，；、', '...!?']) assert.deepEqual(ids(store, query), [], query);
  } finally { store.close(); }
});

test('LIKE snippets show the first match late in transcript, output and handoff text', () => {
  const store = new Store(':memory:');
  try {
    const content = `${'Earlier discussion. '.repeat(30)}模型 ab first-hit ${'later discussion '.repeat(30)}模型 ab second-hit`;
    meeting(store, 'transcript', [content]);
    meeting(store, 'output');
    store.insertOutput({ id: 'o', session_id: 'output', kind: 'answer', status: 'done', content });
    meeting(store, 'handoff');
    store.createHandoff({ id: 'h', session_id: 'handoff', project_id: null, status: 'draft' });
    store.insertHandoffItem({ id: 'i', handoff_id: 'h', project_id: null, kind: 'action', position: 0, text: content,
      rationale: null, conditions_json: null, acceptance_json: null, origin: 'agreed', owner: null, due: null, evidence_json: '[]', review: 'pending', edited: 0 });
    for (const query of ['模型', 'AB', 'first-hit']) {
      const found = store.listSessions(query);
      assert.equal(found.length, 3, query);
      for (const s of found) {
        if (query !== 'first-hit' || s.id !== 'transcript') {
          assert.ok(s.snippet?.toLowerCase().includes(query.toLowerCase()), `${query}: ${s.id}`);
          assert.match(s.snippet!, /first-hit/);
          assert.doesNotMatch(s.snippet!, /second-hit/);
          assert.ok(s.snippet!.length <= 160);
        }
      }
    }
  } finally { store.close(); }
});

test('short Latin words do not return unrelated transcript evidence while short CJK terms still do', () => {
  const store = new Store(':memory:');
  try {
    store.createProject({ id: 'p', name: 'P', workspace: '/tmp/chumi-search-p' });
    meeting(store, 's', ['This is a tangent.', 'Another line on something else.', '模型需要验证'], 'A note on what validation is', 'p');
    const evidence = new Evidence(store, (sid) => `http://test/?session=${sid}`);
    const found = evidence.searchMeetings({ project_id: 'p', query: 'a on is validation' });
    assert.equal(found.total, 1, 'title matching still uses short Latin words');
    assert.deepEqual(found.meetings[0].matches, []);
    const cjk = evidence.searchMeetings({ project_id: 'p', query: 'a on is 模型' });
    assert.deepEqual(cjk.meetings[0].matches.map((s) => s.text), ['模型需要验证']);
    assert.deepEqual(store.searchSegments('s', ['a', 'on', 'is', '5%', 'ab']), []);
    assert.equal(store.searchSegments('s', ['模']).length, 1);
  } finally { store.close(); }
});

test('search bounds distinct normalized terms and strips control characters before FTS', () => {
  const store = new Store(':memory:');
  try {
    store.createProject({ id: 'p', name: 'P', workspace: '/tmp/chumi-search-p' });
    const terms = Array.from({ length: 12 }, (_, i) => `keyword${i}`);
    meeting(store, 's', [...terms, 'holdout ab 模型'], 'Meeting', 'p');
    const query = `${terms.map((t) => `"${t}" ${t}`).join(';')} ${Array.from({ length: 500 }, (_, i) => `missing${i}`).join(' ')}`;
    assert.deepEqual(ids(store, query), ['s'], 'duplicates and surrounding punctuation do not consume the term budget');
    const evidence = new Evidence(store, (sid) => `http://test/?session=${sid}`);
    const found = evidence.searchMeetings({ project_id: 'p', query });
    assert.equal(found.total, 1);
    assert.equal(found.meetings[0].matches.length, 3);
    for (const q of ['\u0000ab', 'ho\u0000ldout', '\u0001holdout\u007f', 'holdout\u0080', '模\u0000型']) assert.deepEqual(ids(store, q), ['s'], JSON.stringify(q));
    assert.equal(store.searchSegments('s', ['ho\u0000ldout']).length, 1);
    assert.equal(evidence.searchMeetings({ project_id: 'p', query: '模\u0000型' }).meetings[0].matches.length, 1);
    assert.deepEqual(ids(store, '\u0000\u0001\u007f'), []);
    assert.deepEqual(store.searchSegments('s', ['\u0000']), []);
  } finally { store.close(); }
});

test('meeting search includes only completed visible AI outputs', () => {
  const store = new Store(':memory:');
  try {
    const visible = ['final_summary', 'overview', 'answer', 'explain', 'catchup', 'auto_explain'];
    for (const kind of [...visible, 'digest', 'handoff', 'unknown']) {
      meeting(store, kind);
      store.insertOutput({ id: kind, session_id: kind, kind, status: 'done', content: 'decision action p_value 5% C:\\tmp' });
    }
    for (const status of ['suppressed', 'pending', 'streaming', 'error']) {
      meeting(store, status);
      store.insertOutput({ id: status, session_id: status, kind: 'auto_explain', status, content: 'decision action p_value 5% C:\\tmp' });
    }
    meeting(store, 'lookalike');
    store.insertOutput({ id: 'lookalike', session_id: 'lookalike', kind: 'answer', status: 'done', content: 'pXvalue 50 C:tmp' });
    for (const query of ['decision action', 'p_value', '5%', 'C:\\tmp', '%', '_', '\\']) assert.deepEqual(ids(store, query), [...visible].sort(), query);
    assert.equal(store.listSessions('decision').every((s) => s.snippet?.includes('decision action')), true);
  } finally { store.close(); }
});

test('search finds real handoff items across sources and projects, but excludes rejected items', () => {
  const store = new Store(':memory:');
  try {
    store.createProject({ id: 'p', name: 'P', workspace: '/tmp/chumi-search-p' });
    for (const [sid, review, projectId] of [
      ['reviewed', 'confirmed', 'p'], ['draft', 'pending', 'p'], ['rejected', 'rejected', 'p'], ['unassigned', 'confirmed', undefined],
    ] as const) {
      meeting(store, sid, ['validation'], 'Meeting', projectId);
      store.createHandoff({ id: sid, session_id: sid, project_id: projectId ?? null, status: review === 'confirmed' ? 'confirmed' : 'draft' });
      for (const [position, kind] of (['decision', 'action', 'question'] as const).entries()) store.insertHandoffItem({
        id: `${sid}-${kind}`, handoff_id: sid, project_id: projectId ?? null, kind, position, text: `${kind} holdout p_value 5% C:\\tmp`,
        rationale: null, conditions_json: null, acceptance_json: null, origin: 'agreed', owner: null, due: null,
        evidence_json: '[]', review, edited: 0,
      });
    }
    for (const query of ['decision holdout', 'action holdout', 'question holdout', 'validation holdout', 'p_value', '5%', 'C:\\tmp', '%', '_', '\\']) {
      assert.deepEqual(ids(store, query), ['draft', 'reviewed', 'unassigned'], query);
      assert.deepEqual(ids(store, query, 'p'), ['draft', 'reviewed'], query);
      assert.deepEqual(ids(store, query, 'none'), ['unassigned'], query);
    }
    assert.match(store.listSessions('holdout', 'none')[0].snippet!, /holdout/);
  } finally { store.close(); }
});
