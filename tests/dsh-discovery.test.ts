import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createWindowsDshLocator } from '../server/projects/dsh.ts';

test('Windows registry queries preserve cmd quoting and verbatim arguments', async (t) => {
  const run = t.mock.method(childProcess, 'execFile', (...args: any[]) => {
    queueMicrotask(() => args[3](null, ''));
    return {} as childProcess.ChildProcess;
  });
  syncBuiltinESMExports();
  t.after(() => { run.mock.restore(); syncBuiltinESMExports(); });
  const locate = createWindowsDshLocator({ usual: () => 'missing', exists: () => false });
  assert.equal(await locate(), null);
  assert.deepEqual(run.mock.calls.map((call) => call.arguments.slice(0, 3)), ['HKCU', 'HKLM'].map((hive) => [
    'cmd.exe', ['/d', '/s', '/c', `"chcp 65001 >nul & reg.exe query "${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s"`],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: true },
  ]));
});

test('Windows discovery accepts versioned display names without matching unrelated apps', async () => {
  for (const name of ['DeepSeek Harness', 'DeepSeek Harness 1.2.3', 'DeepSeek HarnessOther']) {
    const locate = createWindowsDshLocator({ usual: () => 'missing', exists: (path) => path === 'custom', query: async () =>
      `HKEY_LOCAL_MACHINE\\Software\\Uninstall\\Dsh\n    DisplayName    REG_SZ    ${name}\n    InstallLocation    REG_SZ    custom\n` });
    assert.equal(await locate(), name === 'DeepSeek HarnessOther' ? null : 'custom');
  }
});

test('Windows discovery checks the default folder before scanning the registry', async () => {
  let queries = 0;
  const locate = createWindowsDshLocator({ usual: () => 'default', exists: (path) => path === join('default', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), query: async () => { queries++; return ''; } });
  assert.equal(await locate(), 'default');
  assert.equal(queries, 0);
});

test('Windows discovery skips a default folder left behind without its dsh command', async () => {
  const entry = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\dsh\r\n    DisplayName    REG_SZ    DeepSeek Harness\r\n    InstallLocation    REG_SZ    D:\\Apps\\DeepSeek Harness\r\n';
  const locate = createWindowsDshLocator({ usual: () => 'default', exists: (path) => path === 'default' || path === 'D:\\Apps\\DeepSeek Harness', query: async (hive) => hive === 'HKCU' ? entry : '' });
  assert.equal(await locate(), 'D:\\Apps\\DeepSeek Harness');
});

test('Windows registry discovery stays asynchronous, shares scans and caches misses until refresh', async () => {
  const queries: string[] = [], finish: Array<(text: string) => void> = [];
  const locate = createWindowsDshLocator({ usual: () => 'missing', exists: (path) => path === 'D:\\应用\\DeepSeek Harness', query: (hive) => {
    queries.push(hive);
    return new Promise<string>((resolve) => finish.push(resolve));
  } });
  const first = locate();
  const simultaneous = locate(true);
  assert.equal(first, simultaneous);
  let ticked = false;
  await new Promise<void>((resolve) => setImmediate(() => { ticked = true; resolve(); }));
  assert.equal(ticked, true, 'other event-loop work runs during the registry scan');
  assert.deepEqual(queries, ['HKCU', 'HKLM']);
  finish.splice(0).forEach((resolve) => resolve(''));
  assert.equal(await first, null);
  assert.equal(await locate(), null);
  assert.equal(queries.length, 2, 'a cached miss does not scan again');
  const refreshed = locate(true);
  finish.splice(0).forEach((resolve) => resolve('HKEY_LOCAL_MACHINE\\Software\\Uninstall\\Dsh\r\n    DisplayName    REG_SZ    DeepSeek Harness\r\n    InstallLocation    REG_SZ    D:\\应用\\DeepSeek Harness\r\n'));
  assert.equal(await refreshed, 'D:\\应用\\DeepSeek Harness');
  assert.equal(await locate(), 'D:\\应用\\DeepSeek Harness');
  assert.equal(queries.length, 4);
});

test('Windows discovery tolerates an unavailable hive and ignores stale uninstall entries', async () => {
  const locate = createWindowsDshLocator({ usual: () => 'missing', exists: () => false, query: async (hive) => {
    if (hive === 'HKCU') throw new Error('Registry unavailable');
    return 'HKEY_LOCAL_MACHINE\\Software\\Uninstall\\Dsh\n    DisplayName    REG_SZ    DeepSeek Harness\n    InstallLocation    REG_SZ    deleted';
  } });
  assert.equal(await locate(), null);
});
