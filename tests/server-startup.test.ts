import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDataDirectoryLock } from '../server/instance-lock.ts';
import { Store } from '../server/db.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const moduleUrl = new URL('../server/instance-lock.ts', import.meta.url).href;
const folder = () => mkdtempSync(join(tmpdir(), 'chumi-startup-'));

async function rejectedStartup(dir: string, port: number) {
  const child = spawn(process.execPath, ['server/main.ts'], {
    cwd: repo, env: { ...process.env, PORT: String(port), CHUMI_DATA_DIR: dir, CHUMI_MODELS_DIR: join(dir, 'models'), CHUMI_NO_HOTKEY: '1', CHUMI_DEV: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (s) => { output += s; }); child.stderr.on('data', (s) => { output += s; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { const [code] = await once(child, 'exit'); assert.equal(code, 1, output); return output; }
  finally { clearTimeout(timer); }
}

function activeStore(dir: string) {
  const store = new Store(join(dir, 'chumi.db'));
  store.createSession({ id: 'active', title: 'Synthetic meeting', type: 'lab_meeting', audio_source: 'mic' });
  store.insertOutput({ id: 'answer', session_id: 'active', kind: 'answer', status: 'streaming' });
  return store;
}
function assertStillActive(store: Store) {
  assert.equal(store.getSession('active')?.status, 'recording');
  assert.equal(store.getOutput('answer')?.status, 'streaming');
  assert.deepEqual(store.timeline('active'), []);
}

test('a second server cannot recover live data, including when it chooses another port', { timeout: 10_000 }, async () => {
  const dir = folder(), lock = acquireDataDirectoryLock(dir), store = activeStore(dir);
  try {
    const output = await rejectedStartup(dir, 0);
    assert.match(output, /already using this data folder/);
    assertStillActive(store); // Ordinary DB/MCP readers remain usable while the server lock is held.
  } finally { store.close(); lock.release(); rmSync(dir, { recursive: true, force: true }); }
});

test('an occupied HTTP port rejects startup before crash recovery changes any meeting', { timeout: 10_000 }, async () => {
  const dir = folder(), store = activeStore(dir), occupied = createServer();
  occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  try {
    const output = await rejectedStartup(dir, (occupied.address() as { port: number }).port);
    assert.match(output, /EADDRINUSE/);
    assertStillActive(store);
    const next = acquireDataDirectoryLock(dir); next.release(); // Failed startup does not retain ownership.
  } finally { occupied.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a crash releases the data-folder lock without deleting stale files or trusting a PID', { timeout: 10_000 }, async () => {
  const dir = folder();
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireDataDirectoryLock } from ${JSON.stringify(moduleUrl)}; const lock = acquireDataDirectoryLock(process.argv[1]); process.on('exit', () => lock.release()); process.send('locked'); setInterval(() => {}, 1000);`, dir],
  { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr!.on('data', (s) => { diagnostics += s; });
  try {
    const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(diagnostics); })]);
    assert.equal(ready[0], 'locked');
    assert.throws(() => acquireDataDirectoryLock(dir), /already using/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const next = acquireDataDirectoryLock(dir); next.release(); next.release();
  } finally { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; } rmSync(dir, { recursive: true, force: true }); }
});

test('folder aliases cannot bypass ownership, and unrelated data folders remain independent', () => {
  const root = folder(), dir = join(root, 'data'), alias = join(root, 'alias');
  const first = acquireDataDirectoryLock(dir);
  try {
    symlinkSync(dir, alias, 'junction');
    assert.throws(() => acquireDataDirectoryLock(alias), /already using/);
    const other = acquireDataDirectoryLock(join(root, 'other')); other.release();
  } finally { first.release(); rmSync(root, { recursive: true, force: true }); }
});
