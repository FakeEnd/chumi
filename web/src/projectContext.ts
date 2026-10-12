import { useSyncExternalStore } from 'react';

/**
 * "Use project context" per meeting: when on, questions also search the project's earlier Claude Code and
 * Codex sessions through mybot. Off by default; remembered in this browser only.
 */
const key = (sessionId: string) => `chumi.projectContext.${sessionId}`;
const listeners = new Set<() => void>();

export function projectContextOn(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  try { return localStorage.getItem(key(sessionId)) === '1'; } catch { return false; }
}

export function setProjectContext(sessionId: string, on: boolean): void {
  try { if (on) localStorage.setItem(key(sessionId), '1'); else localStorage.removeItem(key(sessionId)); } catch { /* storage unavailable: stays off */ }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useProjectContextOn(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => projectContextOn(sessionId));
}
