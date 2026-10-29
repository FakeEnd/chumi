import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { setupMobileConfiguration } from '../server/mobile-config.ts';
import { getLang, setLang, t as translate } from '../web/src/i18n.ts';

async function startupNotice(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url + '/api/events', { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'the SSE stream ended before the startup notice');
        text += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = text.indexOf('\n\n')) !== -1) {
          const event = text.slice(0, boundary); text = text.slice(boundary + 2);
          if (!event.startsWith('event: notice\ndata: ')) continue;
          const notice = JSON.parse(event.slice('event: notice\ndata: '.length)) as { level: string; code: string; message: string };
          if (notice.code === 'mobile_start_failed') return notice;
        }
      }
    } finally { await reader.cancel(); }
  } finally { clearTimeout(timeout); controller.abort(); }
}

test('missing, invalid and expired mobile pairing leaves the desktop server usable', { timeout: 30_000 }, async (t) => {
  for (const scenario of ['missing', 'invalid', 'expired'] as const) await t.test(scenario, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chumi-mobile-startup-'));
    const reserve = createServer();
    reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    assert.notEqual(port, 4777);
    mkdirSync(join(dir, 'home'));
    mkdirSync(join(dir, 'mobile'));
    const args: string[] = [];
    if (scenario === 'invalid') writeFileSync(join(dir, 'mobile', 'companion.json'), '{}');
    if (scenario === 'expired') {
      const config = setupMobileConfiguration({ directory: join(dir, 'mobile'), address: '127.0.0.1' });
      const expiredAt = Date.parse(new X509Certificate(readFileSync(config.certificatePath)).validTo) + 1000;
      const preload = join(dir, 'clock.mjs');
      writeFileSync(preload, `Date.now = () => ${expiredAt};`);
      args.push('--import', pathToFileURL(preload).href);
    }
    const child = spawn(process.execPath, [...args, 'server/main.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, HOME: join(dir, 'home'), CHUMI_DATA_DIR: dir, CHUMI_MODELS_DIR: join(dir, 'models'),
        CHUMI_MOBILE: '1', CHUMI_APP: '', CHUMI_NO_HOTKEY: '1', CHUMI_DEV: '1', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const exited = once(child, 'exit');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
    try {
      await new Promise<void>((resolve, reject) => {
        const collect = (s: Buffer) => {
          output += s.toString();
          if (output.includes('Could not enable iPhone companion:')) resolve();
        };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        child.once('error', reject);
        void exited.then(() => reject(new Error(output)));
      });
      assert.match(output, scenario === 'missing' ? /not configured/ : scenario === 'invalid' ? /Invalid mobile configuration/ : /certificate expired/);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(response.status, 200, output);
      assert.equal((await response.json() as { ok: boolean }).ok, true);
      const url = `http://127.0.0.1:${port}`;
      const notice = await startupNotice(url);
      assert.deepEqual(notice, { level: 'error', code: 'mobile_start_failed', message: 'The iPhone companion could not start. See the server log.' });
      assert.deepEqual(await startupNotice(url), notice, 'reconnecting clients also see the startup failure');
      const language = getLang();
      try {
        setLang('zh');
        assert.equal(translate(notice.message), 'iPhone 连接服务未能启动，请查看服务器日志。');
      } finally { setLang(language); }
      child.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 0, output);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
