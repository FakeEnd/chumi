import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import type { AppState } from '../web/src/store.ts';
import type { Frame, Output, Segment, SessionData, SpeakerUpdate } from '../web/src/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function segment(id: number, session_id = 'a'): Segment {
  return { id, session_id, t_start: id * 1000, t_end: id * 1000 + 900, text: `Line ${id}`, lang: 'en', source: 'mic', run: 0 } as Segment;
}
function output(status: string, id = 'answer', session_id = 'a'): Output {
  return { id, session_id, kind: 'answer', status, content: status === 'done' ? 'Full answer' : null, completed_at: status === 'done' ? 20 : null, created_at: 10, stale_reason: null } as Output;
}
function session(id = 'a'): SessionData {
  return {
    session: { id, revision: 1, status: 'recording', title: id, type: 'lab_meeting', created_at: 0, started_at: 0, ended_at: null, last_activity_at: 1, audio_source: 'mic', duration_ms: 2000, project_id: null },
    segments: [segment(1, id)], outputs: [], frames: [], timeline: [], live: true, handoff: null,
  };
}

interface Actions {
  loadState(): Promise<void>;
  openSession(id: string): Promise<void>;
  refreshSession(id: string): Promise<void>;
  goHome(): void;
  connectEvents(): () => void;
  endSession(): Promise<void>;
  submitQuestion(question: string, mode: 'ask' | 'explain', depth: 'standard'): Promise<{ accepted: boolean; cleared: boolean }>;
}

