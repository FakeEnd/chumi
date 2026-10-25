import type { ChildProcess } from 'node:child_process';
import { CODEX_WORKDIR, which } from '../paths.ts';
import { runCommand, spawnCommand, stopProcess } from '../platform.ts';
import { log } from '../util.ts';
import {
  ProviderError, windowLabel,
  type AIProvider, type CompletionRequest, type CompletionResult, type ProviderStatus, type QuotaInfo,
} from './provider.ts';

/*
 * ChatGPT plan access through the official Codex app-server protocol
 * (https://learn.chatgpt.com/docs/app-server — "Embed Codex into your product").
 *
 * - Authentication is owned entirely by the Codex CLI (`codex login` → "Sign in with ChatGPT").
 *   Chumi never reads, stores, or forwards ChatGPT tokens.
 * - Usage counts against the ChatGPT plan's included Codex usage.
 * - Chumi reads the plan's rate-limit windows and refuses to send requests once the included
 *   allowance is exhausted, unless the user explicitly allows spending purchased credits.
 * - Every request runs in an ephemeral thread with custom base instructions, a read-only sandbox,
 *   no approvals and tool features disabled, in an empty working directory.
 */

type Json = Record<string, unknown>;
export interface RateWindow { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export interface RateSnapshot {
  primary: RateWindow | null; secondary: RateWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  spendControlReached: boolean | null; planType: string | null; rateLimitReachedType: string | null;
}
export interface RateLimits { ordinaryUsageAllowed: boolean | null; rateLimits: RateSnapshot }

interface PendingTurn {
  text: string;
  turnId: string | null;
  onDelta?: (t: string) => void;
  resolve: (text: string) => void;
  reject: (e: Error) => void;
  lastError: { message: string; info: unknown } | null;
}

const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation',
  'multi_agent', 'plugins', 'view_image', 'goals', 'hooks', 'in_app_browser', 'skill_search', 'tool_suggest', 'sleep_tool',
  'codex_hooks', // the name of 'hooks' before Codex 0.13x
];

/**
 * Decide whether the ChatGPT plan's included usage is available, from Codex's account/rateLimits/read.
 * Conservative: any signal of exhaustion blocks requests unless the user explicitly allowed credits.
 */
export function evaluateCodexQuota(r: RateLimits | null, allowCredits: boolean, usageLimitHit = false): QuotaInfo {
  if (!r) return { known: false, summary: 'Quota information unavailable from Codex right now.' };
  const s = r.rateLimits;
  const windows = [s.primary, s.secondary].filter((w): w is RateWindow => !!w)
    .map((w) => ({ label: windowLabel(w.windowDurationMins), usedPercent: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null }));
  const exhausted = usageLimitHit || r.ordinaryUsageAllowed === false || !!s.rateLimitReachedType || s.spendControlReached === true || windows.some((w) => w.usedPercent >= 100);
  const parts = windows.map((w) => `${w.label}: ${Math.round(w.usedPercent)}% used${w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : ''}`);
  if (r.ordinaryUsageAllowed === null) parts.push('included-usage status not reported');
  return {
    known: windows.length > 0,
    summary: parts.join(' · ') || 'Codex reported no usage windows.',
    windows,
    exhausted,
    credits: s.credits ? { hasCredits: s.credits.hasCredits, balance: s.credits.balance, willUse: exhausted && allowCredits && s.credits.hasCredits } : null,
    note: exhausted
      ? (allowCredits ? 'Included plan usage is exhausted. You allowed purchased ChatGPT credits, so requests may cost money.' : 'Included plan usage is exhausted. Chumi will not spend purchased credits; AI requests are paused until the limit resets or you change this in Settings.')
      : "Requests use your ChatGPT plan's included Codex usage.",
  };
}

/** Map a requested effort to the closest level a model supports, never higher than requested. */
export function clampEffort(supported: string[], want: string): string {
  const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  if (!supported.length || supported.includes(want)) return want;
  const w = order.indexOf(want);
  const below = supported.filter((e) => order.indexOf(e) <= w).sort((a, b) => order.indexOf(b) - order.indexOf(a));
  return below[0] ?? supported[0];
}

export class CodexProvider implements AIProvider {
  readonly id = 'codex';
  readonly label = 'ChatGPT plan (via Codex sign-in)';
  readonly supportsImages = true;
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private turns = new Map<string, PendingTurn>();
  private rate: RateLimits | null = null;
  private rateAt = 0;
  private account: { type: string; email: string | null; planType: string | null } | null = null;
  private models: Array<{ id: string; name: string; isDefault: boolean; efforts: string[] }> = [];
  private lastStatus: ProviderStatus | null = null;
  private usageLimitHit = false;

