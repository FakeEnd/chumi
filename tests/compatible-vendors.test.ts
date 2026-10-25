import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompatibleProvider } from '../server/ai/compatible.ts';
import { ProviderError, type CompletionRequest } from '../server/ai/provider.ts';
import { defaultCompatibleSettings } from '../shared/compatible-provider.ts';

// Protocol fixtures, not live API tests. No network access or real credentials.
// Model IDs are examples from official docs checked on 2026-10-24, not defaults.
// DeepSeek: https://api-docs.deepseek.com/api/create-chat-completion/
// Kimi: https://platform.kimi.ai/docs/api/chat
const vendors = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', separateUsage: false },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3.1-pro', separateUsage: true },
] as const;
type Vendor = typeof vendors[number];
const fakeKey = 'synthetic-vendor-key';
const request: CompletionRequest = {
  task: 'ask', instructions: 'Answer using only the synthetic meeting passage.',
  input: '这是合成的测试记录：小林周五提交实验报告。负责人和截止时间是什么？',
};
const schema = {
  type: 'object', properties: { owner: { type: 'string' }, deadline: { type: 'string' } },
  required: ['owner', 'deadline'], additionalProperties: false,
};
const answer = { owner: '小林', deadline: '周五' };
const usage = { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 };

function config(vendor: Vendor) {
  const settings = defaultCompatibleSettings();
  settings.preset = 'custom';
  Object.assign(settings.profiles.custom, {
    enabled: true, baseUrl: vendor.baseUrl, model: vendor.model, maxOutputTokens: 8192,
  });
  return settings;
}

function frame(delta: Record<string, unknown>, finish_reason: string | null = null) {
  return { choices: [{ index: 0, delta, finish_reason }] };
}

function terminal(vendor: Vendor) {
  // DeepSeek attaches usage to the final stop choice; Kimi has a usage-only frame.
  return vendor.separateUsage
    ? [frame({}, 'stop'), { choices: [], usage }]
    : [{ ...frame({ content: '', reasoning_content: null }, 'stop'), usage }];
}

function fragmentedSse(events: unknown[]) {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.subarray(offset, ++offset));
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

for (const vendor of vendors) {
  test(`${vendor.name}: custom profile uses the exact endpoint and keeps reasoning out of Chinese SSE text`, async () => {
    const settings = config(vendor);
    const deltas: string[] = [];
    const provider = new CompatibleProvider(() => settings, {
      readKey: async (preset, baseUrl) => {
        assert.equal(preset, 'custom');
        assert.equal(baseUrl, vendor.baseUrl);
        return fakeKey;
      },
      fetch: async (url, init) => {
        assert.equal(String(url), `${vendor.baseUrl}/chat/completions`);
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${fakeKey}`);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, vendor.model);
        assert.equal(body.stream, true);
        assert.equal(body.max_tokens, 8192);
        assert.equal(body.reasoning_split, undefined, 'MiniMax extensions must not reach custom vendors');
        return fragmentedSse([
          frame({ role: 'assistant', content: '' }),
          frame({ content: null, reasoning_content: '私有推理，不应显示。' }),
          frame({ content: '小林', reasoning_content: null }),
          frame({ content: '周五提交实验报告。' }),
          ...terminal(vendor),
        ]);
      },
    });
    const result = await provider.complete({ ...request, onDelta: (text) => deltas.push(text) });
    assert.equal(result.text, '小林周五提交实验报告。');
    assert.equal(deltas.join(''), result.text);
    assert.equal(result.model, vendor.model);
    assert.equal(result.billing, 'api');
  });

  test(`${vendor.name}: JSON mode accepts a structured answer after reasoning and vendor usage frames`, async () => {
    const settings = config(vendor);
    settings.profiles.custom.structuredOutput = 'json_object';
    const deltas: string[] = [];
    const provider = new CompatibleProvider(() => settings, {
      readKey: async () => fakeKey,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.response_format, { type: 'json_object' });
        assert.match(body.messages[0].content, /JSON/);
        return fragmentedSse([
          frame({ reasoning_content: '忽略此处的 JSON：{"owner":"错误"}', content: null }),
          frame({ content: JSON.stringify(answer) }),
          ...terminal(vendor),
        ]);
      },
    });
    const result = await provider.complete({ ...request, jsonSchema: schema, onDelta: (text) => deltas.push(text) });
    assert.deepEqual(JSON.parse(result.text), answer);
    assert.equal(deltas.join(''), JSON.stringify(answer));
  });

  test(`${vendor.name}: exhausting the token budget during reasoning is not a successful empty answer`, async () => {
    const deltas: string[] = [];
    const provider = new CompatibleProvider(() => config(vendor), {
      readKey: async () => fakeKey,
      fetch: async () => fragmentedSse([
        frame({ content: null, reasoning_content: '仍在思考，尚未生成可见答案。' }),
        { ...frame({ content: '' }, 'length'), usage },
      ]),
    });
    await assert.rejects(provider.complete({ ...request, onDelta: (text) => deltas.push(text) }), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'bad_response');
      assert.match(error.message, /output limit/);
      return true;
    });
    assert.deepEqual(deltas, []);
  });
}

test('Kimi: the current documented json_schema format preserves the requested schema', async () => {
  const vendor = vendors[1];
  const settings = config(vendor);
  settings.profiles.custom.structuredOutput = 'json_schema';
  const provider = new CompatibleProvider(() => settings, {
    readKey: async () => fakeKey,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.response_format, {
        type: 'json_schema', json_schema: { name: 'chumi_response', strict: true, schema },
      });
      return fragmentedSse([frame({ content: JSON.stringify(answer) }), ...terminal(vendor)]);
    },
  });
  assert.deepEqual(JSON.parse((await provider.complete({ ...request, jsonSchema: schema })).text), answer);
});