// Execute the shipped action functions with deterministic HTTP/SSE/store adapters, without a browser,
// live server or AI provider. Each test gets fresh module-level request and navigation state.
const source = stripTypeScriptTypes(readFileSync(new URL('../web/src/actions.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
function harness(initial: Partial<AppState> = {}) {
  let state = {
    loaded: true, connected: true, viewId: 'a', data: session(), deltas: {}, focus: null, attached: null,
    askDraft: '', partials: {}, sessionsRev: 0, projects: [], settings: null, profile: null, provider: null,
    live: { session: session().session, status: 'recording', serverTime: 1, partials: {} }, ...initial,
  } as AppState;
  let handlers: Record<string, (data: any) => void> = {}, connection: (ok: boolean) => void = () => {};
  const calls: Array<{ path: string; options: any }> = [], notices: string[] = [];
  const replies = new Map<string, Array<unknown>>();
  const api = async (path: string, options: any = {}) => {
    calls.push({ path, options });
    const queued = replies.get(path);
    if (queued?.length) return await queued.shift();
    if (path === '/api/state') return { live: state.live, settings: state.settings, profile: state.profile, provider: state.provider };
    if (path.startsWith('/api/projects')) return { projects: [] };
    throw new Error(`Unexpected request: ${path}`);
  };
  const setState = (patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  // The same as store.ts's upsertOutput, against this harness's state.
  const upsertOutput = (o: Output) => setState((s) => {
    const deltas = { ...s.deltas } as Record<string, string>;
    if (o.status !== 'streaming' && o.status !== 'pending') delete deltas[o.id];
    if (!s.data || s.data.session.id !== o.session_id) return { deltas };
    const outs = s.data.outputs.slice();
    const i = outs.findIndex((x) => x.id === o.id);
    if (i >= 0) outs[i] = o; else outs.push(o);
    return { data: { ...s.data, outputs: outs }, deltas };
  });
  const dependencies = {
    api, getState: () => state, setState, upsertOutput, notify: (_level: string, message: string) => notices.push(message),
    subscribe: (events: typeof handlers, conn: typeof connection) => { handlers = events; connection = conn; return () => {}; },
    projectContextOn: () => false, t: (text: string) => text, saveCompact: () => {},
    location: { search: '', pathname: '/', hash: '' }, history: { state: null, replaceState: () => {} },
  };
  const actions = new Function(...Object.keys(dependencies), `${source}\nreturn { loadState, openSession, refreshSession, goHome, connectEvents, endSession, submitQuestion };`)(...Object.values(dependencies)) as Actions;
  actions.connectEvents();
  return {
    actions, calls, notices, get: () => state, set: setState,
    reply: (path: string, ...values: unknown[]) => replies.set(path, [...(replies.get(path) ?? []), ...values]),
    emit: (event: string, data: unknown) => handlers[event](data), connection: (ok: boolean) => connection(ok),
  };
}

test('reconnection refreshes the open session without losing the reader or composer state', async () => {
  const focus = { t: 1000, nonce: 4 }, attached = { fromT: 1000, toT: 2000, text: 'Selected passage' };
  const old = session(); old.outputs = [output('streaming'), output('streaming', 'still-writing')];
  const h = harness({ data: old, focus, attached, askDraft: 'My draft', deltas: { answer: 'Partial', 'still-writing': 'Keep this text' } });
  const fresh = session(); fresh.segments.push(segment(2)); fresh.outputs = [output('done'), output('streaming', 'still-writing')];
  h.reply('/api/sessions/a', fresh);
  h.connection(false); h.connection(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.get().data?.segments.map((s) => s.id), [1, 2]);
  assert.equal(h.get().data?.outputs[0].status, 'done');
  assert.equal(h.get().focus, focus);
  assert.equal(h.get().attached, attached);
  assert.equal(h.get().askDraft, 'My draft');
  assert.deepEqual(h.get().deltas, { 'still-writing': 'Keep this text' });
});

test('events racing a snapshot are merged exactly once and finished outputs stay finished', async () => {
  const h = harness(), pending = deferred<SessionData>();
  h.reply('/api/sessions/a', pending.promise);
  const refresh = h.actions.refreshSession('a');
  const frame = { id: 1, session_id: 'a', t: 2000 } as Frame;
  h.emit('segment', segment(2)); h.emit('frame', frame);
  h.emit('ai', output('pending')); h.emit('ai', output('streaming'));
  h.emit('ai-delta', { id: 'answer', delta: 'Earlier streamed text' });
  const fresh = session(); fresh.segments.push(segment(2)); fresh.frames.push(frame); fresh.outputs = [output('done')];
  pending.resolve(fresh); await refresh;
  assert.deepEqual(h.get().data?.segments.map((s) => s.id), [1, 2]);
  assert.equal(h.get().data?.frames.length, 1);
  assert.equal(h.get().data?.outputs[0].status, 'done');
  assert.deepEqual(h.get().deltas, {});
  h.emit('segment', segment(2)); h.emit('ai', output('streaming'));
  assert.equal(h.get().data?.segments.length, 2);
  assert.equal(h.get().data?.outputs[0].status, 'done');
});

test('content and final answers arriving after an older snapshot are not overwritten', async () => {
  const h = harness(), pending = deferred<SessionData>();
  h.reply('/api/sessions/a', pending.promise);
  const refresh = h.actions.refreshSession('a');
  h.emit('segment', segment(3)); h.emit('segment', segment(2));
  h.emit('ai', output('done'));
  const old = session(); old.outputs = [output('pending')];
  pending.resolve(old); await refresh;
  assert.deepEqual(h.get().data?.segments.map((s) => s.id), [1, 2, 3]);
  assert.equal(h.get().data?.outputs[0].status, 'done');
});

test('project, handoff and speaker changes during a snapshot are reconciled with another read', async () => {
  const original = session(); original.outputs = [output('done')];
  const h = harness({ data: original }), pending = deferred<SessionData>();
  const corrected = session();
  corrected.session = { ...corrected.session, revision: 3, project_id: 'project-b' };
  corrected.outputs = [{ ...output('done'), stale_reason: 'speaker_labels_changed' }];
  const update = {
    sessionId: 'a', session: corrected.session, annotations: [], stale: { answer: 'speaker_labels_changed' },
    speakerView: { analysis: { updated_at: 30 } }, handoff: null,
  } as unknown as SpeakerUpdate;
  corrected.speakerView = update.speakerView;
  h.reply('/api/sessions/a', pending.promise, corrected);
  const refresh = h.actions.refreshSession('a');
  h.emit('session-updated', corrected.session); h.emit('speakers', update); h.emit('handoff', { sessionId: 'a', handoff: null });
  pending.resolve(original); await refresh;
  assert.equal(h.calls.filter((c) => c.path === '/api/sessions/a').length, 2);
  assert.equal(h.get().data?.session.project_id, 'project-b');
  assert.equal(h.get().data?.outputs[0].stale_reason, 'speaker_labels_changed');
  assert.equal(h.get().data?.speakerView?.analysis.updated_at, 30);
});

test('older navigation and refresh responses cannot replace a newer session or Home', async () => {
  const h = harness(), older = deferred<SessionData>(), newer = deferred<SessionData>();
  h.reply('/api/sessions/b', older.promise); h.reply('/api/sessions/c', newer.promise);
  const first = h.actions.openSession('b'), second = h.actions.openSession('c');
  newer.resolve(session('c')); await second;
  older.resolve(session('b')); await first;
  assert.equal(h.get().viewId, 'c');
  const refreshResult = deferred<SessionData>(); h.reply('/api/sessions/c', refreshResult.promise);
  const refresh = h.actions.refreshSession('c'); h.actions.goHome();
  refreshResult.resolve(session('c')); await refresh;
  assert.equal(h.get().viewId, null);
  const fromHome = deferred<SessionData>(); h.reply('/api/sessions/b', fromHome.promise);
  const open = h.actions.openSession('b'); h.actions.goHome();
  fromHome.resolve(session('b')); await open;
  assert.equal(h.get().data, null);
});

test('deleted sessions cannot be resurrected by an outstanding snapshot', async () => {
  const h = harness(), pending = deferred<SessionData>();
  h.reply('/api/sessions/a', pending.promise);
  const refresh = h.actions.refreshSession('a');
  h.emit('session-deleted', { id: 'a' });
  pending.resolve(session()); await refresh;
  assert.equal(h.get().viewId, null);
  assert.equal(h.get().data, null);
});

test('a deletion missed while disconnected clears the unavailable session on refresh', async () => {
  const h = harness(), pending = deferred<SessionData>();
  h.reply('/api/sessions/a', pending.promise);
  const refresh = h.actions.refreshSession('a');
  pending.reject(Object.assign(new Error('Session not found'), { status: 404 }));
  await refresh;
  assert.equal(h.get().viewId, null);
  assert.equal(h.get().data, null);
});

test('end-session response leaves another viewed session alone', async () => {
  const h = harness(), pending = deferred<unknown>();
  h.reply('/api/session/end', pending.promise); h.reply('/api/sessions/b', session('b'));
  const end = h.actions.endSession();
  await h.actions.openSession('b');
  pending.resolve({ sessionId: 'a', summaryId: null }); await end;
  assert.equal(h.get().viewId, 'b');
  assert.equal(h.calls.some((c) => c.path === '/api/sessions/a'), false);
});

test('partial speech from another session cannot overwrite or clear the live partial', () => {
  const h = harness({ partials: { mic: { uttId: 1, t: 10, text: 'Current' } } });
  h.emit('partial', { sessionId: 'older', source: 'mic', uttId: 2, t: 20, text: 'Stale' });
  h.emit('partial-clear', { sessionId: 'older', source: 'mic', uttId: 2 });
  assert.equal(h.get().partials.mic.text, 'Current');
  h.emit('partial-clear', { sessionId: 'a', source: 'mic', uttId: 1 });
  assert.deepEqual(h.get().partials, {});
});

for (const mode of ['ask', 'explain'] as const) {
  test(`failed ${mode} submission preserves the draft and attached passage for retry`, async () => {
    const attached = { fromT: 1000, toT: 2000, text: 'Evidence' };
    const h = harness({ askDraft: 'A long question', attached }), pending = deferred<unknown>();
    h.reply(`/api/ai/${mode}`, pending.promise);
    const submission = h.actions.submitQuestion('A long question', mode, 'standard');
    assert.equal(h.get().askDraft, 'A long question');
    pending.reject(new Error('Temporarily unavailable'));
    assert.deepEqual(await submission, { accepted: false, cleared: false });
    assert.equal(h.get().askDraft, 'A long question');
    assert.equal(h.get().attached, attached);
    assert.deepEqual(h.notices, ['Temporarily unavailable']);
    h.reply(`/api/ai/${mode}`, { id: 'accepted' });
    assert.deepEqual(await h.actions.submitQuestion('A long question', mode, 'standard'), { accepted: true, cleared: true });
    assert.equal(h.get().askDraft, ''); assert.equal(h.get().attached, null);
  });
}

test('successful submission preserves newer input, newer selections and drafts after a session round trip', async () => {
  for (const change of ['draft', 'selection', 'session'] as const) {
    const attached = { fromT: 1000, toT: 2000, text: 'Evidence' };
    const h = harness({ askDraft: 'Original', attached }), pending = deferred<unknown>();
    h.reply('/api/ai/ask', pending.promise);
    const submission = h.actions.submitQuestion('Original', 'ask', 'standard');
    if (change === 'draft') h.set({ askDraft: 'New question' });
    if (change === 'selection') h.set({ attached: { ...attached, text: 'New evidence' } });
    if (change === 'session') {
      h.reply('/api/sessions/b', session('b')); h.reply('/api/sessions/a', session());
      await h.actions.openSession('b'); await h.actions.openSession('a'); h.set({ attached });
    }
    const before = h.get();
    pending.resolve({ id: 'accepted' });
    assert.deepEqual(await submission, { accepted: true, cleared: false });
    assert.equal(h.get().askDraft, before.askDraft); assert.equal(h.get().attached, before.attached);
  }
});

test('a quick suggestion does not discard an unrelated draft', async () => {
  const h = harness({ askDraft: 'Still composing this question' });
  h.reply('/api/ai/ask', { id: 'accepted' });
  assert.equal((await h.actions.submitQuestion('What is the key point?', 'ask', 'standard')).accepted, true);
  assert.equal(h.get().askDraft, 'Still composing this question');
});

test('handoff progress merging keeps newer saves but respects hidden or reassigned progress', () => {
  const progress = { status: 'completed', note: 'Private result from project A', results: [], updatedAt: 1, version: 7 };
  const handoff = (patch: Record<string, unknown> = {}) => ({ id: 'h', session_id: 'a', items: [{ id: 'item', project_id: 'project-a', text: 'Original task', progress, ...patch }] }) as unknown as NonNullable<SessionData['handoff']>;
  const data = session(); data.handoff = handoff();
  const h = harness({ data });
  h.emit('handoff', { sessionId: 'a', handoff: handoff({ progress: { ...progress, note: 'Older save', version: 6 } }) });
  assert.equal(h.get().data?.handoff?.items[0].progress?.version, 7);
  h.emit('handoff', { sessionId: 'a', handoff: handoff({ progress: null }) });
  assert.equal(h.get().data?.handoff?.items[0].progress, null, 'server eligibility removal must not restore old progress');
  for (const patch of [{ project_id: 'project-b' }, { text: 'A different task' }]) {
    h.set({ data: { ...data, handoff: handoff() } });
    h.emit('handoff', { sessionId: 'a', handoff: handoff({ ...patch, progress: { ...progress, note: '', version: 0 } }) });
    assert.equal(h.get().data?.handoff?.items[0].progress?.note, '', 'old progress belongs to the original project and task');
  }
});

test('capture recovery clears the obsolete crash banner and preserves unrelated notices', () => {
  const f = harness({ notices: [
    { id: 1, code: 'capture_stopped', level: 'error', message: 'Restarting', at: 0 },
    { id: 2, code: 'other', level: 'error', message: 'Unrelated', at: 0 },
  ] });
  f.emit('notice', { code: 'capture_restarted', level: 'info', message: 'Audio capture restarted. Recording continues.' });
  assert.deepEqual(f.get().notices.map((n) => n.code), ['other']);
});


test('merged transcription gaps replace their previous timeline entries', () => {
  const h = harness();
  h.emit('timeline', { id: 1, session_id: 'a', kind: 'gap', t: 0, detail: '0–1' });
  h.emit('timeline', { id: 2, session_id: 'a', kind: 'gap', t: 2000, detail: '2–3' });
  h.emit('timeline', { id: 1, session_id: 'a', kind: 'gap', t: 0, detail: '0–3', replaces: [1, 2] });
  assert.equal(h.get().data?.timeline.length, 1);
  assert.equal(h.get().data?.timeline[0].detail, '0–3');
});
