import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import config from '../web/vite.config.ts';

test('the development proxy sends the backend Host while preserving write headers and payloads', { timeout: 10_000 }, async (t) => {
  const upstream = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ host: req.headers.host, method: req.method, path: req.url, chumi: req.headers['x-chumi'], body: Buffer.concat(chunks).toString() }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const root = mkdtempSync(join(tmpdir(), 'chumi-proxy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const proxy = config.server?.proxy?.['/api'];
  assert.ok(proxy && typeof proxy !== 'string');
  const vite = await createServer({
    ...config, configFile: false, root, logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...config.server, host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { ...proxy, target } } },
  });
  t.after(() => vite.close());
  await vite.listen();
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}/api/session/end`;
  const response = await fetch(url, { method: 'POST', headers: { 'x-chumi': '1', 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { host: new URL(target).host, method: 'POST', path: '/api/session/end', chumi: '1', body: '{}' });
});
