import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalModelDownloader } from '../server/ai/local-model-download.ts';
import { hardwareBudget } from '../server/ai/local-hardware.ts';
import { GiB } from '../shared/local-model-advice.ts';

const hw = hardwareBudget({ platform: 'darwin', arch: 'arm64', osRelease: '25.0.0', chip: 'Apple Silicon', cores: 10,
  memoryBytes: 64 * GiB, homeDiskFreeBytes: 100 * GiB, speechModel: 'ggml-small.bin' });
const target = { preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'qwen3-8b', context: 8192 };
const studio = { ...target, preset: 'lmstudio', baseUrl: 'http://localhost:1234/proxy/v1' };
const deps = { hardware: async () => hw, readKey: async () => null, pollMs: 1 };
const encoder = new TextEncoder();

test('download targets reject arbitrary models, remote URLs, credentials and unsupported paths before any side effects', () => {
  let access = 0;
  const manager = new LocalModelDownloader({ hardware: async () => { access++; return hw; }, readKey: async () => { access++; return null; },
    fetch: async () => { access++; return Response.json({}); } });
  for (const invalid of [{ ...target, preset: 'custom' }, { ...target, modelId: 'qwen3:cloud' },
    { ...target, baseUrl: 'https://example.test/v1' }, { ...target, baseUrl: 'http://secret@localhost/v1' },
    { ...target, baseUrl: 'http://localhost/v1?token=secret' }, { ...target, baseUrl: 'http://localhost/api' },
    { ...target, context: 1000000 }]) assert.throws(() => manager.start(invalid));
  assert.equal(access, 0);
  assert.equal(manager.snapshot(), null);
});

test('server rechecks memory, disk and runtime support before keys or a download request', async () => {
  for (const [hardware, preset, error] of [[{ ...hw, modelBudgetBytes: 0 }, 'ollama', 'memory'],
    [{ ...hw, homeDiskFreeBytes: 0 }, 'ollama', 'disk'], [{ ...hw, arch: 'x64' }, 'lmstudio', 'runtime']] as const) {
    let accesses = 0;
    const manager = new LocalModelDownloader({ hardware: async () => hardware, readKey: async () => { accesses++; return null; },
      fetch: async () => { accesses++; return Response.json({}); } });
    manager.start({ ...target, preset });
    await manager.waitForIdle();
    assert.equal(manager.snapshot()?.status, 'failed');
    assert.equal(manager.snapshot()?.error, error);
    assert.equal(accesses, 0);
  }
});

test('Ollama streams split frames, reports per-file progress and waits for verified success', async () => {
  const entered = Promise.withResolvers<void>();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let calls = 0;
  const manager = new LocalModelDownloader({ ...deps, readKey: async (preset, url) => {
    assert.equal(preset, 'ollama'); assert.equal(url, target.baseUrl); return 'private-test-key';
  }, fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:11434/api/pull');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-test-key');
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'qwen3:8b-q4_K_M', stream: true });
    const response = new Response(new ReadableStream({ start(c) { stream = c; } }));
    entered.resolve(); return response;
  } });
  const started = manager.start(target);
  assert.equal(manager.start(target).id, started.id);
  assert.throws(() => manager.start(studio), /Another/);
  await entered.promise;
  const frame = encoder.encode(JSON.stringify({ status: 'pulling 文件', digest: 'abc', total: 100, completed: 100 }) + '\r\n');
  stream.enqueue(frame.slice(0, 23)); stream.enqueue(frame.slice(23));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.snapshot()?.received, 100);
  assert.equal(manager.snapshot()?.progressScope, 'file');
  assert.equal(manager.snapshot()?.status, 'downloading');
  stream.enqueue(encoder.encode('{"status":"verifying sha256 digest"}\n'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.snapshot()?.status, 'verifying');
  stream.enqueue(encoder.encode('{"status":"success"}')); stream.close();
  await manager.waitForIdle();
  assert.equal(manager.snapshot()?.status, 'completed');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(manager.snapshot()).includes('private-test-key'));
});

test('Ollama rejects truncated, malformed and oversized streams without claiming completion', async () => {
  for (const [body, error] of [['{"status":"pulling","digest":"a","total":10,"completed":10}\n', 'incomplete'],
    ['not json\n', 'invalid_response'], ['x'.repeat(70000), 'invalid_response'], ['{"error":"secret internal error"}\n', 'server']] as const) {
    const manager = new LocalModelDownloader({ ...deps, fetch: async () => new Response(body) });
    manager.start(target); await manager.waitForIdle();
    assert.equal(manager.snapshot()?.status, 'failed');
    assert.equal(manager.snapshot()?.error, error);
    assert.ok(!JSON.stringify(manager.snapshot()).includes('secret'));
  }
});