  private cfg: () => { model: string | null; allowCredits: boolean };
  constructor(cfg: () => { model: string | null; allowCredits: boolean }) { this.cfg = cfg; }

  /** Codex owns the browser callback and credential storage; Chumi receives only the sign-in URL. */
  async beginLogin(): Promise<{ loginId: string; authUrl: string }> {
    await this.ensure();
    return await this.request('account/login/start', { type: 'chatgpt' }) as unknown as { loginId: string; authUrl: string };
  }

  // ------------------------------------------------------------------ process / JSON-RPC
  private ensure(): Promise<void> {
    if (this.proc && this.ready) return this.ready;
    this.ready = this.start().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  private async start(): Promise<void> {
    const bin = which('codex');
    if (!bin) throw new ProviderError('unavailable', 'Codex CLI not found. Install it (brew install codex) and run "codex login".');
    const env = { ...process.env };
    delete env.OPENAI_API_KEY; // make sure the plan sign-in is used, never an API key from the environment
    delete env.CODEX_API_KEY;
    // An older Codex refuses to start when asked to disable a feature it doesn't know, and a feature it doesn't know
    // can't be on. Disable the ones this version lists; if the list can't be read, ask for all of them as before.
    const listed = await runCommand(bin, ['features', 'list'], { env, timeoutMs: 15_000 });
    const known = new Set(listed.code === 0 ? listed.out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean) : []);
    const disable = known.size ? DISABLED_FEATURES.filter((f) => known.has(f)) : DISABLED_FEATURES;
    const args = ['app-server', ...disable.flatMap((f) => ['--disable', f]), '-c', 'web_search="disabled"'];
    const proc = spawnCommand(bin, args, { cwd: CODEX_WORKDIR, stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
    this.proc = proc;
    let buf = '';
    proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) this.onMessage(line);
      }
    });
    let errTail = '';
    proc.stderr!.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-3000); });
    proc.on('exit', (code) => {
      log('codex', `app-server exited (code ${code}) ${errTail.slice(-400)}`);
      this.proc = null; this.ready = null;
      const err = new ProviderError('unavailable', `Codex app-server stopped (code ${code}).`, true);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const t of this.turns.values()) t.reject(err);
      this.turns.clear();
    });
    await this.request('initialize', { clientInfo: { name: 'chumi', title: 'Chumi listening companion', version: '0.1.0' }, capabilities: null }, 20000);
    this.notify('initialized', undefined);
  }

  private send(msg: Json): void { this.proc?.stdin?.write(JSON.stringify(msg) + '\n'); }
  private notify(method: string, params: unknown): void { this.send(params === undefined ? { method } : { method, params }); }

  private request(method: string, params: unknown, timeoutMs = 30000): Promise<Json> {
    if (!this.proc) return Promise.reject(new ProviderError('unavailable', 'Codex app-server is not running', true));
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new ProviderError('network', `Codex ${method} timed out`, true)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.send(params === undefined ? { method, id } : { method, id, params });
    });
  }

  private onMessage(line: string): void {
    let m: Json;
    try { m = JSON.parse(line) as Json; } catch { return; }
    if (m.id != null && m.method == null) {
      const p = this.pending.get(m.id as number);
      if (!p) return;
      this.pending.delete(m.id as number);
      if (m.error) p.reject(new ProviderError('bad_response', `Codex: ${(m.error as Json).message ?? 'error'}`));
      else p.resolve((m.result ?? {}) as Json);
      return;
    }
    if (m.id != null && m.method) {
      // Server → client request (tool approval, user input…). Chumi never grants tool use.
      this.send({ id: m.id, error: { code: -32000, message: 'Chumi does not permit tool use or approvals.' } });
      return;
    }
    const params = (m.params ?? {}) as Json;
    const threadId = params.threadId as string | undefined;
    const turn = threadId ? this.turns.get(threadId) : undefined;
    switch (m.method) {
      case 'item/agentMessage/delta': {
        if (turn && typeof params.delta === 'string') { turn.text += params.delta; turn.onDelta?.(params.delta); }
        break;
      }
      case 'item/completed': {
        const item = params.item as Json | undefined;
        if (turn && item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.length >= turn.text.length) turn.text = item.text;
        break;
      }
      case 'error': {
        const err = params.error as Json | undefined;
        if (turn && err && !params.willRetry) turn.lastError = { message: String(err.message ?? 'error'), info: err.codexErrorInfo };
        break;
      }
      case 'turn/completed': {
        if (!turn) break;
        const t = params.turn as Json;
        const status = t?.status as string;
        if (status === 'completed') turn.resolve(turn.text);
        else {
          const e = (t?.error as Json | null) ?? null;
          const info = e?.codexErrorInfo ?? turn.lastError?.info;
          const message = String(e?.message ?? turn.lastError?.message ?? `Turn ${status}`);
          turn.reject(this.mapError(info, message, status));
        }
        break;
      }
      case 'account/rateLimits/updated': {
        const snap = params.rateLimits as RateSnapshot | undefined;
        if (snap && this.rate) this.rate = { ...this.rate, rateLimits: { ...this.rate.rateLimits, ...Object.fromEntries(Object.entries(snap).filter(([, v]) => v != null)) } as RateSnapshot };
        break;
      }
      default: break;
    }
  }

  private mapError(info: unknown, message: string, status?: string): ProviderError {
    const key = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : '';
    if (status === 'interrupted') return new ProviderError('aborted', 'Request cancelled.');
    if (key === 'usageLimitExceeded') {
      this.usageLimitHit = true; this.rateAt = 0;
      return new ProviderError('quota', 'Your ChatGPT plan usage limit was reached. Captured transcript is safe; AI features resume after the limit resets.');
    }
    if (key === 'rateLimitExceeded' || key === 'serverOverloaded') return new ProviderError('rate_limit', `ChatGPT is rate-limiting requests (${message}). Try again shortly.`, true);
    if (key === 'unauthorized') return new ProviderError('auth', 'Codex is not signed in (or the session expired). Run "codex login" and choose Sign in with ChatGPT.');
    if (key === 'httpConnectionFailed' || key === 'responseStreamConnectionFailed' || key === 'responseStreamDisconnected') return new ProviderError('network', `Network problem reaching ChatGPT: ${message}`, true);
    return new ProviderError('bad_response', message, true);
  }

  // ------------------------------------------------------------------ status & quota
  private quota(): QuotaInfo { return evaluateCodexQuota(this.rate, this.cfg().allowCredits, this.usageLimitHit); }

  async status(refresh = false): Promise<ProviderStatus> {
    const base = { id: this.id, label: this.label, checkedAt: Date.now() };
    try {
      await this.ensure();
      if (refresh || !this.account || Date.now() - this.rateAt > 60_000) {
        const acct = await this.request('account/read', { refreshToken: false });
        const a = acct.account as Json | null;
        this.account = a ? { type: String(a.type), email: (a.email as string) ?? null, planType: (a.planType as string) ?? null } : null;
        try {
          const rl = await this.request('account/rateLimits/read', undefined);
          this.rate = rl as unknown as RateLimits;
          if (this.rate.ordinaryUsageAllowed === true && !(this.rate.rateLimits.primary?.usedPercent! >= 100)) this.usageLimitHit = false;
        } catch { this.rate = null; }
        this.rateAt = Date.now();
        if (!this.models.length) {
          const ml = await this.request('model/list', { limit: 50 });
          this.models = ((ml.data as Json[]) ?? []).filter((m) => !m.hidden).map((m) => ({ id: String(m.id), name: String(m.displayName ?? m.id), isDefault: !!m.isDefault, efforts: ((m.supportedReasoningEfforts as Json[]) ?? []).map((e) => String(e.reasoningEffort)) }));
        }
      }
      const model = this.pickModel();
      const quota = this.quota();
      if (!this.account) {
        return this.lastStatus = { ...base, billing: 'none', billingLabel: 'Not signed in', state: 'signed_out', ready: false, quota, model,
          message: 'Codex is not signed in.', setupHint: 'In Terminal run: codex login  → choose "Sign in with ChatGPT". Chumi never sees your credentials.' };
      }
      if (this.account.type !== 'chatgpt') {
        return this.lastStatus = { ...base, billing: 'api', billingLabel: 'API key (paid) — blocked', state: 'error', ready: false, quota, model,
          account: null, message: 'Codex is signed in with an API key, which bills per request. Chumi only uses Codex with a ChatGPT plan sign-in.',
          setupHint: 'Run "codex logout" then "codex login" and choose Sign in with ChatGPT.' };
      }
      const plan = this.account.planType;
      const blocked = !!quota.exhausted && !quota.credits?.willUse;
      return this.lastStatus = {
        ...base,
        billing: quota.credits?.willUse ? 'credits' : 'subscription',
        billingLabel: quota.credits?.willUse ? 'ChatGPT credits (may cost money)' : `Subscription — ChatGPT ${plan ? plan[0].toUpperCase() + plan.slice(1) : ''} plan`.trim(),
        state: blocked ? 'quota_blocked' : 'ready', ready: !blocked,
        account: this.account.email, plan, model, models: this.models.map(({ id, name }) => ({ id, name })), quota,
        message: blocked ? quota.note : undefined,
      };
    } catch (e) {
      const err = e as ProviderError;
      return this.lastStatus = { ...base, billing: 'none', billingLabel: 'Unavailable', state: err.kind === 'unavailable' && /not found/.test(err.message) ? 'not_installed' : 'error', ready: false,
        quota: { known: false, summary: 'Quota information unavailable.' }, message: err.message };
    }
  }

  private pickModel(): string | null {
    const want = this.cfg().model;
    if (want && this.models.some((m) => m.id === want)) return want;
    return this.models.find((m) => m.isDefault)?.id ?? this.models[0]?.id ?? want ?? null;
  }

  private effortFor(model: string | null, want: string): string {
    return clampEffort(this.models.find((m) => m.id === model)?.efforts ?? [], want);
  }

  // ------------------------------------------------------------------ inference
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    return new Promise<CompletionResult>((resolve, reject) => {
      let settled = false;
      let threadId: string | null = null;
      let pt: PendingTurn | null = null;
      let interruptWhenReady = false;
      let interrupted = false;
      let unsubscribed = false;
      const unsubscribe = () => {
        if (!threadId || unsubscribed) return;
        unsubscribed = true;
        void this.request('thread/unsubscribe', { threadId }, 5000).catch(() => {});
      };
      const interrupt = () => {
        if (!threadId || !pt?.turnId || interrupted) return;
        interrupted = true;
        void this.request('turn/interrupt', { threadId, turnId: pt.turnId }).catch(() => {});
      };
      const cleanup = () => {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        if (threadId) this.turns.delete(threadId);
        unsubscribe();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const stop = (error: Error) => {
        if (settled) return;
        // turn/start may already be in flight; interrupt as soon as its id arrives.
        interruptWhenReady = true;
        interrupt();
        fail(error);
      };
      const onAbort = () => stop(new ProviderError('aborted', 'Request cancelled.'));
      const timer = setTimeout(() => stop(new ProviderError('network', 'ChatGPT did not finish within 3 minutes.', true)), 180_000);
      req.signal?.addEventListener('abort', onAbort, { once: true });
      if (req.signal?.aborted) { onAbort(); return; }

      const run = async () => {
        const st = this.lastStatus && Date.now() - this.lastStatus.checkedAt < 60_000 ? this.lastStatus : await this.status();
        if (settled) return;
        if (st.state === 'signed_out') throw new ProviderError('auth', `${st.message} ${st.setupHint ?? ''}`.trim());
        if (st.state === 'quota_blocked') throw new ProviderError('quota_gate', st.message ?? 'Included plan usage is exhausted.');
        if (!st.ready) throw new ProviderError('unavailable', st.message ?? 'Codex is not ready.', true);
        await this.ensure();
        if (settled) return;
        const model = this.pickModel();
        const effort = this.effortFor(model, req.effort ?? 'low');
        const started = await this.request('thread/start', {
          model, cwd: CODEX_WORKDIR, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
          baseInstructions: req.instructions, developerInstructions: null, serviceName: 'chumi',
        });
        threadId = String((started.thread as Json).id);
        if (settled) { unsubscribe(); return; }
        pt = {
          text: '', turnId: null, onDelta: req.onDelta, lastError: null, reject: fail,
          resolve: (text) => {
            if (settled) return;
            settled = true;
            cleanup();
            this.rateAt = 0; // refresh usage after each request
            resolve({ text, provider: this.id, model, billing: st.billing, effort });
          },
        };
        this.turns.set(threadId, pt);
        const response = await this.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: req.input, text_elements: [] }, ...(req.images ?? []).map((im) => ({ type: 'localImage', path: im.path }))],
          effort,
          ...(req.jsonSchema ? { outputSchema: req.jsonSchema } : {}),
        });
        pt.turnId = String(((response.turn as Json) ?? {}).id ?? '');
        if (interruptWhenReady) interrupt();
      };
      void run().catch((error: Error) => stop(error));
    });
  }

  async shutdown(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    p.stdin?.end();
    stopProcess(p);
  }
}
