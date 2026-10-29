import { api, subscribe } from './api.ts';
import { getState, notify, setState, upsertOutput, type AppState } from './store.ts';
import { projectContextOn } from './projectContext.ts';
import { saveCompact } from './compactMode.ts';
import { t } from './i18n.ts';
import type { SpeakerAnnotation, SpeakerCorrection, SpeakerView } from '../../shared/speakers.ts';
import type { AgentId } from '../../shared/agents.ts';
import type { ActionProgress } from '../../shared/project-work.ts';
import type { Depth, Effort, Frame, Handoff, Output, Profile, Project, Segment, SessionData, Settings, SpeakerUpdate, WindowInfo } from './types.ts';

let downloadRevision = 0;
export async function loadState(signal?: AbortSignal): Promise<void> {
  const revision = downloadRevision;
  const s = await api('/api/state', { signal });
  if (signal?.aborted) return;
  setState({
    loaded: true, settings: s.settings, profile: s.profile, provider: s.provider, live: s.live, liveReceivedAt: Date.now(), partials: s.live?.partials ?? {},
    devMode: s.devMode, helperBuilt: s.helperBuilt, platform: s.platform ?? '', screenToolBuilt: s.screenToolBuilt, hotkey: s.hotkey ?? null, appMode: s.appMode, dataDir: s.dataDir, samples: s.samples ?? [], systemLanguage: s.systemLanguage ?? '',
    ...(revision === downloadRevision ? { asrDownload: s.asrDownload ?? null } : {}),
  });
  void loadProjects();
  // Reconnected (laptop sleep, server restart): the server doesn't replay missed events, so fetch the open session again.
  const viewing = getState().viewId;
  if (viewing) return openSession(viewing);
  // Deep links (?session=<id>&dialog=settings&tab=ai) open a view directly; used for scripted screenshots too.
  // Read once: a reconnect must not reopen them.
  const q = new URLSearchParams(location.search);
  if (location.search) history.replaceState(history.state, '', location.pathname + location.hash);
  const want = q.get('session');
  if (want) {
    // Evidence links from agents: ?session=…&t=…&t2=… focuses a passage, &frame=… opens a capture.
    const t = Number(q.get('t')), t2 = Number(q.get('t2')), frame = Number(q.get('frame'));
    const focus = q.get('t') && Number.isFinite(t) ? { t, t2: q.get('t2') && Number.isFinite(t2) ? t2 : undefined } : undefined;
    await openSession(want, focus);
    if (q.get('frame') && Number.isFinite(frame)) setState({ dialog: 'frame', frameView: frame });
  }
  const dlg = q.get('dialog');
  if (dlg && ['profile', 'settings', 'history', 'start', 'window'].includes(dlg)) setState({ dialog: dlg as AppState['dialog'], settingsTab: q.get('tab') ?? 'language' });
  // A live session opens directly; otherwise start on the Home screen (recent sessions are listed there).
  const liveId = s.live?.session?.id ?? null;
  if (liveId && !getState().viewId) await openSession(liveId);
}

// Live events for the session being fetched. The response can predate them, so they are merged into it.
// `changed`: its title, project, speakers or handoff changed meanwhile. Those have no event cursor, so it is read again.
type Caught = { id: string; segments: Segment[]; frames: Frame[]; outputs: Output[]; changed: boolean };
let fetching: Caught | null = null;
let openSeq = 0;
const caught = (sessionId: string) => (fetching?.id === sessionId ? fetching : null);
const changedDuringFetch = (sessionId: string) => { const c = caught(sessionId); if (c) c.changed = true; };
const finished = (o: Output) => o.status !== 'pending' && o.status !== 'streaming';
/** A live line or capture that a fetched session may already contain. */
const append = <T extends { id: number }>(list: T[], x: T) => (list.some((y) => y.id === x.id) ? list : [...list, x]);

/** Adds what arrived during the fetch: lines and captures by id, and of two copies of an answer the one that finished. */
function withCaught(d: SessionData, c: Caught): SessionData {
  const outputs = d.outputs.slice();
  for (const o of c.outputs) {
    const i = outputs.findIndex((x) => x.id === o.id);
    if (i < 0) outputs.push(o); else if (finished(o) || !finished(outputs[i])) outputs[i] = o;
  }
  return {
    ...d, outputs,
    segments: c.segments.reduce(append, d.segments).sort((a, b) => a.t_start - b.t_start || a.id - b.id),
    frames: c.frames.reduce(append, d.frames).sort((a, b) => a.t - b.t || a.id - b.id),
  };
}

/**
 * focus: a passage to scroll to and highlight (evidence links), set together with the data so nothing scrolls past it.
 * Opening the session already shown refreshes it and keeps the attached passage.
 */
