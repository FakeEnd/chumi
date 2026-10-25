import { api, subscribe } from './api.ts';
import { getState, notify, setState, type AppState } from './store.ts';
import { projectContextOn } from './projectContext.ts';
import { saveCompact } from './compactMode.ts';
import { t } from './i18n.ts';
import { emptySnapshotChanges, mergeSnapshotChanges, snapshotDeltas, type SnapshotChanges } from './sessionSnapshot.ts';
import type { SpeakerAnnotation, SpeakerCorrection, SpeakerView } from '../../shared/speakers.ts';
import type { AgentId } from '../../shared/agents.ts';
import type { Depth, Effort, Frame, Handoff, Output, Profile, Project, Segment, SessionData, Settings, SpeakerUpdate, WindowInfo } from './types.ts';

let navigationVersion = 0;
let stateRequest = 0;
interface SessionRequest {
  id: string; navigation: boolean; fromView: string | null; controller: AbortController;
  changes: SnapshotChanges; retry: boolean;
}
let sessionRequest: SessionRequest | null = null;

export async function loadState(): Promise<void> {
  const request = ++stateRequest;
  const before = getState(), initial = !before.loaded, navigation = navigationVersion;
  const s = await api('/api/state');
  if (request !== stateRequest) return;
  const latest = getState();
  const live = latest.live && latest.live.serverTime > (s.live?.serverTime ?? 0) ? latest.live : s.live;
  setState({
    loaded: true,
    settings: latest.settings === before.settings ? s.settings : latest.settings,
    profile: latest.profile === before.profile ? s.profile : latest.profile,
    provider: latest.provider === before.provider ? s.provider : latest.provider,
    live, liveReceivedAt: Date.now(), partials: latest.partials === before.partials ? live?.partials ?? {} : latest.partials,
    devMode: s.devMode, helperBuilt: s.helperBuilt, platform: s.platform ?? '', screenToolBuilt: s.screenToolBuilt, hotkey: s.hotkey ?? null, appMode: s.appMode, dataDir: s.dataDir, samples: s.samples ?? [], systemLanguage: s.systemLanguage ?? '',
  });
  // Deep links (?session=<id>&dialog=settings&tab=ai) open a view directly; used for scripted screenshots too.
  const q = new URLSearchParams(location.search);
  void loadProjects();
  const want = q.get('session');
  if (initial && navigation === navigationVersion && want && !getState().viewId) {
    // Evidence links from agents: ?session=…&t=…&t2=… focuses a passage, &frame=… opens a capture.
    const t = Number(q.get('t')), t2 = Number(q.get('t2')), frame = Number(q.get('frame'));
    const focus = q.get('t') && Number.isFinite(t) ? { t, t2: q.get('t2') && Number.isFinite(t2) ? t2 : undefined } : undefined;
    await openSession(want, focus).catch(() => {});
    if (getState().viewId === want && q.get('frame') && Number.isFinite(frame)) setState({ dialog: 'frame', frameView: frame });
  }
  const dlg = q.get('dialog');
  if (initial && dlg && ['profile', 'settings', 'history', 'start', 'window'].includes(dlg)) setState({ dialog: dlg as AppState['dialog'], settingsTab: q.get('tab') ?? 'language' });
  // A live session opens directly; otherwise start on the Home screen (recent sessions are listed there).
  const liveId = getState().live?.session?.id ?? null;
  if (initial && navigation === navigationVersion && liveId && !getState().viewId) await openSession(liveId);
  else if (getState().viewId) await refreshSession(getState().viewId!);
}

/** focus: a passage to scroll to and highlight (evidence links), set together with the data so nothing scrolls past it. */
export async function openSession(id: string, focus?: { t: number; t2?: number }): Promise<void> {
  ++navigationVersion;
  await fetchSession(id, true, focus);
}

/** Refresh server data in place: the reader's scroll/focus, draft and selected passage stay intact. */
export async function refreshSession(id: string): Promise<void> {
  if (getState().viewId !== id) return;
  if (sessionRequest?.navigation) { invalidateSnapshot(id); return; }
  await fetchSession(id, false);
}

export function goHome(): void {
  ++navigationVersion;
  sessionRequest?.controller.abort(); sessionRequest = null;
  setState({ viewId: null, data: null, deltas: {}, focus: null, attached: null });
}

