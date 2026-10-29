import type { AgentId } from '../shared/agents.ts';
import type { AgentIntegration } from './projects/agents.ts';

/** Share in-flight checks and briefly reuse CLI health results when Settings is reopened. */
export class AgentChecks {
  private entries = new Map<string, { promise: Promise<any>; expires: number }>();
  private agents: Pick<AgentIntegration, 'status' | 'localCheck'>;
  private now: () => number;
  private ttl: number;
  constructor(agents: Pick<AgentIntegration, 'status' | 'localCheck'>, now = Date.now, ttl = 30_000) { this.agents = agents; this.now = now; this.ttl = ttl; }
  invalidate(agent: AgentId): void { this.entries.delete(agent); }
  private get<T>(key: string, check: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && this.now() < cached.expires) return cached.promise;
    const entry = { promise: Promise.resolve().then(check), expires: Infinity };
    this.entries.set(key, entry);
    void entry.promise.then(() => { entry.expires = this.now() + this.ttl; }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.promise;
  }
  status(agent: AgentId, fresh = false): ReturnType<AgentIntegration['status']> {
    if (fresh) this.invalidate(agent);
    return this.get(agent, () => this.agents.status(agent, true));
  }
  local(): ReturnType<AgentIntegration['localCheck']> { return this.get('local', () => this.agents.localCheck()); }
}
