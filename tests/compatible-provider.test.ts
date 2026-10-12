import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompatibleProvider } from '../server/ai/compatible.ts';
import { compatibleKeyAccount } from '../server/ai/compatible-credentials.ts';
import { ProviderError, type CompletionRequest } from '../server/ai/provider.ts';
import { defaultCompatibleSettings, type CompatiblePreset, type CompatibleSettings } from '../shared/compatible-provider.ts';

// Every test injects credentials; none accesses the real macOS Keychain.
class TestProvider extends CompatibleProvider {
  constructor(config: () => CompatibleSettings, deps: ConstructorParameters<typeof CompatibleProvider>[1] = {}) {
    super(config, { readKey: async () => null, ...deps });
  }
}

const request: CompletionRequest = { task: 'ask', instructions: 'Answer using the transcript.', input: 'A meeting passage.' };
const schema = { type: 'object', properties: { cards: { type: 'array', items: { type: 'string' } } }, required: ['cards'], additionalProperties: false };

function settings(preset: CompatiblePreset = 'custom') {
  const value = defaultCompatibleSettings();
  value.preset = preset;
  Object.assign(value.profiles[preset], { enabled: true, model: 'test-model', ...(preset === 'custom' ? { baseUrl: 'https://models.example.test/v1' } : {}) });
  return value;
}
function jsonAnswer(content = 'Complete answer', finish = 'stop'): Response {
  return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }] });
}
function chunk(content: string, finish: string | null = null) {
  return { choices: [{ index: 0, delta: { content }, finish_reason: finish }] };
}
function sse(events: unknown[], done = true): Response {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : '');
  return new Response(text, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function isKind(kind: ProviderError['kind']) { return (error: unknown) => error instanceof ProviderError && error.kind === kind; }

test('remote paid opt-in and model configuration are checked before key access or network', async () => {
  const config = settings();
  let network = 0;
  let keys = 0;
  const provider = new TestProvider(() => config, {
    fetch: async () => { network++; return jsonAnswer(); }, readKey: async () => { keys++; return 'test-key'; },
  });
  config.profiles.custom.enabled = false;
  await assert.rejects(provider.complete(request), isKind('disabled'));
  const result = await provider.testConnection();
  assert.equal(result.ready, false);
  config.profiles.custom.enabled = true;
  config.profiles.custom.model = '';
  await assert.rejects(provider.complete(request), isKind('disabled'));
  assert.equal(network, 0);
  assert.equal(keys, 0);
});

test('credential identity normalizes URLs and isolates preset, port, and full API path', () => {
  const account = compatibleKeyAccount('custom', 'https://API.example.test:443/v1/');
  assert.equal(account, compatibleKeyAccount('custom', 'https://api.example.test/v1'));
  assert.notEqual(account, compatibleKeyAccount('qwen', 'https://api.example.test/v1'));
  assert.notEqual(account, compatibleKeyAccount('custom', 'https://api.example.test/v2'));
  assert.notEqual(account, compatibleKeyAccount('custom', 'https://api.example.test:444/v1'));
  assert.match(account, /^custom:[a-f0-9]{64}$/);
  assert.throws(() => compatibleKeyAccount('custom', 'https://name:secret@example.test/v1'));
  assert.throws(() => compatibleKeyAccount('custom', 'https://example.test/v1?key=secret'));
});

test('a key is required for the exact active remote profile URL; it travels only in the header', async () => {
  const config = settings('qwen');
  const seen: unknown[][] = [];
  let stored: string | null = null;
  let calls = 0;
  const provider = new TestProvider(() => config, {
    readKey: async (...args) => { seen.push(args); return stored; },
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), `${config.profiles.qwen.baseUrl}/chat/completions`);
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-test-token');
      assert.ok(!String(init?.body).includes('private-test-token'));
      return jsonAnswer();
    },
  });
  await assert.rejects(provider.complete(request), isKind('auth'));
  assert.equal(calls, 0);
  stored = 'private-test-token';
  assert.equal((await provider.complete(request)).billing, 'api');
  assert.deepEqual(seen[0], ['qwen', config.profiles.qwen.baseUrl]);
  assert.equal(calls, 1);
});

