import { isAgent, type AgentId } from '../../shared/agents.ts';

export type HandoffDestination = AgentId | 'copy' | 'codex-app';
const KEY = 'chumi.handoffDestination';

export const isHandoffDestination = (value: string | null): value is HandoffDestination =>
  value === 'copy' || value === 'codex-app' || (value !== null && isAgent(value));

export function loadHandoffDestination(): HandoffDestination {
  try {
    const value = localStorage.getItem(KEY);
    return isHandoffDestination(value) ? value : 'codex-app';
  } catch { return 'codex-app'; }
}

export function saveHandoffDestination(value: HandoffDestination): void {
  try { localStorage.setItem(KEY, value); } catch { /* Keep the current choice when storage is unavailable. */ }
}
