import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { COMPATIBLE_PRESETS, validateCompatibleSettings, type CompatiblePreset, type CompatibleProfile, type CompatibleSettings } from '../../shared/compatible-provider.ts';
import { readCompatibleKey } from './compatible-credentials.ts';
import { ProviderError, parseJsonLoose, type AIProvider, type CompletionRequest, type CompletionResult, type ProviderStatus } from './provider.ts';

interface Config { preset: CompatiblePreset; profile: CompatibleProfile; local: boolean; fingerprint: string }
interface Dependencies { fetch?: typeof fetch; readKey?: typeof readCompatibleKey; timeoutMs?: number }
interface Waiter { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: Error) => void; abort: () => void }
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const cloudModel = (model: string): boolean => /(?:^|[-:])cloud(?:$|[-:])/i.test(model);
const cancelled = () => new ProviderError('aborted', 'Request cancelled.');
const badResponse = (message: string) => new ProviderError('bad_response', message);
/** Over the whole answer, in case a server streams very slowly but steadily. */
const OVERALL_CAP_MS = 15 * 60_000;

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

function httpError(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('auth', 'The model server rejected authentication. Check the key saved for this server URL.');
  if (status === 402) return new ProviderError('quota', 'The model API requires available credit. Check its billing console.');
  if (status === 429) return new ProviderError('rate_limit', 'The model server rate limit was reached.');
  return new ProviderError(status >= 500 ? 'unavailable' : 'bad_response', `The model server returned HTTP ${status}. No retry was sent.`);
}

/** One adapter, one explicitly selected endpoint. No provider fallback, retries, or reasoning extensions. */
export class CompatibleProvider implements AIProvider {
  readonly id = 'compatible';
  private cfg: () => CompatibleSettings;
  private fetcher: typeof fetch;
  private readKey: typeof readCompatibleKey;
  private timeoutMs: number;
  private controllers = new Set<AbortController>();
  private localBusy = false;
  private waiters: Waiter[] = [];
  private lastTest: { identity: string; at: number; error?: string } | null = null;

  constructor(cfg: () => CompatibleSettings, deps: Dependencies = {}) {
    this.cfg = cfg;
    this.fetcher = deps.fetch ?? fetch;
    this.readKey = deps.readKey ?? readCompatibleKey;
    this.timeoutMs = deps.timeoutMs ?? 120_000;
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
        const response = await this.fetcher(`${c.profile.baseUrl}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!response.ok) throw httpError(response.status);
        const body: unknown = await response.json();
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

  private acquireLocal(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(cancelled());
    if (!this.localBusy) { this.localBusy = true; return Promise.resolve(() => this.releaseLocal()); }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject, abort: () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(cancelled());
      } };
      this.waiters.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
    });
  }

  private releaseLocal(): void {
    const waiter = this.waiters.shift();
    if (!waiter) { this.localBusy = false; return; }
    waiter.signal.removeEventListener('abort', waiter.abort);
    if (waiter.signal.aborted) { waiter.reject(cancelled()); this.releaseLocal(); return; }
    waiter.resolve(() => this.releaseLocal());
  }

  private ensureUnchanged(c: Config): void {
    if (this.config().fingerprint !== c.fingerprint) throw new ProviderError('disabled', 'Model settings changed while this request was waiting. Submit it again with the selected settings.');
  }

  private async checkOllama(c: Config, signal: AbortSignal, key: string | null): Promise<void> {
    const root = c.profile.baseUrl.replace(/\/v1$/, '');
    const response = await abortable(this.fetcher(`${root}/api/show`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model: c.profile.model }), signal, redirect: 'error',
    }), signal);
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
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.signal?.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    let timedOut = false;
    let idle: NodeJS.Timeout | undefined, cap: NodeJS.Timeout | undefined;
    const expire = () => { timedOut = true; controller.abort(); };
    // Time spent waiting for another local request does not count; then the server must keep sending.
    const alive = () => { clearTimeout(idle); idle = setTimeout(expire, this.timeoutMs); };
    let release: (() => void) | undefined;
    const signal = controller.signal;
    try {
      if (c.local) release = await this.acquireLocal(signal);
      alive();
      cap = setTimeout(expire, Math.max(this.timeoutMs, OVERALL_CAP_MS));
      this.ensureUnchanged(c);
      const key = await abortable(this.readKey(c.preset, c.profile.baseUrl), signal);
      if (!c.local && !key) throw new ProviderError('auth', 'No API key saved for this profile and server URL.');
      if (c.preset === 'ollama') await this.checkOllama(c, signal, key);
      const system = req.instructions + (req.jsonSchema ? `\n\nReturn ONLY a JSON object (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(req.jsonSchema)}` : '');
      const images = await Promise.all((req.images ?? []).map(async (im) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${(await readFile(im.path, { signal })).toString('base64')}` } })));
      const body: Json = {
        model: c.profile.model, stream: true, max_tokens: c.profile.maxOutputTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: images.length ? [...images, { type: 'text', text: req.input }] : req.input }],
      };
      // MiniMax documents this extension to keep private reasoning out of visible/structured answers.
      if (c.preset === 'minimax') body.reasoning_split = true;
      if (req.jsonSchema && c.profile.structuredOutput === 'json_object') body.response_format = { type: 'json_object' };
      if (req.jsonSchema && c.profile.structuredOutput === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'chumi_response', strict: true, schema: req.jsonSchema } };
      this.ensureUnchanged(c);
      if (signal.aborted) throw cancelled();
      const response = await abortable(this.fetcher(`${c.profile.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body), signal, redirect: 'error',
      }), signal);
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw httpError(response.status); }
      let text = await this.readResponse(response, req.onDelta, signal, alive);
      if (req.jsonSchema) {
        // Small local models often wrap JSON in code fences or a sentence; the callers parse it the same way.
        const parsed = parseJsonLoose(text);
        if (!object(parsed)) throw badResponse('The model did not return valid JSON for the requested structured response.');
        text = JSON.stringify(parsed);
      }
      if (this.lastTest?.error && this.lastTest.identity === this.identity(c, key)) this.lastTest = null;
      return { text, provider: this.id, model: c.profile.model, billing: c.local ? 'none' : 'api', effort: null };
    } catch (error) {
      if (timedOut) throw new ProviderError('unavailable', 'The model request timed out (the server stopped sending) and was cancelled. No retry was sent.');
      if (signal.aborted) throw cancelled();
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('network', 'The model request could not be completed. Check the server connection. No retry was sent.');
    } finally {
      clearTimeout(idle); clearTimeout(cap);
      req.signal?.removeEventListener('abort', abort);
      this.controllers.delete(controller);
      release?.();
    }
  }

  private async readResponse(response: Response, onDelta: CompletionRequest['onDelta'], signal: AbortSignal, alive: () => void = () => {}): Promise<string> {
    let text = '';
    let shown = 0;
    let finished = false;
    const consume = (payload: unknown, streaming: boolean) => {
      if (!object(payload) || payload.error) throw badResponse('The model server returned an error or invalid response.');
      if (!Array.isArray(payload.choices)) throw badResponse('The model response has no choices.');
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
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
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