test('schema instructions always survive; only the configured response format is sent and effort is omitted', async () => {
  for (const mode of ['prompt', 'json_object', 'json_schema'] as const) {
    const config = settings();
    config.profiles.custom.structuredOutput = mode;
    const provider = new TestProvider(() => config, {
      readKey: async () => 'test-key', fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.ok(body.messages[0].content.startsWith(request.instructions));
        assert.ok(body.messages[0].content.includes(JSON.stringify(schema)));
        assert.equal(body.reasoning_effort, undefined);
        assert.equal(body.reasoning, undefined);
        assert.equal(body.max_tokens, 4096);
        if (mode === 'prompt') assert.equal(body.response_format, undefined);
        else assert.equal(body.response_format.type, mode);
        if (mode === 'json_schema') assert.deepEqual(body.response_format.json_schema.schema, schema);
        return jsonAnswer('{"cards":[]}');
      },
    });
    assert.equal((await provider.complete({ ...request, jsonSchema: schema, effort: 'max' })).text, '{"cards":[]}');
  }
});

test('SSE handles split UTF-8, split CRLF, comments, multiline events, and usage frames', async () => {
  const config = settings('lmstudio');
  const content = ': keepalive\r\n\r\ndata: {\r\ndata: "choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\r\n\r\n' +
    `data: ${JSON.stringify(chunk('你好 🌱'))}\r\n\r\n` +
    `data: ${JSON.stringify(chunk('！', 'stop'))}\r\n\r\n` +
    'data: {"choices":[],"usage":{"completion_tokens":3}}\r\n\r\ndata: [DONE]\r\n\r\n';
  const encoded = new TextEncoder().encode(content);
  let pos = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (pos >= encoded.length) controller.close();
    else controller.enqueue(encoded.subarray(pos, ++pos));
  } });
  const deltas: string[] = [];
  const provider = new TestProvider(() => config, { fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  const result = await provider.complete({ ...request, onDelta: (text) => deltas.push(text) });
  assert.equal(result.text, '你好 🌱！');
  assert.deepEqual(deltas, ['你好 🌱', '！']);
  assert.equal(result.billing, 'none');
});

test('invalid, refused, tool-only, empty, and truncated completions are rejected without retries', async () => {
  const cases = [
    () => jsonAnswer('partial', 'length'),
    () => Response.json({ choices: [{ message: { content: '', refusal: 'declined' }, finish_reason: 'stop' }] }),
    () => Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call' }] }, finish_reason: 'tool_calls' }] }),
    () => jsonAnswer('   '),
    () => Response.json({ choices: [{ message: { content: 'incomplete' } }] }),
    () => Response.json({ error: { message: 'provider error' } }),
    () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    () => sse([chunk('partial')]),
    () => sse([chunk('partial', 'length')]),
    () => sse([chunk('partial'), { error: { message: 'bad' } }]),
    () => sse([{ choices: [{ delta: { refusal: 'declined' }, finish_reason: 'stop' }] }]),
    () => sse([{ choices: [{ delta: { tool_calls: [{ id: 'call' }] }, finish_reason: 'tool_calls' }] }]),
    () => new Response('event: error\ndata: {}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    () => new Response('data: {broken}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  ];
  for (const makeResponse of cases) {
    let calls = 0;
    const provider = new TestProvider(() => settings('lmstudio'), { fetch: async () => { calls++; return makeResponse(); } });
    await assert.rejects(provider.complete(request), isKind('bad_response'));
    assert.equal(calls, 1);
  }
});

test('structured response with invalid JSON fails instead of silently accepting prose', async () => {
  const provider = new TestProvider(() => settings('lmstudio'), { fetch: async () => jsonAnswer('Here are your cards.') });
  await assert.rejects(provider.complete({ ...request, jsonSchema: schema }), isKind('bad_response'));
});

test('HTTP errors are sanitized and never retried or downgraded', async () => {
  let calls = 0;
  const provider = new TestProvider(() => settings(), {
    readKey: async () => 'private-test-token',
    fetch: async () => { calls++; return new Response('API rejected private-test-token', { status: 400 }); },
  });
  await assert.rejects(provider.complete({ ...request, jsonSchema: schema }), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.ok(!error.message.includes('private-test-token'));
    assert.match(error.message, /400/);
    return true;
  });
  assert.equal(calls, 1);
});

