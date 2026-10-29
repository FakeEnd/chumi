import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, type AIProvider, type CompletionRequest, type CompletionResult, type ProviderStatus } from './provider.ts';
import { deleteCredential, readCredential, storeCredential } from '../credentials.ts';

/*
 * OPTIONAL paid access: Anthropic API key (billed per token by Anthropic).
 * Disabled until the user (1) enables it in Settings, (2) stores a key, and (3) selects it as the active
 * provider. Chumi never switches to this provider automatically.
 * The key is stored in the macOS login Keychain (service "Chumi Anthropic API key"), never in the database.
 */

const KC_SERVICE = 'Chumi Anthropic API key';
const KC_ACCOUNT = 'default';

export function readKey(): Promise<string | null> { return readCredential(KC_SERVICE, KC_ACCOUNT); }

export function storeKey(key: string): Promise<void> {
  if (!/^[A-Za-z0-9_\-]{20,300}$/.test(key)) return Promise.reject(new Error('That does not look like an API key.'));
  return storeCredential(KC_SERVICE, KC_ACCOUNT, key);
}

export function deleteKey(): Promise<void> { return deleteCredential(KC_SERVICE, KC_ACCOUNT); }

export class AnthropicApiProvider implements AIProvider {
  readonly id = 'anthropic-api';
  readonly label = 'Anthropic API key (paid)';
  readonly supportsImages = true;
  private cfg: () => { enabled: boolean; model: string };
  constructor(cfg: () => { enabled: boolean; model: string }) { this.cfg = cfg; }

  async status(): Promise<ProviderStatus> {
    const c = this.cfg();
    const base = { id: this.id, label: this.label, checkedAt: Date.now(), model: c.model, billing: 'api' as const, billingLabel: 'API billing — charged per request',
      quota: { known: false, summary: 'Pay-as-you-go: no plan allowance. Spending is visible in the Claude Console.' } };
    if (!c.enabled) return { ...base, state: 'disabled', ready: false, message: 'Paid API access is disabled. Enable it in Settings only if you accept per-request charges.' };
    const key = await readKey();
    if (!key) return { ...base, state: 'signed_out', ready: false, message: 'No API key stored.', setupHint: 'Settings → AI provider → Anthropic API key.' };
    return { ...base, state: 'ready', ready: true };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const c = this.cfg();
    if (!c.enabled) throw new ProviderError('disabled', 'Paid API access is disabled.');
    const apiKey = await readKey();
    if (!apiKey) throw new ProviderError('auth', 'No Anthropic API key stored.');
    const client = new Anthropic({ apiKey });
    let system = req.instructions;
    if (req.jsonSchema) system += `\n\nReturn ONLY a JSON object (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`;
    try {
      // Server-side refusal fallback ("default" routing) keeps answers flowing if a safety classifier declines.
      const params = {
        model: c.model,
        max_tokens: 16000,
        system,
        messages: [{
          role: 'user' as const,
          content: [
            ...(req.images ?? []).map((im) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: readFileSync(im.path).toString('base64') } })),
            { type: 'text' as const, text: req.input },
          ],
        }],
        output_config: { effort: req.effort ?? 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      };
      const stream = client.beta.messages.stream(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming, { signal: req.signal });
      let text = '';
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') { text += event.delta.text; req.onDelta?.(event.delta.text); }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') throw new ProviderError('bad_response', 'The model declined this request.');
      return { text, provider: this.id, model: final.model, billing: 'api', effort: req.effort ?? 'low' };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (req.signal?.aborted) throw new ProviderError('aborted', 'Request cancelled.');
      if (e instanceof Anthropic.AuthenticationError) throw new ProviderError('auth', 'The Anthropic API key was rejected.');
      if (e instanceof Anthropic.RateLimitError) throw new ProviderError('rate_limit', 'Anthropic API rate limit reached.', true);
      if (e instanceof Anthropic.APIConnectionError) throw new ProviderError('network', 'Could not reach the Anthropic API.', true);
      if (e instanceof Anthropic.APIError) throw new ProviderError('bad_response', `Anthropic API error ${e.status}: ${e.message}`, (e.status ?? 0) >= 500);
      throw new ProviderError('bad_response', (e as Error).message);
    }
  }

  async shutdown(): Promise<void> { /* stateless */ }
}
