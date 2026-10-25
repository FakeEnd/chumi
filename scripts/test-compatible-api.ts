/**
 * Two real, small generations through Chumi's existing adapter (provider charges may apply).
 * Sends synthetic text only; does not read or change Chumi's settings, meetings, or Keychain.
 *
 *   node scripts/test-compatible-api.ts deepseek
 *   node scripts/test-compatible-api.ts kimi
 *   node scripts/test-compatible-api.ts all
 *
 * Set DEEPSEEK_API_KEY and DEEPSEEK_MODEL, or MOONSHOT_API_KEY and MOONSHOT_MODEL.
 * KIMI_API_KEY / KIMI_MODEL are also accepted. Never pass keys as command-line arguments.
 * Optional DEEPSEEK_BASE_URL / MOONSHOT_BASE_URL (KIMI_BASE_URL), and
 * COMPATIBLE_TEST_MAX_TOKENS (default 4096, includes reasoning on thinking models).
 * Kimi defaults to the international endpoint; use https://api.moonshot.cn/v1 for a Chinese-platform key.
 *
 * Exit 0 = all checks passed, 1 = test failed, 2 = configuration missing/invalid.
 */
import assert from 'node:assert/strict';
import { CompatibleProvider } from '../server/ai/compatible.ts';
import { ProviderError } from '../server/ai/provider.ts';
import { defaultCompatibleSettings, normalizeCompatibleUrl } from '../shared/compatible-provider.ts';

type Vendor = 'deepseek' | 'kimi';
interface Target { vendor: Vendor; key: string; model: string; baseUrl: string; maxOutputTokens: number }

const selection = process.argv[2];
if (process.argv.length !== 3 || !['deepseek', 'kimi', 'all'].includes(selection ?? '')) {
  console.error('Usage: node scripts/test-compatible-api.ts deepseek|kimi|all');
  process.exitCode = 2;
} else {
  const vendors: Vendor[] = selection === 'all' ? ['deepseek', 'kimi'] : [selection as Vendor];
  const targets: Target[] = [];
  // Validate every target before any paid request. Model IDs are explicit because vendor aliases change.
  for (const vendor of vendors) {
    const key = (vendor === 'deepseek' ? process.env.DEEPSEEK_API_KEY : process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY)?.trim();
    const model = (vendor === 'deepseek' ? process.env.DEEPSEEK_MODEL : process.env.MOONSHOT_MODEL || process.env.KIMI_MODEL)?.trim();
    if (!key || !model) {
      console.error(`${vendor}: NOT RUN — set ${vendor === 'deepseek' ? 'DEEPSEEK_API_KEY and DEEPSEEK_MODEL' : 'MOONSHOT_API_KEY and MOONSHOT_MODEL'} in the environment.`);
      process.exitCode = 2;
      continue;
    }
    try {
      const baseUrl = normalizeCompatibleUrl(vendor === 'deepseek'
        ? process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
        : process.env.MOONSHOT_BASE_URL || process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1', false);
      const allowed = vendor === 'deepseek'
        ? ['https://api.deepseek.com', 'https://api.deepseek.com/v1']
        : ['https://api.moonshot.ai/v1', 'https://api.moonshot.cn/v1'];
      if (!allowed.includes(baseUrl)) throw new Error('Use the matching official provider endpoint.');
      const maxOutputTokens = Number(process.env.COMPATIBLE_TEST_MAX_TOKENS ?? 4096);
      if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 32768) throw new Error('Invalid token limit.');
      if (model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) throw new Error('Invalid model ID.');
      targets.push({ vendor, key, model, baseUrl, maxOutputTokens });
    } catch {
      console.error(`${vendor}: NOT RUN — check the official API URL, model ID, and token limit (64–32768).`);
      process.exitCode = 2;
    }
  }
  if (!process.exitCode) {
    for (const target of targets) {
      const config = defaultCompatibleSettings();
      config.preset = 'custom';
      Object.assign(config.profiles.custom, {
        enabled: true, baseUrl: target.baseUrl, model: target.model,
        structuredOutput: 'json_object', maxOutputTokens: target.maxOutputTokens,
      });
      const provider = new CompatibleProvider(() => config, { readKey: async () => target.key, timeoutMs: 30_000 });
      console.log(`${target.vendor}: ${target.baseUrl}; model=${target.model}; max_tokens=${target.maxOutputTokens}; up to 2 paid requests`);
      const checks = [
        { name: 'Chinese streamed answer', input: '只回复：连接成功', schema: undefined,
          validate: (text: string) => assert.equal(text.trim(), '连接成功') },
        { name: 'JSON object', input: 'Return JSON with ok=true and message="连接成功".',
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'], additionalProperties: false },
          validate: (text: string) => assert.deepEqual(JSON.parse(text), { ok: true, message: '连接成功' }) },
      ];
      try {
        for (const check of checks) {
          const start = performance.now();
          let firstTextMs: number | null = null;
          let visible = '';
          try {
            const result = await provider.complete({
              task: 'vendor-smoke-test', instructions: 'Follow the requested output exactly. This is a synthetic API compatibility test.',
              input: check.input, jsonSchema: check.schema, signal: AbortSignal.timeout(60_000),
              onDelta: (text) => { firstTextMs ??= Math.round(performance.now() - start); visible += text; },
            });
            check.validate(result.text);
            check.validate(visible);
            console.log(JSON.stringify({ vendor: target.vendor, check: check.name, status: 'PASS', firstVisibleTextMs: firstTextMs, totalMs: Math.round(performance.now() - start) }));
          } catch (error) {
            console.error(JSON.stringify({ vendor: target.vendor, check: check.name, status: 'FAIL',
              kind: error instanceof ProviderError ? error.kind : 'unexpected_output',
              message: error instanceof ProviderError ? error.message : 'The answer did not match the synthetic test expectations.',
              totalMs: Math.round(performance.now() - start) }));
            process.exitCode = 1;
            break; // No retry or second generation after a failure for this provider.
          }
        }
      } finally { await provider.shutdown(); }
    }
  }
}
