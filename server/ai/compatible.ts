import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { COMPATIBLE_PRESETS, validateCompatibleSettings, type CompatiblePreset, type CompatibleProfile, type CompatibleSettings } from '../../shared/compatible-provider.ts';
import { readCompatibleKey } from './compatible-credentials.ts';
import { ProviderError, parseJsonLoose, type AIProvider, type CompletionRequest, type CompletionResult, type ProviderStatus, type InputBudget } from './provider.ts';

interface Config { preset: CompatiblePreset; profile: CompatibleProfile; local: boolean; fingerprint: string }
interface Dependencies { fetch?: typeof fetch; readKey?: typeof readCompatibleKey; timeoutMs?: number; firstByteMs?: number; statusMs?: number }
interface Waiter { priority: number; signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: Error) => void; abort: () => void }
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const cloudModel = (model: string): boolean => /(?:^|[-:])cloud(?:$|[-:])/i.test(model);
const cancelled = () => new ProviderError('aborted', 'Request cancelled.');
const badResponse = (message: string) => new ProviderError('bad_response', message);
/** Over the whole answer, in case a server streams very slowly but steadily. */
const OVERALL_CAP_MS = 15 * 60_000;

/** Approximate text tokens, with headroom for templates and tokenizer differences. */
export function estimateContextTokens(text: string): number {
  let latin = 0, other = 0;
  for (const char of text) { if (char.codePointAt(0)! < 128) latin++; else other++; }
  return Math.ceil((latin / 4 + other / 1.3) * 1.15) + 256;
}

/** The answer without a leading <think>…</think> block (local reasoning models may put one in the text). */
export function visibleAnswer(text: string): string {
  const lead = text.trimStart();
  if (lead.startsWith('<think>')) { const end = lead.indexOf('</think>'); return end < 0 ? '' : lead.slice(end + 8).trimStart(); }
  return '<think>'.startsWith(lead) && lead ? '' : text;
}

/** Await even an injected/non-cooperative transport without losing prompt cancellation. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

function httpError(status: number, fields: string[] = [], preset?: CompatiblePreset): ProviderError {
  // GLM uses numeric business codes inside HTTP 400/429 responses.
  const glmCodes: Record<string, string> = { '1113': 'insufficient_balance', '1211': 'model_not_found', '1261': 'input_too_long' };
  const codes = fields.map((field) => preset === 'glm' ? glmCodes[field] ?? field.toLowerCase() : field.toLowerCase());
  if (codes.some((code) => ['insufficient_quota', 'insufficient_balance', 'arrearage', 'quota_exceeded', 'credit_balance_too_low'].includes(code))) return new ProviderError('quota', 'The model API has no available credit or quota. Check its billing console before retrying.');
  if (codes.some((code) => ['model_not_found', 'invalid_model', 'model_not_exist', 'modelnotfound'].includes(code))) return new ProviderError('bad_response', 'The model server could not find the selected model. Check the model ID and your account’s access to it.');
  if (codes.some((code) => ['context_length_exceeded', 'context_window_exceeded', 'input_too_long'].includes(code))) return new ProviderError('bad_response', 'The request exceeds the model’s context length. Choose a shorter time range or raise the model server’s context limit.');
  if (codes.includes('max_tokens_exceeded')) return new ProviderError('bad_response', 'The model’s output limit is lower than the requested answer allowance. Reduce Max output tokens in Other model settings.');
  if (status === 401 || status === 403) return new ProviderError('auth', 'The model server rejected authentication. Check the key saved for this server URL.');
  if (status === 402) return new ProviderError('quota', 'The model API requires available credit. Check its billing console.');
  if (status === 429) return new ProviderError('rate_limit', 'The model server rate limit was reached.');
  return new ProviderError(status >= 500 ? 'unavailable' : 'bad_response', `The model server returned HTTP ${status}. No retry was sent.`);
}

/** Read only bounded structured codes. Never display free server text, which may echo credentials. */
async function responseError(response: Response, signal: AbortSignal, preset: CompatiblePreset): Promise<ProviderError> {
  const reader = response.body?.getReader();
  if (!reader) return httpError(response.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
    while (size < 4096) {
      const chunk = await abortable(reader.read(), bounded);
      if (chunk.done) {
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!object(payload)) break;
        const error = object(payload.error) ? payload.error : payload;
        return httpError(response.status, [error.code, error.type, error.param].filter((value) => typeof value === 'string' || typeof value === 'number').map(String), preset);
      }
      if (size + chunk.value.length > 4096) break;
      chunks.push(chunk.value); size += chunk.value.length;
    }
  } catch { /* Malformed or stalled errors still have a useful HTTP status. */ }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  return httpError(response.status);
}

