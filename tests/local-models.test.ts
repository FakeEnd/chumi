import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverLocalModels } from '../server/ai/local-models.ts';

const ollama = { preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' };
const lmstudio = { preset: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' };
const isolated = { readKey: async () => null, installed: () => false };

test('discovery works before any model or active provider is configured and sends only a list request', async () => {
  const calls: string[] = [];
  const result = await discoverLocalModels(ollama, { ...isolated, fetch: async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return Response.json({ data: [{ id: 'qwen:latest' }, { id: 'alpha:3b' }, { id: 'qwen:latest' }, { id: 'large:cloud' },
      { id: 'proxy', remote_host: 'https://example.test' }, { id: '' }, { id: 'bad\nname' }, { id: 7 }, null] });
  } });
  assert.deepEqual(calls, [`${ollama.baseUrl}/models`]);
  assert.deepEqual(result, { state: 'ready', installation: 'detected', models: [{ id: 'alpha:3b', name: 'alpha:3b' }, { id: 'qwen:latest', name: 'qwen:latest' }] });
});

test('LM Studio discovery supports a changed loopback endpoint and isolates the saved key by endpoint', async () => {
  const baseUrl = 'http://localhost:1239/custom/v1';
  const result = await discoverLocalModels({ ...lmstudio, baseUrl: `${baseUrl}/` }, { ...isolated,
    readKey: async (preset, url) => { assert.equal(preset, 'lmstudio'); assert.equal(url, baseUrl); return 'test-key'; },
    fetch: async (url, init) => {
      assert.equal(url, `${baseUrl}/models`);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
      return Response.json({ data: [{ id: 'local/chat' }, { id: 'local/embed', type: 'embedding' }] });
    },
  });
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.models.map((model) => model.id), ['local/chat']);
});

test('discovery rejects remote targets and credential-bearing URLs before key access or network', async () => {
  let accesses = 0;
  const deps = { ...isolated, readKey: async () => { accesses++; return null; }, fetch: async () => { accesses++; return Response.json({}); } };
  for (const target of [{ ...ollama, preset: 'qwen' }, { ...ollama, preset: '__proto__' },
    { ...ollama, baseUrl: 'https://example.test/v1' }, { ...ollama, baseUrl: 'http://192.168.1.2/v1' },
    { ...ollama, baseUrl: 'http://secret@localhost:11434/v1' }, { ...ollama, baseUrl: 'http://localhost:11434/v1?key=secret' }]) {
    await assert.rejects(discoverLocalModels(target, deps));
  }
  assert.equal(accesses, 0);
});

test('an empty or cloud-only list leads to download guidance, not installation guidance', async () => {
  for (const data of [null, [], [{ id: 'model:cloud' }]]) {
    const result = await discoverLocalModels(ollama, { ...isolated, fetch: async () => Response.json({ data }) });
    assert.deepEqual(result, { state: 'empty', models: [], installation: 'detected' });
  }
});

test('unreachable services retain installation detection for the correct startup guidance', async () => {
  for (const installed of [true, false]) {
    const result = await discoverLocalModels(ollama, { ...isolated, installed: () => installed, fetch: async () => { throw new TypeError('fetch failed'); } });
    assert.equal(result.state, 'unreachable');
    assert.equal(result.installation, installed ? 'detected' : 'not_detected');
  }
});

test('authentication and bad server responses are distinguished from missing models', async () => {
  for (const status of [401, 403, 404, 500]) {
    const result = await discoverLocalModels(lmstudio, { ...isolated, fetch: async () => new Response('private server error', { status }) });
    assert.equal(result.state, status === 401 || status === 403 ? 'auth_required' : 'error');
    assert.ok(!JSON.stringify(result).includes('private server error'));
  }
  for (const body of [{}, { data: {} }, { data: 'wrong' }]) {
    assert.equal((await discoverLocalModels(ollama, { ...isolated, fetch: async () => Response.json(body) })).state, 'error');
  }
  assert.equal((await discoverLocalModels(ollama, { ...isolated, fetch: async () => new Response('not JSON') })).state, 'error');
});