test('local routes reject remote addresses and Ollama cloud tags before any network access', async () => {
  let calls = 0;
  const config = settings('ollama');
  const provider = new TestProvider(() => config, { fetch: async () => { calls++; return jsonAnswer(); } });
  config.profiles.ollama.baseUrl = 'https://remote.example.test/v1';
  await assert.rejects(provider.complete(request), isKind('disabled'));
  config.profiles.ollama.baseUrl = 'http://127.0.0.1:11434/v1';
  for (const model of ['qwen:cloud', 'qwen:8b-cloud', 'cloud:qwen']) {
    config.profiles.ollama.model = model;
    await assert.rejects(provider.complete(request), isKind('billing_safety'));
  }
  assert.equal(calls, 0);
});

test('Ollama verifies local model metadata and blocks remotely-backed aliases before sending meeting content', async () => {
  for (const metadata of [{ remote_host: 'https://ollama.com', remote_model: 'remote' }, {}, { model_info: {}, capabilities: ['completion'] }]) {
    const seen: string[] = [];
    const provider = new TestProvider(() => settings('ollama'), { fetch: async (url, init) => {
      seen.push(String(url));
      assert.ok(!String(init?.body).includes(request.input));
      assert.equal(init?.redirect, 'error');
      return Response.json(metadata);
    } });
    await assert.rejects(provider.complete(request), isKind('billing_safety'));
    assert.deepEqual(seen, ['http://127.0.0.1:11434/api/show']);
  }
  const calls: string[] = [];
  const provider = new TestProvider(() => settings('ollama'), { fetch: async (url) => {
    calls.push(String(url));
    return String(url).endsWith('/api/show') ? Response.json({ model_info: { 'general.architecture': 'qwen3' }, capabilities: ['completion'] }) : jsonAnswer();
  } });
  assert.equal((await provider.complete(request)).text, 'Complete answer');
  assert.equal(calls.length, 2);
});

test('undeclared image capability is rejected before reading files or sending a request', async () => {
  let calls = 0;
  const provider = new TestProvider(() => settings('lmstudio'), { fetch: async () => { calls++; return jsonAnswer(); } });
  await assert.rejects(provider.complete({ ...request, images: [{ path: '/does-not-exist.jpg', label: 'slide' }] }), isKind('disabled'));
  assert.equal(calls, 0);
});

test('status checks do not spend remote API quota; explicit test uses only synthetic content', async () => {
  const config = settings();
  let key = 'test-key-one';
  let calls = 0;
  const provider = new TestProvider(() => config, {
    readKey: async () => key,
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_tokens, config.profiles.custom.maxOutputTokens);
      assert.ok(!String(init?.body).includes(request.input));
      return jsonAnswer('OK');
    },
  });
  assert.match((await provider.status(true)).message ?? '', /not been tested/);
  assert.equal(calls, 0);
  assert.equal((await provider.testConnection()).ready, true);
  assert.match((await provider.status()).message ?? '', /succeeded/);
  key = 'test-key-two';
  assert.match((await provider.status()).message ?? '', /not been tested/);
  await provider.testConnection();
  provider.invalidateStatus();
  assert.match((await provider.status()).message ?? '', /not been tested/);
  assert.equal(calls, 2);
});

test('failed connection tests return sanitized status rather than throw', async () => {
  const provider = new TestProvider(() => settings(), { readKey: async () => 'secret-token', fetch: async () => { throw new Error('secret-token'); } });
  const result = await provider.testConnection();
  assert.equal(result.state, 'error');
  assert.equal(result.ready, false);
  assert.ok(!result.message?.includes('secret-token'));
});

test('successful ordinary completion clears a past failed test without pretending it was retested', async () => {
  let failing = true;
  const provider = new TestProvider(() => settings(), { readKey: async () => 'test-key', fetch: async () => failing ? new Response('', { status: 503 }) : jsonAnswer() });
  assert.equal((await provider.testConnection()).ready, false);
  failing = false;
  await provider.complete(request);
  const status = await provider.status();
  assert.equal(status.ready, true);
  assert.match(status.message ?? '', /not been tested/);
});