/** One adapter, one explicitly selected endpoint. No provider fallback, retries, or reasoning extensions. */
export class CompatibleProvider implements AIProvider {
  readonly id = 'compatible';
  private cfg: () => CompatibleSettings;
  private fetcher: typeof fetch;
  private readKey: typeof readCompatibleKey;
  private timeoutMs: number;
  private firstByteMs: number;
  private statusMs: number;
  private controllers = new Set<AbortController>();
  private localBusy = false;
  private localRequests = new Map<AbortController, CompletionRequest>();
  private waiters: Waiter[] = [];
  private lastTest: { identity: string; at: number; error?: string } | null = null;

  constructor(cfg: () => CompatibleSettings, deps: Dependencies = {}) {
    this.cfg = cfg;
    this.fetcher = deps.fetch ?? fetch;
    this.readKey = deps.readKey ?? readCompatibleKey;
    this.timeoutMs = deps.timeoutMs ?? 120_000;
    this.statusMs = deps.statusMs ?? 5000;
    this.firstByteMs = deps.firstByteMs ?? 10 * 60_000;
  }

  get label(): string {
    try { const c = this.config(); return `${COMPATIBLE_PRESETS[c.preset].label}${c.local ? ' (local server)' : ' (paid API)'}`; }
    catch { return 'Compatible model server'; }
  }
  get supportsImages(): boolean { try { return this.config().profile.supportsImages; } catch { return false; } }
  invalidateStatus(): void { this.lastTest = null; }

  private config(): Config {
    let settings: CompatibleSettings;
    try { settings = validateCompatibleSettings(this.cfg()); }
    catch { throw new ProviderError('disabled', 'Invalid compatible model settings. Review the saved model profile.'); }
    const { preset } = settings;
    const profile = settings.profiles[preset];
    return { preset, profile, local: COMPATIBLE_PRESETS[preset].local, fingerprint: JSON.stringify({ preset, profile }) };
  }

  private check(c: Config): void {
    if (!c.profile.enabled) throw new ProviderError('disabled', c.local ? 'This local model profile is disabled.' : 'Paid API access is disabled for this profile. Enable it explicitly before sending requests.');
    if (!c.profile.baseUrl || !c.profile.model) throw new ProviderError('disabled', c.local
      ? 'Choose an available local model in Other model settings, then save.'
      : 'Choose a model server URL and model ID first.');
    if (c.preset === 'ollama' && cloudModel(c.profile.model)) throw new ProviderError('billing_safety', 'Ollama cloud models cannot be used by the local provider. Select a downloaded local model.');
  }

  private identity(c: Config, key: string | null): string {
    return createHash('sha256').update(c.fingerprint).update('\0').update(key ?? '').digest('hex');
  }

  private baseStatus(c?: Config): ProviderStatus {
    const local = c?.local ?? false;
    return {
      id: this.id, label: c ? `${COMPATIBLE_PRESETS[c.preset].label}${local ? ' (local server)' : ' (paid API)'}` : this.label, model: c?.profile.model ?? null, checkedAt: Date.now(), state: 'ready', ready: true,
      billing: local ? 'none' : 'api', billingLabel: local ? 'Local server — no Chumi API charge' : 'API billing — charged by your provider',
      quota: { known: false, summary: local ? 'No subscription allowance. Resource use depends on the selected model.' : 'Remaining API allowance is not available. Check your provider billing console.' },
    };
  }

