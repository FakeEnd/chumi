export const ACTION_STATUSES = ['not_started', 'in_progress', 'blocked', 'completed'] as const;
export type ActionStatus = typeof ACTION_STATUSES[number];
/** User-entered references only: web URLs without credentials, or an exact Codex thread link. */
export function isActionResultUrl(value: string): boolean {
  if (!value || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  if (/^codex:\/\/threads\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && /^https?:\/\//i.test(value)
      && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
export interface ActionResult { label: string; url: string }
export interface ActionProgress {
  status: ActionStatus;
  note: string;
  results: ActionResult[];
  updatedAt: number | null;
  version: number;
}
export interface ProjectAgenda { text: string; version: number; updatedAt: number | null }
export interface ProjectBriefItem {
  id: string;
  text: string;
  sessionId: string;
  sessionTitle: string;
  sessionStartedAt: number | null;
  handoffId: string;
  stale: boolean;
  owner: string | null;
  due: string | null;
}
export interface ProjectWorkItem extends ProjectBriefItem { progress: ActionProgress }
export interface ProjectBrief {
  project: { id: string; name: string };
  agenda: ProjectAgenda;
  latestMeeting: { id: string; title: string; startedAt: number | null } | null;
  actions: ProjectWorkItem[];
  completedActions: ProjectWorkItem[];
  decisions: ProjectBriefItem[];
  questions: ProjectBriefItem[];
  reviewNeededCount: number;
  reviewNeeded: Array<{ sessionId: string; title: string; reason: 'unconfirmed' | 'changed' | 'moved' | 'failed' }>;
  /** Unfinished work is never truncated. These counts describe omitted older history. */
  omitted: { completedActions: number; decisions: number; questions: number };
}
