import type { Store } from '../db.ts';
import type { ProviderId } from '../settings.ts';
import { AnthropicApiProvider } from './anthropic-api.ts';
import { ClaudeCliProvider } from './claude-cli.ts';
import { CodexProvider } from './codex.ts';
import { MockProvider } from './mock.ts';
import { ProviderError, type AIProvider, type CompletionRequest, type CompletionResult, type ProviderStatus } from './provider.ts';

/**
 * Holds all provider adapters and routes requests to the ONE provider the user selected.
 * There is deliberately no automatic fallback between providers: a quota or auth failure is reported,
 * never silently retried on a different (possibly paid) provider.
 */
export class ProviderRegistry {
  readonly providers: Record<ProviderId, AIProvider>;
  readonly mock: MockProvider;
  private store: Store;
  private statusCache = new Map<string, ProviderStatus>();
  onStatus: (s: ProviderStatus) => void = () => {};

  constructor(store: Store) {
    this.store = store;
    this.mock = new MockProvider();
    this.providers = {
      codex: new CodexProvider(() => store.getSettings().ai.codex),
      'claude-cli': new ClaudeCliProvider(() => store.getSettings().ai.claudeCli),
      'anthropic-api': new AnthropicApiProvider(() => store.getSettings().ai.anthropicApi),
      mock: this.mock,
    };
  }

  get activeId(): ProviderId {
    const s = this.store.getSettings();
    if (s.ai.provider === 'mock' && !s.devMode && !process.env.CHUMI_DEV) return 'codex';
    return s.ai.provider;
  }
  get active(): AIProvider { return this.providers[this.activeId]; }

  async status(refresh = false): Promise<ProviderStatus> {
    const st = await this.active.status(refresh);
    this.statusCache.set(st.id, st);
    this.onStatus(st);
    return st;
  }
  cachedStatus(): ProviderStatus | undefined { return this.statusCache.get(this.activeId); }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const provider = this.active;
    try {
      const r = await provider.complete(req);
      return r;
    } catch (e) {
      if (e instanceof ProviderError && ['quota', 'quota_gate', 'auth', 'billing_safety'].includes(e.kind)) void this.status(true).catch(() => {});
      throw e;
    }
  }

  async shutdown(): Promise<void> { await Promise.all(Object.values(this.providers).map((p) => p.shutdown().catch(() => {}))); }
}
