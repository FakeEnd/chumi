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

test('mobile session lifecycle and explicit project assignment retain phone ownership', () => {
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
