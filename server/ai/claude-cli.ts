import { readFileSync } from 'node:fs';
import { aiWorkdir, findClaude } from '../paths.ts';
import { runCommand, spawnCommand, stopProcess } from '../platform.ts';
import { ProviderError, type AIProvider, type CompletionRequest, type CompletionResult, type ProviderStatus } from './provider.ts';

/*
 * Claude plan access through the unmodified Claude Code CLI in print mode (`claude -p`).
 *
 * Per Anthropic's support docs, `claude -p` signed in with a Claude plan draws from the plan's usage
 * limits. Sign-in happens only through Anthropic's own flow (`claude auth login`); Chumi never touches
 * Claude credentials. Anthropic directs developers of distributed products to API keys, so this adapter is
 * for personal use by the signed-in user only.
 *
 * Billing safety:
 * - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN and cloud-provider switches are removed from the child
 *   environment (otherwise Claude Code would silently bill the API instead of the plan).
 * - `--bare` is NOT used: it disables OAuth and forces API-key auth.
 * - The stream's init message reports the API key source; anything other than "none" aborts the request.
 * - rate_limit_event messages are watched; if Claude Code reports overage (paid extra usage) the request
 *   result is discarded and the provider blocks until the user re-enables it.
 */

const STRIP_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_PROFILE'];

interface RateInfo { status?: string; resetsAt?: number; rateLimitType?: string; isUsingOverage?: boolean; overageStatus?: string; utilization?: number }

/** A request that prints nothing for this long is stuck; none may take longer than the cap. Either frees its AI queue slot. */
const IDLE_MS = 5 * 60_000;
const OVERALL_MS = 15 * 60_000;

export class ClaudeCliProvider implements AIProvider {
  readonly id = 'claude-cli';
  readonly label = 'Claude plan (via Claude Code CLI)';
  /** Images are sent as base64 content blocks through `--input-format stream-json`. */
  readonly supportsImages = true;
  private cfg: () => { model: string };
  private lastRate: RateInfo | null = null;
  private overageBlocked = false;
  private lastStatus: ProviderStatus | null = null;
  private limits: { idleMs: number; overallMs: number };