  async status(refresh = false): Promise<ProviderStatus> {
    let c: Config | undefined;
    try {
      c = this.config();
      this.check(c);
      const key = await this.readKey(c.preset, c.profile.baseUrl);
      const base = this.baseStatus(c);
      if (!c.local && !key) return { ...base, state: 'signed_out', ready: false, message: 'No API key saved for this profile and server URL.' };
      const test = this.lastTest?.identity === this.identity(c, key) ? this.lastTest : null;
      const result: ProviderStatus = { ...base, message: test ? 'Connection test succeeded. No meeting content was sent.' : 'Configured; the connection has not been tested. Use Test connection to verify it.' };
      if (refresh && c.local) {
        const probe = AbortSignal.timeout(this.statusMs);
        const response = await this.fetchResponse(c, `${c.profile.baseUrl}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, redirect: 'error' }, probe);
        if (!response.ok) throw await responseError(response, probe, c.preset);
        const body: unknown = await abortable(response.json(), probe).catch((error) => { if (probe.aborted) throw new ProviderError('unavailable', 'Could not check the model server: it took too long to respond. Check the local service and try again.'); throw error; });
        // Ollama answers {"data": null} when no model is downloaded yet; treat that as an empty list.
        if (!object(body) || !(Array.isArray(body.data) || body.data == null)) throw badResponse('The model server returned an invalid model list.');
        const listed = Array.isArray(body.data) ? body.data : [];
        result.models = listed.filter((m): m is Json & { id: string } => object(m) && typeof m.id === 'string' && !(c!.preset === 'ollama' && cloudModel(m.id)))
          .map((m) => ({ id: m.id, name: m.id }));
        if (!result.models.length) {
          return { ...result, state: 'error', ready: false, message: c.preset === 'ollama'
            ? `Ollama is running, but no models are downloaded yet. In Terminal run: ollama pull ${c.profile.model || '<model>'}`
            : 'The model server is running but lists no models. Load or download a model, then enter its ID.' };
        }
        // Ollama resolves a bare name to its ":latest" tag.
        const installed = (id: string) => id === c!.profile.model || id === `${c!.profile.model}:latest`;
        if (c.preset === 'ollama' && !result.models.some((m) => installed(m.id))) {
          return { ...result, state: 'error', ready: false, message: `The model "${c.profile.model}" is not downloaded in Ollama. Downloaded: ${result.models.slice(0, 6).map((m) => m.id).join(', ')}. Pick one of these, or run: ollama pull ${c.profile.model}` };
        }
        if (!test || test.error) {
          this.lastTest = null;
          result.message = 'Model server reached; a completion has not been tested yet.';
        }
      } else if (test?.error) {
        return { ...result, state: 'error', ready: false, message: test.error };
      }
      return result;
    } catch (error) {
      const message = error instanceof ProviderError ? error.message : 'Could not check the model server. Check its settings and try again.';
      return { ...this.baseStatus(c), state: error instanceof ProviderError && error.kind === 'disabled' ? 'disabled' : 'error', ready: false, message };
    }
  }

  async testConnection(): Promise<ProviderStatus> {
    let c: Config | undefined;
    let key: string | null = null;
    try {
      c = this.config(); this.check(c);
      key = await this.readKey(c.preset, c.profile.baseUrl);
      await this.run({ task: 'connection-test', instructions: 'This is a connection test. Reply with OK only.', input: 'Reply with OK.' }, c);
      this.lastTest = { identity: this.identity(c, key), at: Date.now() };
      return { ...this.baseStatus(c), message: 'Connection test succeeded. No meeting content was sent.' };
    } catch (error) {
      const message = error instanceof ProviderError ? error.message : 'The connection test failed. Check your model server settings.';
      if (c) this.lastTest = { identity: this.identity(c, key), at: Date.now(), error: message };
      return { ...this.baseStatus(c), state: 'error', ready: false, message };
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> { return this.run(req, this.config()); }

  private system(req: Pick<CompletionRequest, 'instructions' | 'jsonSchema'>): string {
    return req.instructions + (req.jsonSchema ? `\n\nReturn ONLY a JSON object (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(req.jsonSchema)}` : '');
  }

  private outputTokens(c: Config): number { return c.local ? Math.min(c.profile.maxOutputTokens, Math.floor(c.profile.contextTokens / 4)) : c.profile.maxOutputTokens; }

  inputBudget(req: Pick<CompletionRequest, 'instructions' | 'jsonSchema' | 'images'>): InputBudget | null {
    const c = this.config();
    if (!c.local) return null;
    return { tokens: c.profile.contextTokens - this.outputTokens(c) - (req.images?.length ?? 0) * 4096 - estimateContextTokens(this.system(req) + '\n'), estimate: (text) => estimateContextTokens(text) - 256 };
  }

  prioritize(priority: number): void {
    if (priority < 8) return;
    for (const [controller, req] of this.localRequests) if (this.priority(req) < 8) { const error = cancelled(); error.preempted = true; controller.abort(error); }
  }

  private priority(req: CompletionRequest): number { return req.priority ?? (['overview', 'auto_explain'].includes(req.task) ? 2 : 10); }

  private acquireLocal(signal: AbortSignal, priority: () => number): Promise<() => void> {
    if (signal.aborted) return Promise.reject(cancelled());
    if (!this.localBusy) { this.localBusy = true; return Promise.resolve(() => this.releaseLocal()); }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { get priority() { return priority(); }, signal, resolve, reject, abort: () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(cancelled());
      } };
      this.waiters.push(waiter);
      this.waiters.sort((a, b) => b.priority - a.priority);
      signal.addEventListener('abort', waiter.abort, { once: true });
    });
  }

  private releaseLocal(): void {
    this.waiters.sort((a, b) => b.priority - a.priority);
    const waiter = this.waiters.shift();
    if (!waiter) { this.localBusy = false; return; }
    waiter.signal.removeEventListener('abort', waiter.abort);
    if (waiter.signal.aborted) { waiter.reject(cancelled()); this.releaseLocal(); return; }
    waiter.resolve(() => this.releaseLocal());
  }

  private ensureUnchanged(c: Config): void {
    if (this.config().fingerprint !== c.fingerprint) throw new ProviderError('disabled', 'Model settings changed while this request was waiting. Submit it again with the selected settings.');
  }

  private async fetchResponse(c: Config, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try { return await abortable(this.fetcher(url, { ...init, signal }), signal); }
    catch (error) {
      if (signal.aborted) {
        if (signal.reason?.name === 'TimeoutError') throw new ProviderError('unavailable', 'Could not check the model server: it took too long to respond. Check the local service and try again.');
        throw error;
      }
      if (!c.local) throw error;
      const refused = (value: unknown): boolean => object(value) && (value.code === 'ECONNREFUSED' || refused(value.cause) || Array.isArray(value.errors) && value.errors.some(refused));
      if (!refused(error)) throw new ProviderError('unavailable', 'The local model connection failed before it could answer. Check the model server for a crash, loading error, or connection problem, then try again.');
      throw new ProviderError('unavailable', c.preset === 'ollama'
        ? 'Ollama is not responding. Open the Ollama app or run ollama serve, check the server URL in Other model settings, then try again.'
        : 'LM Studio is not responding. Open LM Studio → Developer and turn on Start server, check the server URL in Other model settings, then try again.');
    }
  }

  private async checkOllama(c: Config, signal: AbortSignal, key: string | null): Promise<void> {
    const root = c.profile.baseUrl.replace(/\/v1$/, '');
    const response = await this.fetchResponse(c, `${root}/api/show`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model: c.profile.model }), signal, redirect: 'error',
    }, signal);
    if (response.status === 404) throw new ProviderError('unavailable', `The model "${c.profile.model}" is not downloaded in Ollama. In Terminal run: ollama pull ${c.profile.model}`);
    if (!response.ok) throw new ProviderError('unavailable', 'Could not verify that this Ollama model is installed locally. Check the model ID and local server.');
    const body: unknown = await abortable(response.json(), signal);
    if (!object(body)) throw badResponse('Ollama returned invalid model metadata.');
    if (body.remote_host || body.remote_model || body.remoteHost || body.remoteModel) throw new ProviderError('billing_safety', 'This Ollama model uses a remote server. Select a downloaded local model.');
    if (!object(body.model_info) || !Object.keys(body.model_info).length) throw new ProviderError('billing_safety', 'Ollama did not confirm local model metadata. The request was not sent.');
    if (c.profile.supportsImages && Array.isArray(body.capabilities) && !body.capabilities.includes('vision')) throw new ProviderError('disabled', 'This Ollama model does not support image input. Turn off image support or choose a vision model.');
  }

  private async run(req: CompletionRequest, c: Config): Promise<CompletionResult> {
    this.check(c);
    if (req.signal?.aborted) throw cancelled();
    if (req.images?.length && !c.profile.supportsImages) throw new ProviderError('disabled', 'The selected model profile does not support screen captures.');
    const system = this.system(req);
    const budget = this.inputBudget(req);
    if (budget && budget.estimate(req.input) > budget.tokens) {
      throw new ProviderError('unavailable', 'This request still exceeds the local context limit after allowing room for the answer. Increase Context length in Other model settings, or reduce attached images or custom instructions. In LM Studio, also raise the loaded model’s context length.');
    }
    const outputTokens = this.outputTokens(c);
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.signal?.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    let timedOut: 'first' | 'idle' | 'overall' | null = null;
    let idle: NodeJS.Timeout | undefined, cap: NodeJS.Timeout | undefined;
    const expire = (phase: 'first' | 'idle' | 'overall') => { timedOut ??= phase; controller.abort(); };
    // Local loading and prefill get a separate deadline; queue time does not count.
    const alive = () => { clearTimeout(idle); idle = setTimeout(() => expire('idle'), this.timeoutMs); };
    let release: (() => void) | undefined;
    const signal = controller.signal;
    try {
      if (c.local) {
        const priority = () => this.priority(req);
        this.prioritize(priority());
        this.localRequests.set(controller, req);
        release = await this.acquireLocal(signal, priority);
      }
      idle = setTimeout(() => expire(c.local ? 'first' : 'idle'), c.local ? this.firstByteMs : this.timeoutMs);
      cap = setTimeout(() => expire('overall'), OVERALL_CAP_MS);
      this.ensureUnchanged(c);
      const key = await abortable(this.readKey(c.preset, c.profile.baseUrl), signal);
      if (!c.local && !key) throw new ProviderError('auth', 'No API key saved for this profile and server URL.');
      if (c.preset === 'ollama') await this.checkOllama(c, signal, key);
      const imageData = await Promise.all((req.images ?? []).map(async (im) => (await readFile(im.path, { signal })).toString('base64')));
      const images = imageData.map((data) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }));
      const ollama = c.preset === 'ollama';
      const body: Json = ollama ? {
        model: c.profile.model, stream: true, options: { ...(c.profile.contextExplicit ? { num_ctx: c.profile.contextTokens } : {}), num_predict: outputTokens },
        messages: [{ role: 'system', content: system }, { role: 'user', content: req.input, ...(imageData.length ? { images: imageData } : {}) }],
        ...(req.jsonSchema && c.profile.structuredOutput !== 'prompt' ? { format: c.profile.structuredOutput === 'json_schema' ? req.jsonSchema : 'json' } : {}),
      } : {
        model: c.profile.model, stream: true, max_tokens: outputTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: images.length ? [...images, { type: 'text', text: req.input }] : req.input }],
      };
      // MiniMax documents this extension to keep private reasoning out of visible/structured answers.
      if (c.preset === 'minimax') body.reasoning_split = true;
      if (!ollama && req.jsonSchema && c.profile.structuredOutput === 'json_object') body.response_format = { type: 'json_object' };
      if (!ollama && req.jsonSchema && c.profile.structuredOutput === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'chumi_response', strict: true, schema: req.jsonSchema } };
      this.ensureUnchanged(c);
      if (signal.aborted) throw cancelled();
      const response = await this.fetchResponse(c, ollama ? `${c.profile.baseUrl.replace(/\/v1$/, '')}/api/chat` : `${c.profile.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body), signal, redirect: 'error',
      }, signal);
      if (!response.ok) throw await responseError(response, signal, c.preset);
      let text = await this.readResponse(response, req.onDelta, signal, alive, ollama);
      if (req.jsonSchema) {
        // Small local models often wrap JSON in code fences or a sentence; the callers parse it the same way.
        const parsed = parseJsonLoose(text);
        if (!object(parsed)) throw badResponse('The model did not return valid JSON for the requested structured response.');
        text = JSON.stringify(parsed);
      }
      if (this.lastTest?.error && this.lastTest.identity === this.identity(c, key)) this.lastTest = null;
      return { text, provider: this.id, model: c.profile.model, billing: c.local ? 'none' : 'api', effort: null };
    } catch (error) {
      if (timedOut) throw new ProviderError('unavailable', timedOut === 'first'
        ? 'The local model did not start answering in time. It may still be loading or reading a long request. Try a smaller model or shorter time range.'
        : timedOut === 'overall' ? 'The model request reached its overall time limit and was cancelled. Try a shorter request.'
          : 'The model request timed out (the server stopped sending) and was cancelled. No retry was sent.');
      if (signal.aborted) throw signal.reason instanceof ProviderError ? signal.reason : cancelled();
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('network', 'The model request could not be completed. Check the server connection. No retry was sent.');
    } finally {
      clearTimeout(idle); clearTimeout(cap);
      req.signal?.removeEventListener('abort', abort);
      this.controllers.delete(controller);
      this.localRequests.delete(controller);
      release?.();
    }
  }