export async function openSession(id: string, focus?: { t: number; t2?: number }): Promise<void> {
  const seq = ++openSeq, from = getState().viewId;
  let c: Caught, d: SessionData | undefined;
  for (let read = 1; ; read++) {
    c = { id, segments: [], frames: [], outputs: [], changed: false };
    fetching = c;
    d = await api<SessionData>(`/api/sessions/${id}`).catch((e) => {
      // Deleted while we were disconnected: leave it rather than keep showing it.
      if ((e as { status?: number }).status === 404 && seq === openSeq && getState().viewId === id) goHome();
      else notify('error', (e as Error).message, 'action');
      return undefined;
    });
    if (fetching === c) fetching = null;
    // A later open wins, and leaving the view meanwhile (Home, deleted) cancels this one.
    if (!d || seq !== openSeq || getState().viewId !== from) return;
    if (!c.changed || read === 2) break;
  }
  const data = withCaught(d, c);
  const done = new Set(data.outputs.filter(finished).map((o) => o.id));
  setState((s) => {
    const same = s.data?.session.id === id;
    // Streamed text exists only here until the answer is saved, so keep it for answers still streaming.
    const deltas = Object.fromEntries(Object.entries(s.deltas).filter(([oid]) => !done.has(oid)));
    return { viewId: id, data, deltas, focus: focus ? { ...focus, nonce: Date.now() } : same ? s.focus : null, attached: same ? s.attached : null };
  });
}

/** Refresh the session being viewed in place (its attached passage stays); nothing if another one is shown. */
export async function refreshSession(id: string): Promise<void> {
  if (getState().viewId === id) await openSession(id);
}

/** Back to Home. An open still loading is cancelled, so it can't bring the session back. */
export function goHome(): void {
  ++openSeq; fetching = null;
  setState({ viewId: null, data: null, deltas: {}, focus: null, attached: null });
}