test('Ollama cancellation aborts the stream and a later retry remains available', async () => {
  const entered = Promise.withResolvers<void>();
  let aborted = false;
  let calls = 0;
  const manager = new LocalModelDownloader({ ...deps, fetch: async (_url, init) => {
    calls++;
    if (calls > 1) return new Response('{"status":"success"}\n');
    const response = new Response(new ReadableStream({ start(c) {
      init?.signal?.addEventListener('abort', () => { aborted = true; c.error(new Error('aborted')); }, { once: true });
    } }));
    entered.resolve(); return response;
  } });
  const started = manager.start(target);
  await entered.promise;
  assert.throws(() => manager.cancel('stale-id'), /no longer current/);
  manager.cancel(started.id); await manager.waitForIdle();
  assert.ok(aborted);
  assert.equal(manager.snapshot()?.status, 'cancelled');
  manager.start(target); await manager.waitForIdle();
  assert.equal(manager.snapshot()?.status, 'completed');
});

test('cancelling during preflight cannot start a stale download or overwrite a new one', async () => {
  const blocked = Promise.withResolvers<typeof hw>();
  let hardwareCalls = 0;
  let downloads = 0;
  const manager = new LocalModelDownloader({ ...deps, hardware: () => ++hardwareCalls === 1 ? blocked.promise : Promise.resolve(hw),
    fetch: async () => { downloads++; return new Response('{"status":"success"}\n'); } });
  const first = manager.start(target);
  const oldWork = manager.waitForIdle();
  manager.cancel(first.id);
  const second = manager.start({ ...target, modelId: 'qwen3-4b' });
  await manager.waitForIdle();
  blocked.resolve(hw); await oldWork;
  assert.equal(manager.snapshot()?.id, second.id);
  assert.equal(manager.snapshot()?.status, 'completed');
  assert.equal(downloads, 1);
});

