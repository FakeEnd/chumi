import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Store } from '../server/db.ts';
import { MobileError, MobileSessions, mobileSnapshot, type MobileSnapshot } from '../server/mobile/sessions.ts';
import { startMobileServer, type MobileServerOptions } from '../server/mobile/server.ts';
import { loadMobileConfiguration, setupMobileConfiguration } from '../server/mobile-config.ts';

function snapshot(patch: Partial<MobileSnapshot> = {}): MobileSnapshot {
  return { clientId: randomUUID(), revision: 1, title: 'Phone lab meeting', type: 'lab_meeting',
    startedAt: 1_790_000_000_000, durationMs: 4000, status: 'ended', projectId: null,
    segments: [{ id: 'seg-a', tStart: 0, tEnd: 3000, text: '我们需要 rerun the holdout experiment.', lang: 'zh' }], ...patch };
}
function expectError(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof MobileError && e.code === code);
}
function fakeAssistant(store: Store) {
  const calls: Array<{ action: string; sessionId: string; question?: string; projectContext?: boolean; scope?: string }> = [];
  const output = (sessionId: string, kind: string) => {
    const id = `out_${randomUUID()}`;
    store.insertOutput({ id, session_id: sessionId, kind, status: 'done', content: '来自手机 transcript 的答案。', provider: 'mock' });
    return id;
  };
  const assistant: MobileServerOptions['assistant'] = {
    ask(sessionId, question, _selection, _depth, _frames, _effort, opts) {
      calls.push({ action: 'ask', sessionId, question, projectContext: opts?.projectContext });
      return output(sessionId, 'answer');
    },
    catchup(sessionId, scope) { calls.push({ action: 'catchup', sessionId, scope }); return output(sessionId, 'catchup'); },
    summary(sessionId) { calls.push({ action: 'summary', sessionId }); return output(sessionId, 'final_summary'); },
  };
  return { assistant, calls };
}

test('mobile snapshots validate IDs, timestamps, status, types and unique ordered finalized segments', () => {
  const good = snapshot();
  assert.equal(mobileSnapshot({ ...good, clientId: good.clientId.toUpperCase(), projectId: undefined, segments: [{ ...good.segments[0], lang: undefined }] }).segments[0].lang, null);
  const bad: unknown[] = [null, [], { ...good, clientId: '../desktop' }, { ...good, revision: 0 }, { ...good, revision: 1.2 },
    { ...good, status: 'interrupted' }, { ...good, type: 'unrecognized' }, { ...good, title: '' }, { ...good, durationMs: Infinity },
    { ...good, segments: [{ ...good.segments[0], tEnd: 5000 }] }, { ...good, segments: [good.segments[0], good.segments[0]] },
    { ...good, segments: [{ ...good.segments[0], tStart: 2000 }, { ...good.segments[0], id: 'b', tStart: 1000 }] },
    { ...good, segments: [{ ...good.segments[0], text: '\0' }] }];
  for (const value of bad) expectError(() => mobileSnapshot(value), 'invalid_request');
});

