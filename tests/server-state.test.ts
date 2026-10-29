import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/db.ts';
import type { DownloadState } from '../server/asr/models.ts';

type State = { asrDownload: DownloadState | null };

test('the real state endpoint returns current download progress and missed terminal errors', { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-state-'));
  const store = new Store(join(root, 'chumi.db'));
  const settings = store.getSettings();
  store.saveSettings({ ...settings, ai: { ...settings.ai, provider: 'mock' }, asr: { ...settings.asr, engine: 'whisper', engineSelected: true }, devMode: true });
  store.close();
  // A loopback stand-in stalls halfway, then finishes with an invalid checksum. No real model is downloaded.
  const download = { response: null as ServerResponse | null };
  const upstream = createServer((_req, res) => {
    download.response = res;
    res.writeHead(200, { 'content-length': '2048' }); res.write(Buffer.alloc(1024, 7));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  assert.notEqual(port, 4777);
  const child = spawn(process.execPath, ['server/main.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, PORT: String(port), CHUMI_DATA_DIR: root, CHUMI_MODELS_DIR: join(root, 'models'), CHUMI_MODEL_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, CHUMI_NO_HOTKEY: '1', CHUMI_DEV: '1', CHUMI_MOBILE: '', CHUMI_APP: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (s) => { output += s; }); child.stderr.on('data', (s) => { output += s; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(kill); }
    }
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const request = async <T = unknown>(path: string, method = 'GET'): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-chumi': '1' }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as T;
  };
  for (const deadline = Date.now() + 10000; ; ) {
    assert.equal(child.exitCode, null, output);
    try { await request('/api/health'); break; }
    catch (error) { if (Date.now() >= deadline) throw new Error(output, { cause: error }); await delay(20); }
  }
  assert.equal((await request<State>('/api/state')).asrDownload, null);
  const id = 'ggml-tiny-q5_1.bin';
  await request(`/api/asr/models/${id}/download`, 'POST');
  const readUntil = async (check: (d: DownloadState | null) => boolean): Promise<DownloadState> => {
    for (const deadline = Date.now() + 5000; ; ) {
      const state = await request<State>('/api/state');
      if (check(state.asrDownload)) { assert.ok(state.asrDownload); return state.asrDownload; }
      assert.ok(Date.now() < deadline, `Download state did not settle: ${JSON.stringify(state.asrDownload)}\n${output}`);
      await delay(20);
    }
  };
  const progress = await readUntil((d) => d?.status === 'downloading' && d.received === 1024);
  assert.deepEqual(progress, { id, status: 'downloading', received: 1024, total: 2048 });
  download.response!.end(Buffer.alloc(1024, 7));
  const failed = await readUntil((d) => d?.status === 'error');
  assert.equal(failed.id, id); assert.equal(failed.received, 2048); assert.match(failed.error!, /SHA-256/);
  assert.deepEqual((await request<State>('/api/state')).asrDownload, failed, 'the terminal status remains available without an SSE connection');
});