test('optional local credentials authenticate model discovery and completions; refresh can recover from a stale test failure', async () => {
  const calls: string[] = [];
  let failing = true;
  const config = settings('lmstudio');
  const provider = new TestProvider(() => config, { readKey: async () => 'local-auth-token', fetch: async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer local-auth-token');
    assert.equal(init?.redirect, 'error');
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'test-model' }] });
    return failing ? new Response('', { status: 401 }) : jsonAnswer();
  } });
  assert.equal((await provider.testConnection()).ready, false);
  const discovered = await provider.status(true);
  assert.equal(discovered.ready, true);
  assert.match(discovered.message ?? '', /completion has not been tested/);
  assert.deepEqual(discovered.models, [{ id: 'test-model', name: 'test-model' }]);
  failing = false;
  await provider.complete(request);
  assert.deepEqual(calls, [
    'http://127.0.0.1:1234/v1/chat/completions', 'http://127.0.0.1:1234/v1/models', 'http://127.0.0.1:1234/v1/chat/completions',
  ]);
});

test('MiniMax requests split reasoning from visible structured content without changing generic providers', async () => {
  for (const preset of ['minimax', 'qwen'] as const) {
    const provider = new TestProvider(() => settings(preset), { readKey: async () => 'test-key', fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.reasoning_split, preset === 'minimax' ? true : undefined);
      return sse([
        { choices: [{ delta: { reasoning_content: 'private reasoning' }, finish_reason: null }] },
        chunk('{"cards":[]}', 'stop'),
      ]);
    } });
    const deltas: string[] = [];
    const result = await provider.complete({ ...request, jsonSchema: schema, onDelta: (text) => deltas.push(text) });
    assert.equal(result.text, '{"cards":[]}');
    assert.deepEqual(deltas, ['{"cards":[]}']);
  }
});

test('aborting queued local work is prompt and does not cancel the active request', async () => {
  const started = deferred<void>();
  const response = deferred<Response>();
  let calls = 0;
  const provider = new TestProvider(() => settings('lmstudio'), { fetch: async () => { calls++; started.resolve(); return response.promise; } });
  const first = provider.complete(request);
  await started.promise;
  const controller = new AbortController();
  const second = provider.complete({ ...request, signal: controller.signal });
  const rejected = assert.rejects(second, isKind('aborted'));
  controller.abort();
  await rejected;
  assert.equal(calls, 1);
  response.resolve(jsonAnswer());
  await first;
});

test('local requests are serialized and queued work is cancelled when settings change', async () => {
  const config = settings('lmstudio');
  const started = deferred<void>();
  const response = deferred<Response>();
  let calls = 0;
  const provider = new TestProvider(() => config, { fetch: async () => { calls++; started.resolve(); return response.promise; } });
  const first = provider.complete(request);
  await started.promise;
  const second = provider.complete(request);
  const rejected = assert.rejects(second, /settings changed/i);
  config.profiles.lmstudio.model = 'another-model';
  response.resolve(jsonAnswer());
  await first;
  await rejected;
  assert.equal(calls, 1);
});

test('active requests obey aborts and timeouts even while transport is stalled', async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const provider = new TestProvider(() => settings('lmstudio'), { fetch: async (_url, init) => {
    started.resolve();
    assert.ok(init?.signal);
    return new Promise<Response>(() => {});
  } });
  const pending = provider.complete({ ...request, signal: controller.signal });
  const rejected = assert.rejects(pending, isKind('aborted'));
  await started.promise;
  controller.abort();
  await rejected;

  const timed = new TestProvider(() => settings('lmstudio'), { timeoutMs: 15, fetch: async () => new Promise<Response>(() => {}) });
  await assert.rejects(timed.complete(request), /timed out/);
});