test('LM Studio requests the exact official repository/quantization and follows its download job', async () => {
  const calls: Array<{ url: string; body?: string | null }> = [];
  let polls = 0;
  const manager = new LocalModelDownloader({ ...deps, fetch: async (url, init) => {
    calls.push({ url: String(url), body: init?.body as string | undefined });
    assert.equal(init?.redirect, 'error');
    if (init?.method === 'POST') return Response.json({ job_id: 'job_1', status: 'downloading', total_size_bytes: 500 });
    polls++;
    return Response.json({ job_id: 'job_1', status: polls === 1 ? 'paused' : 'completed', total_size_bytes: 500, downloaded_bytes: polls === 1 ? 250 : 500 });
  } });
  manager.start(studio); await manager.waitForIdle();
  assert.equal(calls[0].url, 'http://localhost:1234/proxy/api/v1/models/download');
  assert.deepEqual(JSON.parse(calls[0].body!), { model: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF', quantization: 'Q4_K_M' });
  assert.ok(calls.slice(1).every((call) => call.url.endsWith('/download/status/job_1') && call.body === undefined));
  assert.equal(manager.snapshot()?.status, 'completed');
  assert.equal(manager.snapshot()?.received, 500);
  assert.throws(() => manager.cancel(manager.snapshot()!.id), /LM Studio/);
});

test('LM Studio already-downloaded responses complete without polling or choosing another model', async () => {
  let calls = 0;
  const manager = new LocalModelDownloader({ ...deps, fetch: async (_url, init) => {
    calls++; assert.equal(init?.method, 'POST'); return Response.json({ status: 'already_downloaded' });
  } });
  manager.start({ ...studio, modelId: 'qwen3-0.6b' }); await manager.waitForIdle();
  assert.equal(manager.snapshot()?.status, 'completed');
  assert.equal(calls, 1);
});

test('LM Studio status reconnection and app restart never resubmit a download', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-local-download-'));
  const stateFile = join(dir, 'download.json');
  try {
    let posts = 0;
    const manager = new LocalModelDownloader({ ...deps, stateFile, fetch: async (_url, init) => {
      if (init?.method === 'POST') { posts++; return Response.json({ job_id: 'job_saved', status: 'downloading' }); }
      throw new Error('offline');
    } });
    const started = manager.start(studio); await manager.waitForIdle();
    assert.equal(manager.snapshot()?.status, 'attention');
    assert.equal(manager.start(studio).id, started.id);
    assert.equal(posts, 1);
    assert.throws(() => manager.start({ ...target }), /Another local model download/, 'an unreachable job still blocks other downloads');
    let reads = 0;
    const restored = new LocalModelDownloader({ ...deps, stateFile, fetch: async (url, init) => {
      reads++; assert.equal(init?.method, 'GET'); assert.ok(String(url).endsWith('/status/job_saved'));
      return Response.json({ job_id: 'job_saved', status: 'completed' });
    } });
    restored.restore(); await restored.waitForIdle();
    assert.equal(reads, 1);
    assert.equal(restored.snapshot()?.status, 'completed');
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).status, 'completed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an LM Studio job Chumi can no longer reach can be dropped, so other downloads can start', async () => {
  const manager = new LocalModelDownloader({ ...deps, fetch: async (_url, init) => {
    if (init?.method === 'POST') return Response.json({ job_id: 'job_lost', status: 'downloading' });
    throw new Error('offline');
  } });
  const job = manager.start(studio); await manager.waitForIdle();
  assert.equal(manager.snapshot()?.status, 'attention');
  assert.equal(manager.cancel(job.id).status, 'interrupted', 'Stop tracking');
  assert.equal(manager.snapshot()?.status, 'interrupted');
  manager.start({ ...target }); await manager.waitForIdle();
  assert.notEqual(manager.snapshot()?.id, job.id, 'a new download replaced the dropped one');
});

test('LM Studio lost start responses are not retried automatically and wrong job IDs cannot report completion', async () => {
  let posts = 0;
  const lost = new LocalModelDownloader({ ...deps, fetch: async () => { posts++; throw new Error('private network error'); } });
  lost.start(studio); await lost.waitForIdle();
  assert.equal(posts, 1);
  assert.equal(lost.snapshot()?.error, 'unknown_start');
  const wrong = new LocalModelDownloader({ ...deps, fetch: async (_url, init) => Response.json(init?.method === 'POST'
    ? { job_id: 'job_correct', status: 'downloading' } : { job_id: 'job_other', status: 'completed' }) });
  wrong.start(studio); await wrong.waitForIdle();
  assert.equal(wrong.snapshot()?.status, 'attention');
  assert.equal(wrong.snapshot()?.error, 'invalid_response');
});

test('HTTP auth, unsupported API and server errors are actionable and never expose response bodies', async () => {
  for (const [status, error] of [[401, 'authentication'], [403, 'authentication'], [404, 'unsupported_api'], [405, 'unsupported_api'], [500, 'server']] as const) {
    for (const input of [target, studio]) {
      const manager = new LocalModelDownloader({ ...deps, fetch: async () => new Response('private-token', { status }) });
      manager.start(input); await manager.waitForIdle();
      assert.equal(manager.snapshot()?.status, 'failed');
      assert.equal(manager.snapshot()?.error, error);
      assert.ok(!JSON.stringify(manager.snapshot()).includes('private-token'));
    }
  }
});

test('a removed LM Studio job releases the download slot instead of permanently blocking new downloads', async () => {
  const manager = new LocalModelDownloader({ ...deps, fetch: async (_url, init) => init?.method === 'POST'
    ? Response.json({ job_id: 'job_gone', status: 'downloading' }) : new Response('', { status: 404 }) });
  manager.start(studio); await manager.waitForIdle();
  assert.equal(manager.snapshot()?.status, 'failed');
  assert.equal(manager.snapshot()?.error, 'job_missing');
  assert.doesNotThrow(() => manager.start({ ...studio, modelId: 'qwen3-4b' }));
  await manager.waitForIdle();
});

test('an interrupted Ollama journal never causes an automatic download on startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-local-download-'));
  try {
    const stateFile = join(dir, 'download.json');
    writeFileSync(stateFile, JSON.stringify({ ...target, id: 'saved-id', status: 'downloading', received: 10, total: 100 }));
    let calls = 0;
    const manager = new LocalModelDownloader({ ...deps, stateFile, fetch: async () => { calls++; return Response.json({}); } });
    manager.restore(); await manager.waitForIdle();
    assert.equal(manager.snapshot()?.status, 'interrupted');
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