async function fetchSession(id: string, navigation: boolean, focus?: { t: number; t2?: number }): Promise<void> {
  sessionRequest?.controller.abort();
  const request: SessionRequest = { id, navigation, fromView: getState().viewId, controller: new AbortController(), changes: emptySnapshotChanges(), retry: false };
  sessionRequest = request;
  try {
    while (sessionRequest === request) {
      request.retry = false; request.changes = emptySnapshotChanges();
      const snapshot = await api<SessionData>(`/api/sessions/${id}`, { signal: request.controller.signal });
      if (sessionRequest !== request || getState().viewId !== request.fromView) return;
      // Titles, project assignments, speaker corrections and handoffs have no common event cursor.
      // Re-read after those infrequent changes; append-only events and output progress can be merged safely.
      if (request.retry) continue;
      const data = mergeSnapshotChanges(snapshot, request.changes);
      const current = getState();
      const switching = current.viewId !== id;
      setState({
        viewId: id, data, deltas: snapshotDeltas(data, current.deltas),
        ...(switching ? { focus: null, attached: null } : {}),
        ...(focus ? { focus: { ...focus, nonce: Date.now() } } : {}),
      });
      return;
    }
  } catch (error) {
    if (sessionRequest === request && getState().viewId === id && (error as { status?: number }).status === 404) { goHome(); return; }
    if (!request.controller.signal.aborted) throw error;
  } finally {
    if (sessionRequest === request) sessionRequest = null;
  }
}

function invalidateSnapshot(id: string | undefined): void {
  if (id && sessionRequest?.id === id) sessionRequest.retry = true;
}

function receiveContent(kind: keyof SnapshotChanges, item: Segment | Frame | Output): void {
  if (sessionRequest?.id === item.session_id) (sessionRequest.changes[kind] as Array<Segment | Frame | Output>).push(item);
  setState((s) => {
    if (s.data?.session.id !== item.session_id) return {};
    const changes = emptySnapshotChanges();
    (changes[kind] as Array<Segment | Frame | Output>).push(item);
    const data = mergeSnapshotChanges(s.data, changes);
    const deltas = { ...s.deltas };
    if (kind === 'outputs' && data.outputs.some((o) => o.id === item.id && o.status !== 'pending' && o.status !== 'streaming')) delete deltas[item.id];
    return { data, ...(kind === 'outputs' ? { deltas } : {}) };
  });
}

export function connectEvents(): () => void {
  return subscribe({
    hello: (d) => setState({ live: d.live, liveReceivedAt: Date.now() }),
    live: (live) => {
      invalidateSnapshot(live.session?.id);
      invalidateSnapshot(getState().live?.session?.id);
      const prev = getState().live;
      setState({ live, liveReceivedAt: Date.now(), partials: live.partials ?? {} });
      const id = live.session?.id;
      if (id && id !== prev?.session?.id) void openSession(id).catch((e) => notify('error', (e as Error).message));
      if (id && getState().data?.session.id === id) setState((s) => ({ data: s.data ? { ...s.data, session: live.session, live: true } : s.data }));
    },
    tick: (t) => setState((s) => ({ live: s.live ? { ...s.live, nowT: t.nowT, asr: { ...s.live.asr, ...t.asr } } : s.live, liveReceivedAt: Date.now() })),
    level: (l) => setState((s) => ({ levels: { ...s.levels, [l.source]: { rms: l.rms, peak: l.peak, at: Date.now() } } })),
    partial: (p) => setState((s) => s.live?.session?.id === p.sessionId ? { partials: { ...s.partials, [p.source]: { uttId: p.uttId, t: p.t, text: p.text } } } : {}),
    'partial-clear': (p) => setState((s) => {
      if (s.live?.session?.id !== p.sessionId) return {};
      const cur = s.partials[p.source];
      if (!cur || cur.uttId > p.uttId) return {};
      const next = { ...s.partials }; delete next[p.source]; return { partials: next };
    }),
    segment: (seg: Segment) => receiveContent('segments', seg),
    ai: (o: Output) => receiveContent('outputs', o),
    frame: (f: Frame) => receiveContent('frames', f),
    'ai-delta': (d: { id: string; delta: string }) => setState((s) => {
      const output = s.data?.outputs.find((o) => o.id === d.id);
      if (output && output.status !== 'pending' && output.status !== 'streaming') return {};
      return { deltas: { ...s.deltas, [d.id]: (s.deltas[d.id] ?? '') + d.delta } };
    }),
    provider: (p) => setState({ provider: p }),
    hotkey: (h) => setState({ hotkey: h }),
    'asr-download': (d) => setState({ asrDownload: d }),
    settings: (st: Settings) => setState({ settings: st }),
    profile: (p: Profile) => setState({ profile: p }),
    notice: (n) => notify(n.level, n.message, n.code),
    asr: (a) => setState((s) => ({ live: s.live ? { ...s.live, asr: { ...s.live.asr, state: a.state, message: a.message } } : s.live })),
    'session-ended': (e) => { invalidateSnapshot(e.sessionId); void refreshSession(e.sessionId).catch((err) => notify('error', (err as Error).message)); bumpSessions(); notify('info', t('Session saved. Preparing the final summary…'), 'ended'); },
    'session-updated': (sess) => {
      invalidateSnapshot(sess.id);
      setState((s) => ({ sessionsRev: s.sessionsRev + 1, ...(s.data && s.data.session.id === sess.id ? { data: { ...s.data, session: sess } } : {}) }));
    },
    'session-deleted': (e: { id: string }) => {
      if (sessionRequest?.id === e.id) { sessionRequest.controller.abort(); sessionRequest = null; }
      if (getState().viewId === e.id) goHome();
      bumpSessions();
    },
    handoff: (e: { sessionId: string; handoff: Handoff | null }) => setHandoff(e.sessionId, e.handoff),
    speakers: (e: SpeakerUpdate) => mergeSpeakerUpdate(e),
    projects: () => void loadProjects(),
  }, (ok) => {
    setState({ connected: ok });
    if (ok) void loadState().catch((e) => notify('error', (e as Error).message));
    else { ++stateRequest; if (sessionRequest) sessionRequest.retry = true; }
  });
}

