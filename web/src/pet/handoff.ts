// The desktop pet's one step into a coding agent: a confirmed handoff continues where the user last chose in Chumi's
// handoff dialog (Codex app unless they picked another). Reviewing and confirming stay in Chumi's window.

import { msg } from '../i18n.ts';
import { AGENT_NAMES, isAgent } from '../../../shared/agents.ts';
import type { HandoffDestination } from '../handoffDestination.ts';
import type { Handoff } from '../types.ts';

/** A handoff the pet can hand on: confirmed, and for the meeting's current project. */
export const canContinue = (h: Handoff | null | undefined): h is Handoff => !!h && h.status === 'confirmed' && !!h.project && !h.project_mismatch && !h.freshness.stale;

/** The destination as Chumi's Continue in menu names it (pass it through t()). */
export function placeName(d: HandoffDestination): string {
  if (d === 'codex-app') return msg('Codex app');
  if (d === 'codex') return msg('Codex in Terminal');
  if (d === 'claude-code') return msg('Claude Code in Terminal');
  if (d === 'copy') return msg('Copy instructions');
  return isAgent(d) ? AGENT_NAMES[d] : d;
}

/** The short label on the pet's toolbar button. */
export function placeLabel(d: HandoffDestination): string {
  if (d === 'codex-app') return msg('Codex app');
  if (d === 'copy') return msg('Handoff');
  return isAgent(d) ? AGENT_NAMES[d] : d;
}