export function connectEvents(): () => void {
  let closed = false, retryMs = 2000;
  let retry: ReturnType<typeof setTimeout> | undefined, request: AbortController | undefined;
  const cancelSync = () => { clearTimeout(retry); retry = undefined; request?.abort(); };
  const sync = () => {
    const current = request = new AbortController();
    void loadState(current.signal).then(() => { if (!current.signal.aborted) retryMs = 2000; }).catch(() => {
      if (closed || current.signal.aborted) return;
      retry = setTimeout(sync, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    });
  };
  const unsubscribe = subscribe({
    hello: (d) => setState({ live: d.live, liveReceivedAt: Date.now() }),
    live: (live) => {
      const prev = getState().live;
      setState({ live, liveReceivedAt: Date.now(), partials: live.partials ?? {} });
      const id = live.session?.id;
      if (id && id !== prev?.session?.id) void openSession(id);
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
    timeline: (entry) => { changedDuringFetch(entry.session_id); setState((s) => s.data && s.data.session.id === entry.session_id ? { data: { ...s.data, timeline: [...s.data.timeline.filter((e) => e.id !== entry.id && !entry.replaces?.includes(e.id)), entry].sort((a, b) => a.t - b.t || a.id - b.id) } } : {}); },
    segment: (seg: Segment) => { caught(seg.session_id)?.segments.push(seg); setState((s) => (s.data && s.data.session.id === seg.session_id ? { data: { ...s.data, segments: append(s.data.segments, seg) } } : {})); },
    ai: (o: Output) => {
      caught(o.session_id)?.outputs.push(o);
      // A late progress event can arrive after a read that already has the finished answer (a refresh is a new answer).
      const have = getState().data?.outputs.find((x) => x.id === o.id);
      if (!have || !finished(have) || finished(o)) upsertOutput(o);
    },
    frame: (f: Frame) => { caught(f.session_id)?.frames.push(f); setState((s) => (s.data && s.data.session.id === f.session_id ? { data: { ...s.data, frames: append(s.data.frames, f) } } : {})); },
    'ai-delta': (d: { id: string; delta: string }) => setState((s) => {
      const output = s.data?.outputs.find((o) => o.id === d.id);
      if (output && finished(output)) return {};
      return { deltas: { ...s.deltas, [d.id]: (s.deltas[d.id] ?? '') + d.delta } };
    }),
    provider: (p) => setState({ provider: p }),
    hotkey: (h) => setState({ hotkey: h }),
    'mybot-exported': () => setState((s) => ({ mybotExportRev: s.mybotExportRev + 1 })),
    'asr-download': (d) => { downloadRevision++; setState({ asrDownload: d }); },
    settings: (st: Settings) => setState({ settings: st }),
    profile: (p: Profile) => setState({ profile: p }),
    notice: (n) => { if (n.code === 'capture_restarted') setState((s) => ({ notices: s.notices.filter((x) => x.code !== 'capture_stopped' && x.code !== 'capture_gave_up') })); notify(n.level, n.message, n.code, n.vars); },
    asr: (a) => setState((s) => ({ live: s.live ? { ...s.live, asr: { ...s.live.asr, state: a.state, message: a.message } } : s.live })),
    'session-ended': (e) => { if (getState().viewId === e.sessionId) void openSession(e.sessionId); bumpSessions(); notify('info', t(e.transcriptionPending ? 'Session saved. Finishing transcription before the final summary…' : 'Session saved. Preparing the final summary…'), 'ended'); },
    'session-updated': (sess) => {
      changedDuringFetch(sess.id);
      setState((s) => ({ sessionsRev: s.sessionsRev + 1, projectWorkRev: s.projectWorkRev + 1, ...(s.data && s.data.session.id === sess.id ? { data: { ...s.data, session: sess } } : {}) }));
    },
    'mobile-sync': (e) => { if (getState().viewId === e.sessionId) void openSession(e.sessionId); bumpSessions(); },
    'session-deleted': (e: { id: string }) => setState((s) => ({ sessionsRev: s.sessionsRev + 1, ...(s.viewId === e.id ? { viewId: null, data: null } : {}) })),
    handoff: (e: { sessionId: string; handoff: Handoff | null }) => setHandoff(e.sessionId, e.handoff),
    speakers: (e: SpeakerUpdate) => mergeSpeakerUpdate(e),
    projects: () => void loadProjects(),
    'project-work': () => setState((s) => ({ projectWorkRev: s.projectWorkRev + 1 })),
  }, (ok) => {
    cancelSync();
    setState({ connected: ok });
    if (ok && !closed) { bumpSessions(); retryMs = 2000; sync(); }
  });
  return () => { closed = true; cancelSync(); unsubscribe(); };
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
  if (r) { setState({ dialog: null, startProjectId: null, startDraft: null }); await openSession(r.session.id); }
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
  // Refreshed only if it is still the one shown: the user may have opened another meanwhile.
  if (r?.sessionId) await refreshSession(r.sessionId);
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
  const before = getState(), seq = openSeq, text = question.trim();
  if (!before.data || (!text && !before.attached)) return { accepted: false, cleared: false };
  const accepted = mode === 'explain'
    ? await explain(text || before.attached!.text.slice(0, 80), before.attached, depth, undefined, effort)
    : await ask(text || t('What does this passage mean?'), before.attached, depth, [], effort);
  let cleared = false;
  if (accepted) setState((s) => {
    if (seq !== openSeq || s.viewId !== before.viewId || s.askDraft !== before.askDraft || s.attached !== before.attached) return {};
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
  if (r && getState().viewId === id) setState({ viewId: null, data: null });
  if (r) bumpSessions();
  return !!r;
}
/** Every session list (Home, History) reloads when this changes. */
export const bumpSessions = () => setState((s) => ({ sessionsRev: s.sessionsRev + 1, projectWorkRev: s.projectWorkRev + 1 }));
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
  changedDuringFetch(update.sessionId);
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
  if (r) setState((s) => ({ projects: r.projects, projectWorkRev: s.projectWorkRev + 1 }));
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
  changedDuringFetch(sessionId);
  setState((s) => {
    if (!s.data || s.data.session.id !== sessionId) return { projectWorkRev: s.projectWorkRev + 1 };
    const current = s.data.handoff;
    // Delivery responses may arrive after a newer progress event. Never roll a saved action back.
    const merged = handoff && current?.id === handoff.id ? { ...handoff, items: handoff.items.map((item) => {
      const previous = current.items.find((old) => old.id === item.id);
      return item.progress && previous?.progress && previous.project_id === item.project_id && previous.text === item.text
        && previous.progress.version > item.progress.version ? { ...item, progress: previous.progress } : item;
    }) } : handoff;
    return { data: { ...s.data, handoff: merged }, projectWorkRev: s.projectWorkRev + 1 };
  });
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
/** paste: for an app that cannot be handed the handoff (DeepSeek Harness), the instruction to paste there and whether Chumi copied it. */
export async function continueHandoff(handoffId: string, agent: AgentId | 'copy' | 'codex-app'): Promise<{ prompt: string; launched: boolean; paste?: { text: string; copied: boolean } }> {
  const r = await api<{ prompt: string; launched: boolean; paste?: { text: string; copied: boolean }; handoff?: Handoff | null }>(`/api/handoffs/${handoffId}/continue`, { body: { agent } });
  if (r.handoff) setHandoff(r.handoff.session_id, r.handoff);
  return { prompt: r.prompt, launched: r.launched, paste: r.paste };
}

export async function updateActionProgress(itemId: string, patch: Pick<ActionProgress, 'status' | 'note' | 'results'> & { expectedVersion: number }): Promise<ActionProgress | null> {
  try {
    const r = await api<{ progress: ActionProgress; sessionId: string; handoff: Handoff }>(`/api/handoff-items/${encodeURIComponent(itemId)}/progress`, { method: 'PATCH', body: patch });
    setHandoff(r.sessionId, r.handoff);
    return r.progress;
  } catch (error) {
    notify('error', t((error as Error).message), 'action-progress');
    return null;
  }
}