const guard = async <T>(p: Promise<T>): Promise<T | undefined> => {
  try { return await p; } catch (e) { notify('error', (e as Error).message, 'action'); return undefined; }
};

export async function startSession(o: { title: string; type: string; source: string; filePath?: string; speed?: number; window?: { id: number; title: string; app: string } | null; project_id?: string | null; record_audio?: boolean }): Promise<boolean> {
  if (o.source === 'mic' || o.source === 'both') {
    const perm = await api<Record<string, string>>('/api/audio/permissions').catch(() => ({} as Record<string, string>));
    if (perm.microphone === 'denied' || perm.microphone === 'restricted') {
      notify('error', getState().platform === 'win32' ? t('Microphone access is blocked. Allow desktop apps in Windows Settings → Privacy & security → Microphone, then try again.') : t('Microphone access is blocked. Open System Settings → Privacy & Security → Microphone and enable Chumi (or the terminal app you launched it from), then try again.'), 'mic_permission_denied');
      return false;
    }
  }
  const r = await guard(api('/api/session/start', { body: o }));
  if (r) { setState({ dialog: null }); await openSession(r.session.id); }
  return !!r;
}
export async function quickStart(): Promise<void> {
  const r = await guard(api('/api/session/quick-start', { body: {} }));
  if (r?.session) await openSession(r.session.id);
}
export const pauseSession = () => guard(api('/api/session/pause', { body: {} }));
export const resumeLive = () => guard(api('/api/session/resume', { body: {} }));
export async function endSession(): Promise<void> {
  const r = await guard(api('/api/session/end', { body: {} }));
  if (r?.sessionId) await guard(refreshSession(r.sessionId));
}
export const resumeSaved = (id: string, source: string) => guard(api(`/api/sessions/${id}/resume`, { body: { source } }));

function current(): string | null { return getState().data?.session.id ?? null; }
export const catchup = (scope: '2m' | '5m' | 'all') => { const id = current(); if (id) void guard(api('/api/ai/catchup', { body: { sessionId: id, scope } })); };
export const ask = async (question: string, selection: { fromT: number; toT: number; text: string } | null, depth: Depth, frameIds: number[] = [], effort?: Effort): Promise<boolean> => { const id = current(); return !!id && !!await guard(api('/api/ai/ask', { body: { sessionId: id, question, selection, depth, frameIds, effort, projectContext: projectContextOn(id) && !!getState().data?.session.project_id } })); };
export const setWindow = (w: WindowInfo | null) => guard(api('/api/session/window', { body: { window: w ? { id: w.id, title: w.title, app: w.app } : null } }));
export const frameUrl = (id: number) => `/api/frames/${id}`;
export const explain = async (term: string, selection: { fromT: number; toT: number; text: string } | null, depth: Depth, parentId?: string, effort?: Effort): Promise<boolean> => { const id = current(); return !!id && !!await guard(api('/api/ai/explain', { body: { sessionId: id, term, selection, depth, parentId, effort } })); };