test('mobile ingest persists ownership and retries across restart without duplicated segments or changed evidence IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-mobile-'));
  let store = new Store(join(dir, 'data.sqlite'));
  try {
    const originalSchema = store.schemaVersion();
    let mobile = new MobileSessions(store);
    const initial = snapshot();
    const accepted = mobile.ingest(initial);
    const originalId = store.segments(accepted.sessionId)[0].id;
    assert.equal(store.getSession(accepted.sessionId)!.audio_source, 'mobile');
    assert.equal(store.schemaVersion(), originalSchema, 'the companion does not change desktop migration version');
    assert.equal(mobile.ingest(initial).status, 'unchanged');
    store.close();
    store = new Store(join(dir, 'data.sqlite'));
    mobile = new MobileSessions(store);
    assert.equal(mobile.ingest(initial).sessionId, accepted.sessionId);
    const next = { ...initial, revision: 3, durationMs: 6000, segments: [...initial.segments, { id: 'b', tStart: 4000, tEnd: 6000, text: 'Use chr8 as holdout.', lang: 'en' }] };
    const newer = mobile.ingest(next);
    assert.equal(newer.sessionId, accepted.sessionId);
    assert.equal(store.segments(accepted.sessionId).length, 2);
    assert.equal(store.segments(accepted.sessionId)[0].id, originalId, 'existing evidence IDs remain stable');
    expectError(() => mobile.ingest(initial), 'stale_revision');
    expectError(() => mobile.ingest({ ...next, title: 'different' }), 'revision_conflict');
    assert.deepEqual(mobile.detail(accepted.sessionId).segments, next.segments);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('mobile snapshots cannot address desktop sessions, replace finalized text, shrink duration or partially write an invalid snapshot', () => {
  const store = new Store(':memory:');
  try {
    const mobile = new MobileSessions(store);
    const desktopId = randomUUID();
    store.createSession({ id: desktopId, title: 'Private desktop', type: 'advisor', audio_source: 'mic' });
    const initial = snapshot({ clientId: desktopId });
    const saved = mobile.ingest({ ...initial, id: desktopId, sessionId: desktopId });
    assert.notEqual(saved.sessionId, desktopId);
    assert.equal(store.getSession(desktopId)!.title, 'Private desktop');
    expectError(() => mobile.detail(desktopId), 'not_found');
    expectError(() => mobile.ingest({ ...initial, revision: 2, segments: [] }), 'segment_conflict');
    expectError(() => mobile.ingest({ ...initial, revision: 2, segments: [{ ...initial.segments[0], text: 'Rewritten' }] }), 'segment_conflict');
    expectError(() => mobile.ingest({ ...initial, revision: 2, durationMs: 3000 }), 'session_conflict');
    expectError(() => mobile.ingest({ ...initial, revision: 2, startedAt: initial.startedAt + 1 }), 'session_conflict');
    expectError(() => mobile.ingest({ ...initial, revision: 2, title: 'Overwrite', projectId: 'missing' }), 'invalid_project');
    assert.equal(mobile.detail(saved.sessionId).session.title, initial.title);
    assert.equal(mobile.detail(saved.sessionId).session.revision, 1);
    expectError(() => mobile.ingest(snapshot({ projectId: 'missing' })), 'invalid_project');
    assert.equal(store.listSessions().length, 2, 'no partially created session survives a rollback');
  } finally { store.close(); }
});

test('mobile metadata merges phone changes without undoing Mac edits across retries and restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-mobile-metadata-'));
  let store = new Store(join(dir, 'data.sqlite'));
  try {
    store.createProject({ id: 'p1', name: 'Thesis', workspace: '/project' });
    let mobile = new MobileSessions(store);
    const initial = snapshot();
    const { sessionId } = mobile.ingest(initial);
    store.updateSession(sessionId, { title: 'Renamed on Mac', type: 'advisor' });
    store.assignSession(sessionId, 'p1');
    const expected = { title: 'Renamed on Mac', type: 'advisor', projectId: 'p1' };
    assert.deepEqual(mobile.ingest(initial).metadata, expected, 'even a retry returns current Mac metadata');
    store.close();
    store = new Store(join(dir, 'data.sqlite'));
    mobile = new MobileSessions(store);
    const next = { ...initial, revision: 2, segments: [...initial.segments, { id: 'note', tStart: 3000, tEnd: 4000, text: 'One more note.', lang: null }] };
    assert.deepEqual(mobile.ingest(next).metadata, expected);
    assert.equal(store.getSession(sessionId)!.title, expected.title);
    assert.equal(store.getSession(sessionId)!.type, expected.type);
    assert.equal(store.getSession(sessionId)!.project_id, expected.projectId);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM session_project_log WHERE session_id = ?').get(sessionId) as { n: number }).n, 1);
    assert.deepEqual(mobile.ingest({ ...next, revision: 3, title: 'Renamed on phone' }).metadata, { ...expected, title: 'Renamed on phone' });
    assert.deepEqual(mobile.ingest({ ...next, revision: 4, title: 'Renamed on phone', type: 'lecture', projectId: 'p1' }).metadata,
      { title: 'Renamed on phone', type: 'lecture', projectId: 'p1' });
    assert.equal(mobile.ingest({ ...next, revision: 5, title: 'Renamed on phone', type: 'lecture' }).metadata.projectId, null, 'explicit phone unassignment still works');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('old mobile ledgers preserve Mac metadata while establishing the first phone baseline', () => {
  for (const retryFirst of [false, true]) {
    const store = new Store(':memory:');
    try {
      let mobile = new MobileSessions(store);
      const initial = snapshot();
      const { sessionId } = mobile.ingest(initial);
      store.db.exec('ALTER TABLE mobile_sessions DROP COLUMN phone_metadata');
      store.updateSession(sessionId, { title: 'Mac title', type: 'advisor' });
      mobile = new MobileSessions(store);
      if (retryFirst) assert.equal(mobile.ingest(initial).metadata.title, 'Mac title');
      assert.equal(mobile.ingest({ ...initial, revision: 2 }).metadata.title, 'Mac title');
      assert.equal(mobile.ingest({ ...initial, revision: 3, title: 'New phone title' }).metadata.title, 'New phone title');
      assert.equal(store.getSession(sessionId)!.type, 'advisor');
    } finally { store.close(); }
  }
});

test('unchanged phone project does not restore a project removed on the Mac', () => {
  const store = new Store(':memory:');
  try {
    store.createProject({ id: 'p1', name: 'Research', workspace: '/project' });
    const mobile = new MobileSessions(store);
    const initial = snapshot({ projectId: 'p1' });
    const { sessionId } = mobile.ingest(initial);
    store.assignSession(sessionId, null);
    store.updateProject('p1', { archived_at: Date.now() });
    assert.equal(mobile.ingest({ ...initial, revision: 2 }).metadata.projectId, null);
  } finally { store.close(); }
});

test('mobile session lifecycle and explicit phone project changes are synced', () => {
  const store = new Store(':memory:');
  try {
    store.createProject({ id: 'p1', name: 'Research', workspace: '/project' });
    store.createProject({ id: 'archived', name: 'Old project', workspace: '/old' });
    store.updateProject('archived', { archived_at: Date.now() });
    const mobile = new MobileSessions(store);
    const s = snapshot({ status: 'recording', projectId: 'p1' });
    const { sessionId } = mobile.ingest(s);
    mobile.ingest({ ...s, revision: 2, status: 'paused' });
    mobile.ingest({ ...s, revision: 3, status: 'recording' });
    mobile.ingest({ ...s, revision: 4, status: 'ended', projectId: null });
    assert.equal(store.getSession(sessionId)!.ended_at, s.startedAt + s.durationMs);
    assert.equal(store.getSession(sessionId)!.project_id, null);
    assert.deepEqual(store.timeline(sessionId).map((e) => e.kind), ['start', 'pause', 'resume', 'stop']);
    expectError(() => mobile.ingest({ ...s, revision: 5, projectId: 'archived' }), 'invalid_project');
    store.deleteSession(sessionId);
    expectError(() => mobile.detail(sessionId), 'not_found');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM mobile_segments').get() as { n: number }).n, 0);
  } finally { store.close(); }
});

test('mobile listener requires TLS for non-loopback and rejects weak pairing tokens before listening', async () => {
  const store = new Store(':memory:');
  const { assistant } = fakeAssistant(store);
  try {
    await assert.rejects(startMobileServer({ store, assistant, host: '0.0.0.0', port: 0, token: 'x'.repeat(40) }), /requires TLS/);
    await assert.rejects(startMobileServer({ store, assistant, host: 'localhost', port: 0, token: 'x'.repeat(40) }), /requires TLS/);
    await assert.rejects(startMobileServer({ store, assistant, port: 0, token: 'short' }), /token/);
  } finally { store.close(); }
});

test('revision recovery keeps old evidence and a new client ID preserves both conflicting copies', () => {
  const store = new Store(':memory:');
  try {
    const mobile = new MobileSessions(store);
    const original = snapshot({ revision: 8 });
    const { sessionId } = mobile.ingest(original);
    const restored = { ...original, revision: 2, segments: [...original.segments, { id: 'note', tStart: 3000, tEnd: 4000, text: 'Restored note.', lang: null }] };
    assert.throws(() => mobile.ingest(restored), (e: unknown) => e instanceof MobileError && e.code === 'stale_revision' && e.details.revision === 8);
    assert.equal(mobile.ingest({ ...restored, revision: 9 }).sessionId, sessionId);
    const conflict = { ...restored, revision: 10, segments: [{ ...original.segments[0], text: 'Text from an older backup.' }] };
    expectError(() => mobile.ingest(conflict), 'segment_conflict');
    const copy = mobile.ingest({ ...conflict, clientId: randomUUID() });
    assert.notEqual(copy.sessionId, sessionId);
    assert.deepEqual(mobile.detail(sessionId).segments, restored.segments);
    assert.deepEqual(mobile.detail(copy.sessionId).segments, conflict.segments);
    assert.equal(store.listSessions().length, 2);
  } finally { store.close(); }
});

test('mobile HTTP revision conflicts keep the current revision at the top level', async () => {
  const store = new Store(':memory:');
  const { assistant } = fakeAssistant(store);
  const token = 'test-token-'.repeat(5);
  const mobile = await startMobileServer({ store, assistant, token, port: 0 });
  const sync = (body: MobileSnapshot) => fetch(mobile.url + '/mobile/v1/sessions', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const initial = snapshot({ revision: 8 });
    assert.equal((await sync(initial)).status, 200);
    const stale = await sync({ ...initial, revision: 2 });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: 'A newer snapshot is already stored.', code: 'stale_revision', revision: 8 });
    const conflict = await sync({ ...initial, title: 'Changed at the same revision' });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'This revision was already used for different content.', code: 'revision_conflict', revision: 8 });
  } finally { await mobile.close(); store.close(); }
});

