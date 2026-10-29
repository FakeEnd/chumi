import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/db.ts';
import { acquireDataDirectoryLock, DataDirectoryInUseError } from '../server/instance-lock.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const folder = () => mkdtempSync(join(tmpdir(), 'chumi-setup-provider-'));
const storeAt = (dir: string) => new Store(join(dir, 'chumi.db'));
function helper(dir: string, ...args: string[]) {
  return execFileSync(process.execPath, ['scripts/setup-provider.ts', ...args], {
    cwd: repo, env: { ...process.env, CHUMI_DATA_DIR: dir, HOME: dir }, encoding: 'utf8',
  }).trim();
}

for (const provider of ['codex', 'claude-cli', 'compatible'] as const) {
  test(`setup saves ${provider} on a fresh install`, () => {
    const dir = folder();
    try {
      assert.equal(helper(dir, 'current'), '');
      assert.equal(helper(dir, 'use', provider), `saved:${provider}`);
      assert.equal(helper(dir, 'current'), provider);
      const store = storeAt(dir);
      try {
        const settings = store.getSettings();
        assert.equal(settings.ai.provider, provider);
        if (provider === 'compatible') {
          assert.equal(settings.ai.compatible.preset, 'ollama');
          assert.equal(settings.ai.compatible.profiles.ollama.enabled, true);
          assert.equal(settings.ai.compatible.profiles.ollama.baseUrl, 'http://127.0.0.1:11434/v1');
          assert.equal(settings.ai.compatible.profiles.ollama.model, '');
        }
      } finally { store.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const provider of ['codex', 'compatible', 'anthropic-api'] as const) {
  test(`setup preserves the saved ${provider} provider and other settings`, () => {
    const dir = folder(), store = storeAt(dir);
    try {
      const settings = store.getSettings();
      settings.ai.provider = provider;
      settings.ai.effort = 'high';
      settings.ai.compatible.preset = 'lmstudio';
      settings.ai.compatible.profiles.lmstudio.model = 'my-model';
      settings.ui.language = 'zh';
      store.saveSettings(settings);
      const before = store.getSettings();
      assert.equal(helper(dir, 'current'), provider);
      assert.equal(helper(dir, 'use', 'claude-cli'), `existing:${provider}`);
      assert.deepEqual(store.getSettings(), before);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('setup preserves other settings when no provider has been saved', () => {
  const dir = folder(), store = storeAt(dir);
  try {
    store.setKV('settings', { ui: { language: 'zh' }, ai: { effort: 'high' } });
    assert.equal(helper(dir, 'current'), '');
    assert.equal(helper(dir, 'use', 'claude-cli'), 'saved:claude-cli');
    const settings = store.getSettings();
    assert.equal(settings.ai.provider, 'claude-cli');
    assert.equal(settings.ai.effort, 'high');
    assert.equal(settings.ui.language, 'zh');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('setup does not write settings while a server owns the data directory', () => {
  const dir = folder(), lock = acquireDataDirectoryLock(dir), store = storeAt(dir);
  try {
    assert.throws(() => acquireDataDirectoryLock(dir), DataDirectoryInUseError);
    assert.equal(helper(dir, 'use', 'compatible'), 'running');
    assert.equal(store.getKV('settings', null), null);
  } finally { store.close(); lock.release(); rmSync(dir, { recursive: true, force: true }); }
});

function runAiStep(dir: string, choice: string) {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const name of ['codex', 'claude', 'ollama', 'brew']) {
    const body = name === 'codex' ? 'if [[ $1 == login && ${2:-} == status ]]; then [[ -f "$CHUMI_DATA_DIR/codex-ready" ]] && echo ChatGPT; elif [[ $1 == login ]]; then touch "$CHUMI_DATA_DIR/codex-ready"; fi'
      : name === 'claude' ? 'if [[ $1 == auth && ${2:-} == status ]]; then [[ -f "$CHUMI_DATA_DIR/claude-ready" ]] && echo "{\\"loggedIn\\": true}"; elif [[ $1 == auth && ${2:-} == login ]]; then touch "$CHUMI_DATA_DIR/claude-ready"; fi'
        : 'exit 0';
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  }
  const setup = readFileSync(join(repo, 'scripts/setup.sh'), 'utf8');
  const start = setup.indexOf('step "Connecting an AI"');
  const end = setup.indexOf('step "Final check"', start);
  assert.ok(start >= 0 && end > start);
  const snippet = setup.slice(start, end);
  return execFileSync('bash', ['-c', `set -euo pipefail\nAI=1 INTERACTIVE=1\nstep() { :; }\nok() { echo "$1"; }\nwarn() { echo "$1"; }\n${snippet}`], {
    cwd: repo, env: { ...process.env, CHUMI_DATA_DIR: dir, HOME: dir, PATH: `${bin}:${process.env.PATH}` }, input: `${choice}\n`, encoding: 'utf8',
  });
}

for (const [choice, provider] of [['1', 'codex'], ['2', 'claude-cli'], ['3', 'compatible']] as const) {
  test(`setup menu option ${choice} saves ${provider}`, () => {
    const dir = folder();
    try {
      runAiStep(dir, choice);
      assert.equal(helper(dir, 'current'), provider);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const provider of ['codex', 'compatible', 'anthropic-api'] as const) {
  test(`setup keeps the saved ${provider} when Claude is signed in`, () => {
    const dir = folder(), store = storeAt(dir);
    try {
      const settings = store.getSettings();
      settings.ai.provider = provider;
      store.saveSettings(settings);
      writeFileSync(join(dir, 'claude-ready'), '');
      const output = runAiStep(dir, '4');
      assert.equal(store.getSettings().ai.provider, provider);
      assert.match(output, provider === 'codex' ? /ChatGPT|codex/i : provider === 'compatible' ? /compatible|ollama|model/i : /anthropic|api/i);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('setup automatically selects Claude on a fresh install when only Claude is signed in', () => {
  const dir = folder();
  try {
    writeFileSync(join(dir, 'claude-ready'), '');
    const output = runAiStep(dir, '4');
    assert.equal(helper(dir, 'current'), 'claude-cli');
    assert.match(output, /Claude plan.*signed in/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('setup tells the user to select the local model in Settings if Chumi is running', () => {
  const dir = folder(), lock = acquireDataDirectoryLock(dir), store = storeAt(dir);
  try {
    const output = runAiStep(dir, '3');
    assert.match(output, /running.*did not change.*Settings/i);
    assert.equal(store.getKV('settings', null), null);
  } finally { store.close(); lock.release(); rmSync(dir, { recursive: true, force: true }); }
});

test('selecting local enables Ollama when an old profile was disabled', () => {
  const dir = folder(), store = storeAt(dir);
  try {
    const compatible = store.getSettings().ai.compatible;
    compatible.preset = 'lmstudio';
    compatible.profiles.ollama.enabled = false;
    compatible.profiles.ollama.model = 'my-local-model';
    store.setKV('settings', { ai: { compatible } });
    assert.equal(helper(dir, 'use', 'compatible'), 'saved:compatible');
    const saved = store.getSettings().ai.compatible;
    assert.equal(saved.preset, 'ollama');
    assert.equal(saved.profiles.ollama.enabled, true);
    assert.equal(saved.profiles.ollama.model, 'my-local-model');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