  private async readResponse(response: Response, onDelta: CompletionRequest['onDelta'], signal: AbortSignal, alive: () => void = () => {}, ollama = false): Promise<string> {
    let text = '';
    let shown = 0;
    let finished = false;
    const consume = (payload: unknown, streaming: boolean) => {
      if (!object(payload) || payload.error) throw badResponse('The model server returned an error or invalid response.');
      if (ollama) {
        if (typeof payload.done !== 'boolean' || !object(payload.message)) throw badResponse('The model response has no message.');
        payload = { choices: [{ index: 0, [streaming ? 'delta' : 'message']: payload.message, finish_reason: payload.done ? payload.done_reason ?? 'stop' : null }] };
      }
      if (!object(payload) || !Array.isArray(payload.choices)) throw badResponse('The model response has no choices.');
      if (payload.choices.length === 0 && streaming && payload.usage) return;
      if (payload.choices.length !== 1 || !object(payload.choices[0])) throw badResponse('The model response has invalid choices.');
      const choice = payload.choices[0];
      if (choice.index !== undefined && choice.index !== 0) throw badResponse('The model returned an unexpected choice.');
      const message = streaming ? choice.delta : choice.message;
      if (!object(message)) throw badResponse('The model response has no message.');
      if (message.refusal || choice.finish_reason === 'content_filter' || choice.finish_reason === 'refusal') throw badResponse('The model declined this request.');
      if (message.tool_calls || message.function_call) throw badResponse('The model returned a tool call instead of an answer.');
      if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') throw badResponse('The model returned invalid answer content.');
      if (typeof message.content === 'string' && message.content) {
        if (finished) throw badResponse('The model returned text after completing its answer.');
        text += message.content;
        if (text.length > 4_000_000) throw badResponse('The model response exceeded the size limit.');
        const visible = visibleAnswer(text);
        if (visible.length > shown) { onDelta?.(visible.slice(shown)); shown = visible.length; }
      }
      if (choice.finish_reason != null) {
        if (choice.finish_reason !== 'stop') throw badResponse(choice.finish_reason === 'length' ? 'The model answer was cut off at its output limit. Increase the output limit or shorten the request.' : 'The model did not finish with a complete answer.');
        finished = true;
      }
    };
    if (!ollama && !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      let payload: unknown;
      try { payload = await abortable(response.json(), signal); } catch (error) { if (signal.aborted) throw cancelled(); throw badResponse('The model server returned invalid JSON.'); }
      consume(payload, false);
    } else {
      if (!response.body) throw badResponse('The model stream was empty.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '';
      let data: string[] = [];
      let event = '';
      let done = false;
      const line = (raw: string) => {
        const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (ollama) {
          if (!value.trim()) return;
          let payload: unknown;
          try { payload = JSON.parse(value); } catch { throw badResponse('The model stream contained invalid JSON.'); }
          consume(payload, true);
          done = finished;
          return;
        }
        if (!value) {
          if (event === 'error') throw badResponse('The model server returned an error event.');
          if (data.length) {
            const joined = data.join('\n');
            if (joined === '[DONE]') done = true;
            else {
              let payload: unknown;
              try { payload = JSON.parse(joined); } catch { throw badResponse('The model stream contained invalid JSON.'); }
              consume(payload, true);
            }
          }
          data = []; event = ''; return;
        }
        if (value.startsWith(':')) return;
        const colon = value.indexOf(':');
        const field = colon < 0 ? value : value.slice(0, colon);
        const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') data.push(content);
        if (field === 'event') event = content;
      };
      try {
        while (!done) {
          const chunk = await abortable(reader.read(), signal);
          alive();
          if (chunk.done) {
            // A last event may lack its trailing newline or blank line.
            buffer += decoder.decode();
            if (buffer) { line(buffer); buffer = ''; }
            line('');
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 4_000_000) throw badResponse('The model stream exceeded the size limit.');
          let end: number;
          while (!done && (end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
        }
        // finish_reason "stop" already marks a complete answer; only a stream without either is partial.
        if (!done && !finished) throw badResponse('The model stream ended before its completion marker. The partial answer was not accepted.');
      } catch (error) {
        if (error instanceof ProviderError || signal.aborted) throw error;
        throw badResponse('The model stream was interrupted or contained invalid UTF-8.');
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    if (!finished) throw badResponse('The model did not confirm that its answer was complete.');
    const answer = visibleAnswer(text);
    if (!answer.trim()) throw badResponse('The model returned an empty answer.');
    return answer;
  }

  async shutdown(): Promise<void> { for (const controller of this.controllers) controller.abort(); }
}
