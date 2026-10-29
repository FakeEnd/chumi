import type { Store } from './db.ts';

/** A synchronous snapshot: provider discovery must not delay the shell's quit decision. */
export function quitCheck(store: Store, status: string, pendingSummaries: number) {
  const outputs = store.db.prepare("SELECT count(*) AS n FROM ai_outputs WHERE status IN ('pending', 'streaming')").get() as { n: number };
  const handoffs = store.db.prepare("SELECT count(*) AS n FROM handoffs WHERE status = 'generating'").get() as { n: number };
  return { status, pendingOutputs: outputs.n, handoffGenerating: handoffs.n > 0, pendingSummaries };
}
