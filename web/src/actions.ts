import { api, subscribe } from './api.ts';
import { getState, notify, setState, upsertOutput, type AppState } from './store.ts';
import type { Depth, Effort, Frame, Output, Profile, Segment, SessionData, Settings, WindowInfo } from './types.ts';

export async function loadState(): Promise<void> {
  const s = await api('/api/state');
  setState({
    loaded: true, settings: s.settings, profile: s.profile, provider: s.provider, live: s.live, liveReceivedAt: Date.now(), partials: s.live?.partials ?? {},
    devMode: s.devMode, helperBuilt: s.helperBuilt, screenToolBuilt: s.screenToolBuilt, hotkey: s.hotkey ?? null, appMode: s.appMode, dataDir: s.dataDir, samples: s.samples ?? [],
  });
  // Deep links (?session=<id>&dialog=settings&tab=ai) open a view directly; used for scripted screenshots too.
  const q = new URLSearchParams(location.search);
  const want = q.get('session');
  if (want && !getState().viewId) { await openSession(want).catch(() => {}); }
  const dlg = q.get('dialog');
  if (dlg && ['profile', 'settings', 'history', 'start', 'window'].includes(dlg)) setState({ dialog: dlg as AppState['dialog'], settingsTab: q.get('tab') ?? 'audio' });
  // A live session opens directly; otherwise start on the Home screen (recent sessions are listed there).
  const liveId = s.live?.session?.id ?? null;
  if (liveId && !getState().viewId) await openSession(liveId);
}

export async function openSession(id: string): Promise<void> {
  const d = await api<SessionData>(`/api/sessions/${id}`);
  setState({ viewId: id, data: d, deltas: {}, focus: null, attached: null });
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
    settings: (st: Settings) => setState({ settings: st }),
    profile: (p: Profile) => setState({ profile: p }),
    notice: (n) => notify(n.level, n.message, n.code),
    asr: (a) => setState((s) => ({ live: s.live ? { ...s.live, asr: { ...s.live.asr, state: a.state, message: a.message } } : s.live })),
    'session-ended': (e) => { if (getState().viewId === e.sessionId) void openSession(e.sessionId); notify('info', 'Session saved. Generating the final summary…', 'ended'); },
    'session-updated': (sess) => setState((s) => (s.data && s.data.session.id === sess.id ? { data: { ...s.data, session: sess } } : {})),
  }, (ok) => { setState({ connected: ok }); if (ok) void loadState().catch(() => {}); });
}

const guard = async <T>(p: Promise<T>): Promise<T | undefined> => {
  try { return await p; } catch (e) { notify('error', (e as Error).message, 'action'); return undefined; }
};

export async function startSession(o: { title: string; type: string; source: string; filePath?: string; speed?: number; window?: { id: number; title: string; app: string } | null }): Promise<boolean> {
  if (o.source === 'mic' || o.source === 'both') {
    const perm = await api<Record<string, string>>('/api/audio/permissions').catch(() => ({} as Record<string, string>));
    if (perm.microphone === 'denied' || perm.microphone === 'restricted') {
      notify('error', 'Microphone access is blocked. Open System Settings → Privacy & Security → Microphone and enable Chumi (or the terminal app you launched it from), then try again.', 'mic_permission_denied');
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
export const ask = (question: string, selection: { fromT: number; toT: number; text: string } | null, depth: Depth, frameIds: number[] = [], effort?: Effort) => { const id = current(); if (id) void guard(api('/api/ai/ask', { body: { sessionId: id, question, selection, depth, frameIds, effort } })); };
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
  if (r) { setState({ profile: r }); if (!quiet) notify('info', 'Profile saved.'); }
  return !!r;
}
export async function renameSession(id: string, patch: { title?: string; type?: string }): Promise<void> { await guard(api(`/api/sessions/${id}`, { method: 'PATCH', body: patch })); }
export async function deleteSession(id: string): Promise<boolean> {
  const r = await guard(api(`/api/sessions/${id}`, { method: 'DELETE' }));
  if (r && getState().viewId === id) setState({ viewId: null, data: null });
  return !!r;
}
export function exportUrl(id: string, format: 'md' | 'txt'): string { return `/api/sessions/${id}/export?format=${format}`; }
export async function refreshProvider(): Promise<void> { const p = await guard(api('/api/provider/status?refresh=1')); if (p) setState({ provider: p }); }