/** A failed submission stays editable; a late success cannot erase work typed or selected after sending. */
export async function submitQuestion(question: string, mode: 'ask' | 'explain', depth: Depth, effort?: Effort): Promise<{ accepted: boolean; cleared: boolean }> {
  const before = getState(), navigation = navigationVersion, text = question.trim();
  if (!before.data || (!text && !before.attached)) return { accepted: false, cleared: false };
  const accepted = mode === 'explain'
    ? await explain(text || before.attached!.text.slice(0, 80), before.attached, depth, undefined, effort)
    : await ask(text || t('What does this passage mean?'), before.attached, depth, [], effort);
  let cleared = false;
  if (accepted) setState((s) => {
    if (navigation !== navigationVersion || s.viewId !== before.viewId || s.askDraft !== before.askDraft || s.attached !== before.attached) return {};
    cleared = true;
    return { askDraft: question === before.askDraft ? '' : s.askDraft, attached: null };
  });
  return { accepted, cleared };
}
export const recap = () => { const id = current(); if (id) void guard(api('/api/ai/recap', { body: { sessionId: id } })); };
export const summarize = () => { const id = current(); if (id) void guard(api('/api/ai/summary', { body: { sessionId: id } })); };
export const refreshOutput = (oid: string) => void guard(api(`/api/ai/outputs/${oid}/refresh`, { body: {} }));
export const cancelOutput = (oid: string) => void guard(api(`/api/ai/outputs/${oid}/cancel`, { body: {} }));

export async function saveSettings(patch: Record<string, unknown>): Promise<boolean> {
  const r = await guard(api<Settings>('/api/settings', { method: 'PUT', body: patch }));
  if (r) setState({ settings: r });
  return !!r;
}
export async function saveProfile(p: Profile, quiet = false): Promise<boolean> {
  const r = await guard(api<Profile>('/api/profile', { method: 'PUT', body: p }));
  if (r) { setState({ profile: r }); if (!quiet) notify('info', t('Profile saved.')); }
  return !!r;
}
export async function renameSession(id: string, patch: { title?: string; type?: string }): Promise<void> { await guard(api(`/api/sessions/${id}`, { method: 'PATCH', body: patch })); }
export async function deleteSession(id: string): Promise<boolean> {
  const r = await guard(api(`/api/sessions/${id}`, { method: 'DELETE' }));
  if (r && getState().viewId === id) goHome();
  if (r) bumpSessions();
  return !!r;
}
/** Every session list (Home, History) reloads when this changes. */
export const bumpSessions = () => setState((s) => ({ sessionsRev: s.sessionsRev + 1 }));
/** Compact view on or off (the session view only: the home page always shows the header). */
export function setCompact(on: boolean): void { saveCompact(on); setState({ compact: on }); }
export function exportUrl(id: string, format: 'md' | 'txt'): string { return `/api/sessions/${id}/export?format=${format}`; }
/** Encoding a long recording takes a few seconds: prepare it first (with errors shown), then download it. */
export async function exportAudio(id: string): Promise<void> {
  if (!await guard(api(`/api/sessions/${id}/audio/export`, { body: {} }))) return;
  const a = document.createElement('a');
  a.href = `/api/sessions/${id}/audio/export`; a.download = '';
  document.body.append(a); a.click(); a.remove();
}
export async function refreshProvider(): Promise<void> { const p = await guard(api('/api/provider/status?refresh=1')); if (p) setState({ provider: p }); }

