import { api, subscribe } from './api.ts';
import { getState, notify, setState, upsertOutput, type AppState } from './store.ts';
import { projectContextOn } from './projectContext.ts';
import { t } from './i18n.ts';
import type { SpeakerAnnotation, SpeakerCorrection, SpeakerView } from '../../shared/speakers.ts';
import type { AgentId } from '../../shared/agents.ts';
import type { Depth, Effort, Frame, Handoff, Output, Profile, Project, Segment, SessionData, Settings, SpeakerUpdate, WindowInfo } from './types.ts';

export async function loadState(): Promise<void> {
  const s = await api('/api/state');
  setState({
    loaded: true, settings: s.settings, profile: s.profile, provider: s.provider, live: s.live, liveReceivedAt: Date.now(), partials: s.live?.partials ?? {},
    devMode: s.devMode, helperBuilt: s.helperBuilt, platform: s.platform ?? '', screenToolBuilt: s.screenToolBuilt, hotkey: s.hotkey ?? null, appMode: s.appMode, dataDir: s.dataDir, samples: s.samples ?? [], systemLanguage: s.systemLanguage ?? '',
  });
  // Deep links (?session=<id>&dialog=settings&tab=ai) open a view directly; used for scripted screenshots too.
  const q = new URLSearchParams(location.search);
  void loadProjects();
  const want = q.get('session');
  if (want && !getState().viewId) {
    // Evidence links from agents: ?session=…&t=…&t2=… focuses a passage, &frame=… opens a capture.
    const t = Number(q.get('t')), t2 = Number(q.get('t2')), frame = Number(q.get('frame'));
    const focus = q.get('t') && Number.isFinite(t) ? { t, t2: q.get('t2') && Number.isFinite(t2) ? t2 : undefined } : undefined;
    await openSession(want, focus).catch(() => {});
    if (q.get('frame') && Number.isFinite(frame)) setState({ dialog: 'frame', frameView: frame });
  }
  const dlg = q.get('dialog');
  if (dlg && ['profile', 'settings', 'history', 'start', 'window'].includes(dlg)) setState({ dialog: dlg as AppState['dialog'], settingsTab: q.get('tab') ?? 'language' });
  // A live session opens directly; otherwise start on the Home screen (recent sessions are listed there).
  const liveId = s.live?.session?.id ?? null;
  if (liveId && !getState().viewId) await openSession(liveId);
}

/** focus: a passage to scroll to and highlight (evidence links), set together with the data so nothing scrolls past it. */
export async function openSession(id: string, focus?: { t: number; t2?: number }): Promise<void> {
  const d = await api<SessionData>(`/api/sessions/${id}`);
  setState({ viewId: id, data: d, deltas: {}, focus: focus ? { ...focus, nonce: Date.now() } : null, attached: null });
}

export function connectEvents(): () => void {
  return subscribe({
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
    partial: (p) => setState((s) => ({ partials: { ...s.partials, [p.source]: { uttId: p.uttId, t: p.t, text: p.text } } })),
    'partial-clear': (p) => setState((s) => {
      const cur = s.partials[p.source];
      if (!cur || cur.uttId > p.uttId) return {};
      const next = { ...s.partials }; delete next[p.source]; return { partials: next };
    }),
    segment: (seg: Segment) => setState((s) => (s.data && s.data.session.id === seg.session_id ? { data: { ...s.data, segments: [...s.data.segments, seg] } } : {})),
    ai: (o: Output) => upsertOutput(o),
    frame: (f: Frame) => setState((s) => (s.data && s.data.session.id === f.session_id ? { data: { ...s.data, frames: [...s.data.frames, f] } } : {})),
    'ai-delta': (d: { id: string; delta: string }) => setState((s) => ({ deltas: { ...s.deltas, [d.id]: (s.deltas[d.id] ?? '') + d.delta } })),
    provider: (p) => setState({ provider: p }),
    hotkey: (h) => setState({ hotkey: h }),
    'asr-download': (d) => setState({ asrDownload: d }),
    settings: (st: Settings) => setState({ settings: st }),
    profile: (p: Profile) => setState({ profile: p }),
    notice: (n) => notify(n.level, n.message, n.code),
    asr: (a) => setState((s) => ({ live: s.live ? { ...s.live, asr: { ...s.live.asr, state: a.state, message: a.message } } : s.live })),
    'session-ended': (e) => { if (getState().viewId === e.sessionId) void openSession(e.sessionId); bumpSessions(); notify('info', t('Session saved. Preparing the final summary…'), 'ended'); },
    'session-updated': (sess) => setState((s) => ({ sessionsRev: s.sessionsRev + 1, ...(s.data && s.data.session.id === sess.id ? { data: { ...s.data, session: sess } } : {}) })),
    'mobile-sync': (e) => { if (getState().viewId === e.sessionId) void openSession(e.sessionId); bumpSessions(); },
    'session-deleted': (e: { id: string }) => setState((s) => ({ sessionsRev: s.sessionsRev + 1, ...(s.viewId === e.id ? { viewId: null, data: null } : {}) })),
    handoff: (e: { sessionId: string; handoff: Handoff | null }) => setHandoff(e.sessionId, e.handoff),
    speakers: (e: SpeakerUpdate) => mergeSpeakerUpdate(e),
    projects: () => void loadProjects(),
  }, (ok) => { setState({ connected: ok }); if (ok) void loadState().catch(() => {}); });
}

const guard = async <T>(p: Promise<T>): Promise<T | undefined> => {
  try { return await p; } catch (e) { notify('error', (e as Error).message, 'action'); return undefined; }
};

export async function startSession(o: { title: string; type: string; source: string; filePath?: string; speed?: number; window?: { id: number; title: string; app: string } | null; project_id?: string | null }): Promise<boolean> {
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
  if (r?.sessionId) await openSession(r.sessionId);
}
export const resumeSaved = (id: string, source: string) => guard(api(`/api/sessions/${id}/resume`, { body: { source } }));

function current(): string | null { return getState().data?.session.id ?? null; }
export const catchup = (scope: '2m' | '5m' | 'all') => { const id = current(); if (id) void guard(api('/api/ai/catchup', { body: { sessionId: id, scope } })); };
export const ask = (question: string, selection: { fromT: number; toT: number; text: string } | null, depth: Depth, frameIds: number[] = [], effort?: Effort) => { const id = current(); if (id) void guard(api('/api/ai/ask', { body: { sessionId: id, question, selection, depth, frameIds, effort, projectContext: projectContextOn(id) && !!getState().data?.session.project_id } })); };
export const setWindow = (w: WindowInfo | null) => guard(api('/api/session/window', { body: { window: w ? { id: w.id, title: w.title, app: w.app } : null } }));
export const frameUrl = (id: number) => `/api/frames/${id}`;
export const explain = (term: string, selection: { fromT: number; toT: number; text: string } | null, depth: Depth, parentId?: string, effort?: Effort) => { const id = current(); if (id) void guard(api('/api/ai/explain', { body: { sessionId: id, term, selection, depth, parentId, effort } })); };
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
export const bumpSessions = () => setState((s) => ({ sessionsRev: s.sessionsRev + 1 }));
export function exportUrl(id: string, format: 'md' | 'txt'): string { return `/api/sessions/${id}/export?format=${format}`; }
export async function refreshProvider(): Promise<void> { const p = await guard(api('/api/provider/status?refresh=1')); if (p) setState({ provider: p }); }

// Speaker updates replace annotations without resetting the viewed passage or attached question.
export function mergeSpeakerUpdate(update: SpeakerUpdate): void {
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