test('already cancelled requests and shutdown do not leave local work running or queued', async () => {
  let calls = 0;
  const entered = deferred<void>();
  const provider = new TestProvider(() => settings('lmstudio'), { fetch: async () => { calls++; entered.resolve(); return new Promise<Response>(() => {}); } });
  await assert.rejects(provider.complete({ ...request, signal: AbortSignal.abort() }), isKind('aborted'));
  assert.equal(calls, 0);
  const first = provider.complete(request);
  const a = assert.rejects(first, isKind('aborted'));
  await entered.promise;
  const second = provider.complete(request);
  const b = assert.rejects(second, isKind('aborted'));
  await provider.shutdown();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
});

test('a fresh Ollama with no models, or without the configured model, says what to download', async () => {
  const ollama = (data: unknown) => new TestProvider(() => settings('ollama'), { fetch: async () => Response.json({ object: 'list', data }) });
  for (const empty of [null, []]) {
    const status = await ollama(empty).status(true);
    assert.equal(status.ready, false);
    assert.match(status.message ?? '', /no models are downloaded yet.*ollama pull test-model/);
  }
  const other = await ollama([{ id: 'llama3.2:3b' }]).status(true);
  assert.equal(other.ready, false);
  assert.match(other.message ?? '', /"test-model" is not downloaded.*llama3\.2:3b/);
  assert.equal((await ollama([{ id: 'test-model:latest' }]).status(true)).ready, true, 'a bare name matches its :latest tag');
  const notPulled = new TestProvider(() => settings('ollama'), { fetch: async (url) => (String(url).endsWith('/api/show') ? new Response('{"error":"model not found"}', { status: 404 }) : jsonAnswer()) });
  await assert.rejects(notPulled.complete(request), (e: unknown) => e instanceof ProviderError && /ollama pull test-model/.test(e.message));
});

test('small-model quirks: fenced JSON, a finished stream without [DONE], a last line without a newline, think blocks', async () => {
  const answer = (make: () => Response) => new TestProvider(() => settings('lmstudio'), { fetch: async () => make() });
  const fenced = await answer(() => jsonAnswer('Here you go:\n```json\n{"cards": ["a"]}\n```')).complete({ ...request, jsonSchema: schema });
  assert.deepEqual(JSON.parse(fenced.text), { cards: ['a'] }, 'structured text is returned as clean JSON');
  assert.equal((await answer(() => sse([chunk('Done.', 'stop')], false)).complete(request)).text, 'Done.');
  const noNewline = () => new Response(`data: ${JSON.stringify(chunk('Tail', 'stop'))}\n\ndata: [DONE]`, { headers: { 'content-type': 'text/event-stream' } });
  assert.equal((await answer(noNewline).complete(request)).text, 'Tail');

  const deltas: string[] = [];
  const thinking = answer(() => sse([chunk('<thi'), chunk('nk>Let me reason {"x": 1}</think>'), chunk('\n\n{"cards": '), chunk('["b"]}', 'stop')]));
  const r = await thinking.complete({ ...request, onDelta: (d) => deltas.push(d) });
  assert.equal(r.text, '{"cards": ["b"]}');
  assert.equal(deltas.join(''), '{"cards": ["b"]}', 'the reasoning block is never streamed to the card');
  const structured = await answer(() => sse([chunk('<think>{"no": 1}</think>{"cards": ["c"]}', 'stop')])).complete({ ...request, jsonSchema: schema });
  assert.deepEqual(JSON.parse(structured.text), { cards: ['c'] });
  await assert.rejects(answer(() => sse([chunk('<think>only thoughts</think>', 'stop')])).complete(request), isKind('bad_response'));
});

test('waiting for another local request does not count toward the timeout; a stalled stream still times out', async () => {
  const slow = (ms: number) => new Promise<Response>((r) => setTimeout(() => r(jsonAnswer('ok')), ms));
  const provider = new TestProvider(() => settings('lmstudio'), { timeoutMs: 150, fetch: () => slow(100) });
  const [a, b] = await Promise.all([provider.complete(request), provider.complete(request)]);
  assert.equal(a.text, 'ok'); assert.equal(b.text, 'ok');

  const stalled = new TestProvider(() => settings('lmstudio'), { timeoutMs: 30, fetch: async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk('partial'))}\n\n`)); },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  await assert.rejects(stalled.complete(request), /timed out/);
});
