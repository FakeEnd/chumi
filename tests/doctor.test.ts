import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandLineTools, javascriptPackages } from '../scripts/doctor-checks.ts';
import { Store } from '../server/db.ts';

test('doctor detects missing, stale and incomplete JavaScript dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-doctor-'));
  try {
    const packages = { '': {}, 'node_modules/example': { version: '1.0.0', integrity: 'sha512-test' }, 'node_modules/optional': { version: '1', optional: true } };
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages }));
    assert.equal(javascriptPackages(dir), false);
    mkdirSync(join(dir, 'node_modules/example'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/.package-lock.json'), JSON.stringify({ packages }));
    assert.equal(javascriptPackages(dir), false);
    writeFileSync(join(dir, 'node_modules/example/package.json'), '{}');
    writeFileSync(join(dir, 'node_modules/.package-lock.json'), JSON.stringify({ packages: { 'node_modules/example': packages['node_modules/example'] } }));
    assert.equal(javascriptPackages(dir), true);
    packages['node_modules/example'].version = '2.0.0';
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages }));
    assert.equal(javascriptPackages(dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor runs Swift through xcrun and distinguishes missing tools from an unaccepted license', () => {
  for (const [error, fix] of [['invalid active developer path', 'xcode-select --install'], ['You have not agreed to the Xcode license', 'sudo xcodebuild -license accept']]) {
    const calls: string[][] = [];
    const result = commandLineTools((args) => { calls.push(args); return args[0] === '--find' ? { status: 0, stdout: '/usr/bin/swiftc' } : { status: 1, stderr: error }; });
    assert.deepEqual(result, { ready: false, fix });
    assert.deepEqual(calls, [['--find', 'swiftc'], ['swiftc', '-version']]);
  }
  assert.equal(commandLineTools(() => ({ status: 0 })).ready, true);
  assert.equal(commandLineTools(() => ({ status: null, error: new Error('missing') })).ready, false);
});

test('setup checks the compiler itself and gives the matching repair command', () => {
  const source = readFileSync(new URL('../scripts/setup.sh', import.meta.url), 'utf8');
  const snippet = source.slice(source.indexOf('tools_ready()'), source.indexOf('# Homebrew may'));
  for (const [error, fix] of [['invalid active developer path', 'xcode-select --install'], ['Xcode license not accepted', 'sudo xcodebuild -license accept'], ['', 'ready']]) {
    const run = spawnSync('bash', ['-c', `set -euo pipefail\nINTERACTIVE=0\nok() { echo ready; }\nwarn() { :; }\nfail() { echo "$@"; exit 1; }\nxcrun() { if [[ $1 == --find ]]; then echo /usr/bin/swiftc; elif [[ -n $TOOL_ERROR ]]; then echo "$TOOL_ERROR" >&2; return 1; fi; }\n${snippet}`], { env: { ...process.env, TOOL_ERROR: error }, encoding: 'utf8' });
    assert.equal(run.status, error ? 1 : 0);
    assert.ok(run.stdout.includes(fix), run.stdout);
  }
});

test('doctor prints actionable checks in a checkout with no node_modules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-doctor-'));
  try {
    for (const path of ['server', 'shared', 'scripts/doctor.ts', 'scripts/doctor-checks.ts', 'package.json', 'package-lock.json']) cpSync(new URL(`../${path}`, import.meta.url), join(dir, path), { recursive: true });
    const data = join(dir, 'data'), store = new Store(join(data, 'chumi.db'));
    try { store.setKV('settings', { ai: { provider: 'mock' }, asr: { diarization: true } }); } finally { store.close(); }
    const helper = join(dir, 'audio-helper');
    writeFileSync(helper, `#!/bin/sh\ntouch "$HOME/permission-probed"\necho '{"microphone":"denied"}'\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ['scripts/doctor.ts'], { cwd: dir, env: { ...process.env, HOME: dir, CHUMI_DATA_DIR: data, CHUMI_MODELS_DIR: join(dir, 'models'), CHUMI_AUDIO_HELPER: helper, CHUMI_NO_HOTKEY: '1' }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✗ JavaScript packages installed and up to date/);
    assert.match(result.stdout, /Fix: bash scripts\/setup.sh.*npm ci/);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
    assert.match(result.stdout, /Chumi checks its own permission/);
    assert.equal(existsSync(join(dir, 'permission-probed')), false);
    assert.doesNotMatch(result.stdout, /✓ Microphone allowed|✗ Microphone access is off/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
