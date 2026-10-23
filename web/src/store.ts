import { useSyncExternalStore } from 'react';
import type { LiveState, Notice, Output, Profile, Project, ProviderStatus, SessionData, Settings } from './types.ts';

export interface AppState {
  connected: boolean;
  loaded: boolean;
  settings: Settings | null;
  profile: Profile | null;
  provider: ProviderStatus | null;
  live: LiveState | null;
  liveReceivedAt: number;
  levels: Record<string, { rms: number; peak: number; at: number }>;
  partials: Record<string, { uttId: number; t: number; text: string }>;
  devMode: boolean;
  helperBuilt: boolean;
  /** The server's process.platform, used for platform-specific permissions and controls. */
  platform: string;
  appMode: boolean;
  dataDir: string;
  samples: Array<{ name: string; path: string; sizeMb: number }>;
  /** The session shown in the main view (live or saved). */
  viewId: string | null;
  data: SessionData | null;
  deltas: Record<string, string>;
  notices: Notice[];
  dialog: null | 'profile' | 'settings' | 'history' | 'start' | 'window' | 'frame' | 'handoff';
  /** All projects, including archived ones (pickers hide archived). */
  projects: Project[];
  /** Bumped when any saved session is added, renamed, reassigned or deleted, so every session list reloads. */
  sessionsRev: number;
  frameView: number | null;
  screenToolBuilt: boolean;
  hotkey: { state: string; shortcut: string; message: string | null } | null;
  settingsTab: string;
  focus: { t: number; t2?: number; nonce: number } | null;
  /** Transcript passage the user attached to the next question. */
  attached: { fromT: number; toT: number; text: string } | null;
  askDraft: string;
  /** System language, used when the interface language is Auto. */
  systemLanguage: string;
  /** Speech-model download in progress (Settings → Transcription). */
  asrDownload: { id: string; received: number; total: number; status: string; error?: string } | null;
  /** Transcript line at the saved recording's playback position. */
  playingSeg: number | null;
  /** Card tags (stripe colours) hidden in the assistant column; kept while the app is open. */
  hiddenCards: string[];
}

let state: AppState = {
  connected: false, loaded: false, settings: null, profile: null, provider: null, live: null, liveReceivedAt: 0, levels: {}, partials: {},
  devMode: false, helperBuilt: false, platform: '', appMode: false, dataDir: '', samples: [], viewId: null, data: null, deltas: {}, notices: [],
  dialog: null, frameView: null, screenToolBuilt: false, hotkey: null, settingsTab: 'language', focus: null, attached: null, askDraft: '', systemLanguage: '', asrDownload: null, projects: [], sessionsRev: 0, playingSeg: null, hiddenCards: [],
};
const listeners = new Set<() => void>();

export const getState = (): AppState => state;
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}
export function useStore<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(state));
}

let noticeId = 1;
export function notify(level: Notice['level'], message: string, code = 'ui'): void {
  const n: Notice = { id: noticeId++, level, code, message, at: Date.now() };
  setState((s) => ({ notices: [...s.notices.filter((x) => !(x.code === code && x.message === message)), n].slice(-6) }));
  if (level !== 'error') setTimeout(() => dismiss(n.id), level === 'info' ? 6000 : 15000);
}
export function dismiss(id: number): void { setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) })); }

export function upsertOutput(o: Output): void {
  setState((s) => {
    if (!s.data || s.data.session.id !== o.session_id) return {};
    const outs = s.data.outputs.slice();
    const i = outs.findIndex((x) => x.id === o.id);
    if (i >= 0) outs[i] = o; else outs.push(o);
    const deltas = { ...s.deltas };
    if (o.status !== 'streaming' && o.status !== 'pending') delete deltas[o.id];
    return { data: { ...s.data, outputs: outs }, deltas };
  });
}