// Speaker updates replace annotations without resetting the viewed passage or attached question.
export function mergeSpeakerUpdate(update: SpeakerUpdate): void {
  invalidateSnapshot(update.sessionId);
  setState((s) => {
    if (!s.data || s.data.session.id !== update.sessionId || update.session.revision < s.data.session.revision) return {};
    // Keep unchanged objects, so memoized transcript rows and cards only re-render where something changed.
    const byId = new Map(update.annotations.map((a) => [a.id, a]));
    const same = (seg: Segment, a: SpeakerAnnotation) => seg.speaker_id === a.speaker_id && seg.speaker_label === a.speaker_label && seg.speaker_state === a.speaker_state && seg.speaker_origin === a.speaker_origin;
    const segments = s.data.segments.map((seg) => { const a = byId.get(seg.id); return !a || same(seg, a) ? seg : { ...seg, ...a }; });
    const outputs = s.data.outputs.map((o) => o.id in update.stale && (o.stale_reason ?? null) !== update.stale[o.id] ? { ...o, stale_reason: update.stale[o.id] } : o);
    const speakerView = s.data.speakerView && JSON.stringify(s.data.speakerView) === JSON.stringify(update.speakerView) ? s.data.speakerView : update.speakerView;
    return {
      data: { ...s.data, speakerView, segments, session: update.session, handoff: update.handoff, outputs },
      ...(s.live?.session?.id === update.sessionId ? { live: { ...s.live, session: update.session } } : {}),
    };
  });
}
export async function refreshSpeakers(sessionId: string): Promise<SpeakerView> {
  const revision = getState().data?.session.id === sessionId ? getState().data?.session.revision : undefined;
  const speakerView = await api<SpeakerView>(`/api/sessions/${sessionId}/speakers`);
  setState((s) => s.data?.session.id === sessionId && s.data.session.revision === revision && (s.data.speakerView?.analysis.updated_at ?? 0) <= (speakerView.analysis.updated_at ?? 0) ? { data: { ...s.data, speakerView } } : {});
  return speakerView;
}
async function mutateSpeakers(path: string, method: string, body: unknown): Promise<void> {
  mergeSpeakerUpdate(await api<SpeakerUpdate>(path, { method, body }));
}
export const analyzeSpeakers = (sessionId: string) => mutateSpeakers(`/api/sessions/${sessionId}/speakers/analyze`, 'POST', {});
export const cancelSpeakers = (sessionId: string) => mutateSpeakers(`/api/sessions/${sessionId}/speakers/cancel`, 'POST', {});
export const renameSpeaker = (sessionId: string, speakerId: string, name: string | null) => mutateSpeakers(`/api/sessions/${sessionId}/speakers/${encodeURIComponent(speakerId)}`, 'PATCH', { name });
export const correctSpeaker = (sessionId: string, segmentId: number, correction: SpeakerCorrection) => mutateSpeakers(`/api/sessions/${sessionId}/segments/${segmentId}/speaker`, 'PATCH', correction);

// ---------------------------------------------------------------- projects
export async function loadProjects(): Promise<void> {
  const r = await api<{ projects: Project[] }>('/api/projects?archived=1').catch(() => null);
  if (r) setState({ projects: r.projects });
}
export async function createProject(name: string, workspace: string): Promise<Project | undefined> {
  const r = await guard(api<{ project: Project }>('/api/projects', { body: { name, workspace } }));
  await loadProjects();
  return r?.project;
}
export async function updateProject(id: string, patch: { name?: string; workspace?: string; archived?: boolean }): Promise<boolean> {
  const r = await guard(api(`/api/projects/${id}`, { method: 'PATCH', body: patch }));
  await loadProjects();
  return !!r;
}
/** macOS folder picker (returns null when cancelled). */
export async function chooseFolder(): Promise<string | null> {
  const r = await guard(api<{ path?: string; cancelled?: boolean }>('/api/projects/choose-folder', { body: {} }));
  return r?.path ?? null;
}
export async function assignProject(sessionId: string, projectId: string | null): Promise<void> {
  await guard(api(`/api/sessions/${sessionId}/project`, { body: { project_id: projectId } }));
  void loadProjects();
}

// ---------------------------------------------------------------- reviewed handoff
function setHandoff(sessionId: string, handoff: Handoff | null): void {
  invalidateSnapshot(sessionId);
  setState((s) => (s.data && s.data.session.id === sessionId ? { data: { ...s.data, handoff } } : {}));
}
async function withHandoff<T extends { handoff: Handoff | null }>(p: Promise<T>): Promise<T | undefined> {
  const r = await guard(p);
  if (r?.handoff) setHandoff(r.handoff.session_id, r.handoff);
  return r;
}
export const prepareHandoff = (sessionId: string) => withHandoff(api(`/api/sessions/${sessionId}/handoff`, { body: {} }));
export const updateHandoffItem = (id: string, patch: Record<string, unknown>) => withHandoff(api(`/api/handoff-items/${id}`, { method: 'PATCH', body: patch }));
export const addHandoffItem = (handoffId: string, kind: string, text: string) => withHandoff(api(`/api/handoffs/${handoffId}/items`, { body: { kind, text } }));
export const confirmHandoff = (handoffId: string) => withHandoff(api(`/api/handoffs/${handoffId}/confirm`, { body: {} }));
export const reopenHandoff = (handoffId: string) => withHandoff(api(`/api/handoffs/${handoffId}/reopen`, { body: {} }));
export const retargetHandoff = (handoffId: string) => withHandoff(api(`/api/handoffs/${handoffId}/retarget`, { body: {} }));
export async function continueHandoff(handoffId: string, agent: AgentId | 'copy'): Promise<{ prompt: string; launched: boolean } | undefined> {
  const r = await withHandoff(api<{ prompt: string; launched: boolean; handoff: Handoff }>(`/api/handoffs/${handoffId}/continue`, { body: { agent } }));
  return r ? { prompt: r.prompt, launched: r.launched } : undefined;
}