  constructor(cfg: () => { model: string }, limits: { idleMs?: number; overallMs?: number } = {}) {
    this.cfg = cfg;
    this.limits = { idleMs: limits.idleMs ?? IDLE_MS, overallMs: limits.overallMs ?? OVERALL_MS };
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const k of STRIP_ENV) delete env[k];
    return env;
  }

  async status(refresh = false): Promise<ProviderStatus> {
    if (!refresh && this.lastStatus && Date.now() - this.lastStatus.checkedAt < 60_000) return this.lastStatus;
    const base = { id: this.id, label: this.label, checkedAt: Date.now(), model: this.cfg().model };
    const bin = findClaude();
    if (!bin) {
      return this.lastStatus = { ...base, billing: 'none', billingLabel: 'Not installed', state: 'not_installed', ready: false,
        quota: { known: false, summary: 'Quota information unavailable.' }, message: 'Claude Code CLI not found.', setupHint: 'Install Claude Code, then run: claude auth login' };
    }
    const out = (await runCommand(bin, ['auth', 'status'], { env: this.childEnv(), timeoutMs: 15000 })).out;
    let st: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string } = {};
    try { st = JSON.parse(out); } catch { /* older CLI prints text */ }
    const quota = this.quota();
    if (!st.loggedIn) {
      return this.lastStatus = { ...base, billing: 'none', billingLabel: 'Not signed in', state: 'signed_out', ready: false, quota,
        message: 'The Claude Code CLI is not signed in.', setupHint: 'In Terminal run: claude auth login  (sign in with your Claude Pro/Max account). Chumi never sees your credentials.' };
    }
    const method = (st.authMethod || '').toLowerCase();
    if (/api|key|console/.test(method)) {
      return this.lastStatus = { ...base, billing: 'api', billingLabel: 'API key (paid) — blocked', state: 'error', ready: false, quota,
        message: `Claude Code is authenticated with "${st.authMethod}", which is billed per request. Chumi only uses this adapter with a Claude plan sign-in.`,
        setupHint: 'Run "claude auth logout" then "claude auth login" with your Claude subscription.' };
    }
    if (this.overageBlocked) {
      return this.lastStatus = { ...base, billing: 'subscription', billingLabel: 'Subscription — Claude plan', state: 'quota_blocked', ready: false, quota, plan: st.subscriptionType ?? null,
        message: 'Claude Code reported paid extra usage (overage). Chumi paused AI requests so nothing is charged beyond your plan. Re-select the provider in Settings to resume after your limit resets.' };
    }
    const rejected = this.lastRate?.status === 'rejected' && (!this.lastRate.resetsAt || this.lastRate.resetsAt * 1000 > Date.now());
    return this.lastStatus = {
      ...base, billing: 'subscription', billingLabel: `Subscription — Claude ${st.subscriptionType ?? ''} plan`.replace('  ', ' ').trim(),
      state: rejected ? 'quota_blocked' : 'ready', ready: !rejected, quota, plan: st.subscriptionType ?? null, account: st.email ?? null,
      message: rejected ? quota.summary : undefined,
    };
  }

  private quota() {
    const r = this.lastRate;
    if (!r) return { known: false, summary: 'Claude Code does not report remaining plan allowance to other apps; status appears after the first request.' };
    const reset = r.resetsAt ? `, resets ${new Date(r.resetsAt * 1000).toLocaleString()}` : '';
    const util = typeof r.utilization === 'number' ? ` (${Math.round(r.utilization * 100)}% used)` : '';
    const LABELS: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly limit (Opus)', seven_day_sonnet: 'Weekly limit (Sonnet)' };
    return {
      windows: typeof r.utilization === 'number' ? [{ label: LABELS[r.rateLimitType ?? ''] ?? 'Plan limit', usedPercent: Math.round(r.utilization * 100), resetsAt: r.resetsAt ? r.resetsAt * 1000 : null }] : undefined,
      known: typeof r.utilization === 'number',
      summary: `Last reported ${r.rateLimitType ?? 'plan'} limit status: ${r.status ?? 'unknown'}${util}${reset}.`,
      exhausted: r.status === 'rejected',
      note: 'Remaining allowance is not exposed; Chumi shows only what Claude Code reports with each response.',
    };
  }

  /** Re-enable after an overage block (explicit user action). */
  clearOverageBlock(): void { this.overageBlocked = false; this.lastStatus = null; }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const st = await this.status();
    if (!st.ready) throw new ProviderError(st.state === 'signed_out' ? 'auth' : st.state === 'quota_blocked' ? 'quota_gate' : 'unavailable', `${st.message ?? 'Claude is not ready.'} ${st.setupHint ?? ''}`.trim());
    const bin = findClaude()!;
    const model = this.cfg().model;
    let instructions = req.instructions;
    if (req.jsonSchema) instructions += `\n\nReturn ONLY a JSON object (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model,
      '--system-prompt', instructions, '--tools', '', '--strict-mcp-config', '--no-session-persistence'];
    const effort = req.effort && !/haiku/i.test(model) ? req.effort : null;
    if (effort) args.push('--effort', effort);
    // One user message: screen captures (if any) as image blocks, then the text. Read before spawning, so a missing file leaves no child behind.
    const content = [
      ...(req.images ?? []).map((im) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(im.path).toString('base64') } })),
      { type: 'text', text: req.input },
    ];
    if (req.signal?.aborted) throw new ProviderError('aborted', 'Request cancelled.');
    const proc = spawnCommand(bin, args, { cwd: aiWorkdir(), env: this.childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => { stopProcess(proc); killTimer ??= setTimeout(() => stopProcess(proc, 'SIGKILL'), 2000); };
    let timedOut: string | null = null;
    const expire = (why: string) => { timedOut ??= why; stop(); };
    const { idleMs, overallMs } = this.limits;
    const minutes = (ms: number) => `${Math.round(ms / 6000) / 10} min`;
    const arm = () => setTimeout(() => expire(`Claude Code sent nothing for ${minutes(idleMs)}; the request was stopped.`), idleMs);
    let idle = arm();
    const cap = setTimeout(() => expire(`Claude Code did not finish within ${minutes(overallMs)}; the request was stopped.`), overallMs);
    const alive = () => { clearTimeout(idle); idle = arm(); };
    proc.stdin!.on('error', () => { /* the process already exited; reported below */ });
    proc.stdin!.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    const onAbort = () => stop();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    let text = '', result: string | null = null, errMsg: string | null = null, buf = '', stderr = '';
    let billingViolation: string | null = null;
    const onLine = (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      let m: Record<string, any>;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'system' && m.subtype === 'init' && m.apiKeySource && m.apiKeySource !== 'none') {
        billingViolation = `Claude Code is using an API key (${m.apiKeySource}); request aborted to avoid API billing.`;
        stop();
      } else if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
        text += m.event.delta.text; req.onDelta?.(m.event.delta.text);
      } else if (m.type === 'rate_limit_event' && m.rate_limit_info) {
        this.lastRate = m.rate_limit_info as RateInfo;
        if (this.lastRate.isUsingOverage) { this.overageBlocked = true; this.lastStatus = null; }
      } else if (m.type === 'result') {
        if (m.is_error) errMsg = String(m.result ?? m.subtype ?? 'error'); else result = String(m.result ?? '');
      }
    };
    proc.stderr!.on('data', (d: Buffer) => { alive(); stderr = (stderr + d.toString()).slice(-2000); });
    proc.stdout!.on('data', (d: Buffer) => {
      alive();
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    // 'close' comes after stdout is fully read, so the final result line is never missed. If something the CLI
    // started keeps the pipes open after it exits, stop waiting shortly after the exit.
    const done = await new Promise<{ code: number | null; error: Error | null }>((resolve) => {
      let lingering: NodeJS.Timeout | undefined;
      const finish = (v: { code: number | null; error: Error | null }) => { clearTimeout(lingering); resolve(v); };
      proc.on('error', (error) => finish({ code: null, error }));
      proc.on('exit', (code) => { lingering = setTimeout(() => finish({ code, error: null }), 5000); });
      proc.on('close', (code) => finish({ code, error: null }));
    });
    clearTimeout(idle); clearTimeout(cap); clearTimeout(killTimer);
    onLine(buf);
    const code = done.code;
    req.signal?.removeEventListener('abort', onAbort);
    if (req.signal?.aborted) throw new ProviderError('aborted', 'Request cancelled.');
    if (billingViolation) throw new ProviderError('billing_safety', billingViolation);
    if (this.overageBlocked) throw new ProviderError('quota_gate', 'Claude Code reported paid extra usage; Chumi discarded the result and paused AI requests to avoid charges.');
    if (done.error) throw new ProviderError('unavailable', `Could not run Claude Code: ${done.error.message}`, true);
    if (timedOut) throw new ProviderError('network', timedOut, true);
    if (errMsg) {
      if (/rate.?limit|usage limit|limit reached|429/i.test(errMsg)) throw new ProviderError('quota', `Claude plan limit reached: ${errMsg}`);
      if (/auth|log ?in|credential|401/i.test(errMsg)) throw new ProviderError('auth', `Claude Code authentication problem: ${errMsg}. Run "claude auth login".`);
      throw new ProviderError('bad_response', errMsg, true);
    }
    if (result === null) throw new ProviderError('network', `Claude Code exited (code ${code}) without a result. ${stderr.slice(-300)}`, true);
    return { text: result || text, provider: this.id, model, billing: 'subscription', effort };
  }

  async shutdown(): Promise<void> { /* stateless */ }
}