test('an AI request for a deleted Mac copy can recover by syncing and using the new session ID', async () => {
  const store = new Store(':memory:');
  const { assistant, calls } = fakeAssistant(store);
  const token = 'test-token-'.repeat(5);
  const mobile = await startMobileServer({ store, assistant, token, port: 0 });
  const post = (path: string, body: unknown) => fetch(mobile.url + '/mobile/v1' + path, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const initial = snapshot();
    const saved = await (await post('/sessions', initial)).json() as { sessionId: string };
    store.deleteSession(saved.sessionId);
    const missing = await post(`/sessions/${saved.sessionId}/summary`, {});
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Mobile session not found.', code: 'not_found' });
    const detail = await fetch(mobile.url + `/mobile/v1/sessions/${saved.sessionId}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(detail.status, 404);
    assert.deepEqual(await detail.json(), { error: 'Mobile session not found.', code: 'not_found' });
    assert.equal(calls.length, 0);
    const restored = await (await post('/sessions', initial)).json() as { sessionId: string };
    assert.notEqual(restored.sessionId, saved.sessionId);
    assert.equal((await post(`/sessions/${restored.sessionId}/summary`, {})).status, 202);
    assert.equal(calls[0].sessionId, restored.sessionId);
    assert.deepEqual(new MobileSessions(store).detail(restored.sessionId).segments, initial.segments);
  } finally { await mobile.close(); store.close(); }
});

test('mobile HTTPS listener serves authenticated requests with the generated pairing certificate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chumi-mobile-tls-'));
  const store = new Store(':memory:');
  const { assistant } = fakeAssistant(store);
  let mobile: Awaited<ReturnType<typeof startMobileServer>> | undefined;
  try {
    setupMobileConfiguration({ directory, address: '127.0.0.1' });
    const config = loadMobileConfiguration(join(directory, 'companion.json'));
    mobile = await startMobileServer({ store, assistant, token: config.token, tls: config.tls, port: 0 });
    const response = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = httpsRequest(mobile!.url + '/mobile/v1/health', { ca: config.tls.cert, headers: { authorization: `Bearer ${config.token}` } }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
        res.on('error', reject);
      });
      req.on('error', reject); req.end();
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, version: 1 });
  } finally { await mobile?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('mobile HTTP authentication, browser rejection and endpoint allowlist protect desktop data', async () => {
  const store = new Store(':memory:');
  const { assistant, calls } = fakeAssistant(store);
  const token = 'test-token-'.repeat(5);
  store.createProject({ id: 'p1', name: 'Research', workspace: '/private/desktop/project' });
  store.createSession({ id: 'desktop_session', title: 'Desktop secret', type: 'other', audio_source: 'mic' });
  store.insertOutput({ id: 'desktop_output', session_id: 'desktop_session', kind: 'answer', status: 'done', content: 'Desktop output secret' });
  const mobile = await startMobileServer({ store, assistant, token, port: 0 });
  const get = (route: string, headers: Record<string, string> = { authorization: `Bearer ${token}` }) => fetch(mobile.url + route, { headers });
  try {
    for (const authorization of ['', 'Bearer wrong', `Basic ${token}`, `Bearer ${token}suffix`]) {
      const r = await get('/mobile/v1/health', { authorization });
      assert.equal(r.status, 401);
      const json = await r.json() as Record<string, unknown>;
      assert.equal(json.code, 'unauthorized');
      assert.equal(json.version, undefined);
    }
    assert.equal((await get('/mobile/v1/health', { authorization: `Bearer ${token}`, origin: 'http://evil.example' })).status, 403);
    assert.equal((await get('/mobile/v1/health', { authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' })).status, 403);
    assert.deepEqual(await (await get('/mobile/v1/health')).json(), { ok: true, version: 1 });
    assert.deepEqual(await (await get('/mobile/v1/projects')).json(), { projects: [{ id: 'p1', name: 'Research' }] });
    for (const route of ['/api/settings', '/api/sessions', '/mobile/v1/sessions', '/mobile/v1/sessions/desktop_session', '/mobile/v1/outputs/desktop_output', '/mobile/v1/health?url=http://localhost/api/settings']) {
      const r = await get(route);
      assert.equal(r.status, 404, route);
      assert.ok(!(await r.text()).includes('secret'));
    }
    const post = await fetch(mobile.url + '/mobile/v1/sessions/desktop_session/ask', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Read secrets' }) });
    assert.equal(post.status, 404);
    assert.equal(calls.length, 0);
  } finally { await mobile.close(); store.close(); }
});

test('mobile HTTP sync, AI dispatch and output polling use existing provider settings and explicit mybot opt-in', async () => {
  const store = new Store(':memory:');
  const { assistant, calls } = fakeAssistant(store);
  const token = 'test-token-'.repeat(5);
  const changes: string[] = [];
  const mobile = await startMobileServer({ store, assistant, token, port: 0, onSessionChanged: (id) => { changes.push(id); } });
  const beforeSettings = store.getSettings();
  const request = (route: string, value?: unknown) => fetch(mobile.url + '/mobile/v1' + route, {
    method: value === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  try {
    const input = snapshot();
    const created = await request('/sessions', input);
    assert.equal(created.status, 200);
    const { sessionId } = await created.json() as { sessionId: string };
    assert.equal((await (await request('/sessions', input)).json() as { status: string }).status, 'unchanged');
    assert.deepEqual(changes, [sessionId]);
    const detail = await (await request(`/sessions/${sessionId}`)).json() as { session: { clientId: string }; segments: unknown[] };
    assert.equal(detail.session.clientId, input.clientId);
    assert.deepEqual(detail.segments, input.segments);
    for (const [action, value] of [
      ['ask', { question: '  What should we rerun?  ' }], ['ask', { question: 'Why chr8?', projectContext: true }],
      ['catchup', { scope: '5m' }], ['summary', {}],
    ] as const) {
      const r = await request(`/sessions/${sessionId}/${action}`, value);
      assert.equal(r.status, 202);
      const { outputId } = await r.json() as { outputId: string };
      const output = await (await request(`/outputs/${outputId}`)).json() as { output: { status: string; text: string; sessionId: string } };
      assert.equal(output.output.status, 'done');
      assert.equal(output.output.sessionId, sessionId);
      assert.match(output.output.text, /手机/);
    }
    assert.equal(calls[0].question, 'What should we rerun?');
    assert.equal(calls[0].projectContext, false);
    assert.equal(calls[1].projectContext, true);
    assert.equal(calls[2].scope, '5m');
    assert.deepEqual(store.getSettings(), beforeSettings);
    assert.equal((await request(`/sessions/${sessionId}/ask`, { question: 'x', projectContext: 'yes' })).status, 400);
    assert.equal((await request(`/sessions/${sessionId}/catchup`, { scope: 'forever' })).status, 400);
    assert.equal(calls.length, 4);
  } finally { await mobile.close(); store.close(); }
});

test('mobile HTTP rejects malformed, non-JSON, compressed and oversized bodies without creating meetings', async () => {
  const store = new Store(':memory:');
  const { assistant } = fakeAssistant(store);
  const token = 'test-token-'.repeat(5);
  const mobile = await startMobileServer({ store, assistant, token, port: 0 });
  try {
    const send = (body: string, headers: Record<string, string> = {}) => fetch(mobile.url + '/mobile/v1/sessions', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body,
    });
    assert.equal((await send('{broken')).status, 400);
    assert.equal((await send('[]')).status, 400);
    assert.equal((await send('{}', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await send('{}', { 'content-encoding': 'gzip' })).status, 415);
    assert.equal((await send('x'.repeat(4 * 1024 * 1024 + 1))).status, 413);
    const streamedStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(mobile.url + '/mobile/v1/sessions', { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      for (let i = 0; i < 65; i++) req.write(Buffer.alloc(64 * 1024, 32));
      req.end();
    });
    assert.equal(streamedStatus, 413, 'the size limit also applies without Content-Length');
    assert.equal(store.listSessions().length, 0);
  } finally { await mobile.close(); store.close(); }
});
