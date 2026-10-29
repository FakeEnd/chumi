import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.ts';
import { recommendModel } from '../server/asr/models.ts';

test('setup remembers the mirror for app launches without selecting an AI provider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-setup-model-'));
  const env = { ...process.env, CHUMI_DATA_DIR: dir, CHUMI_MODELS_DIR: join(dir, 'models'), HOME: dir, CHUMI_MODEL_BASE_URL: '' };
  const base = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main';
  const run = (...args: string[]) => execFileSync(process.execPath, ['scripts/setup-model.ts', ...args], { env, encoding: 'utf8' }).trim();
  try {
    assert.equal(run('base', `${base}/`), base);
    assert.equal(run('base'), base);
    const store = new Store(join(dir, 'chumi.db'));
    try {
      assert.deepEqual(store.getKV('settings', {}), { asr: { modelBaseUrl: base } });
      assert.equal(store.getSettings().asr.modelBaseUrl, base);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('setup downloads the configured Whisper model, with the recommendation only as a fresh default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-setup-model-'));
  const run = () => execFileSync(process.execPath, ['scripts/setup-model.ts', 'model'], { env: { ...process.env, CHUMI_DATA_DIR: dir, HOME: dir }, encoding: 'utf8' }).trim();
  try {
    assert.equal(run(), recommendModel());
    const store = new Store(join(dir, 'chumi.db'));
    try {
      assert.equal(store.getKV('settings', null), null);
      for (const model of ['ggml-small-q5_1.bin', 'ggml-large-v3-q5_0.bin']) {
        store.setKV('settings', { asr: { model }, ui: { language: 'zh' } });
        assert.equal(run(), model);
        assert.deepEqual(store.getKV('settings', {}), { asr: { model }, ui: { language: 'zh' } });
      }
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('setup repairs unknown models and invalid download URLs without a stack trace or other settings changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-setup-model-'));
  const store = new Store(join(dir, 'chumi.db'));
  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/setup-model.ts', ...args], { env: { ...process.env, CHUMI_DATA_DIR: dir, HOME: dir, CHUMI_MODEL_BASE_URL: '' }, encoding: 'utf8' });
  try {
    store.setKV('settings', { asr: { model: 'unknown-model', modelBaseUrl: 'not-a-url' }, ui: { language: 'zh' } });
    let result = run('model');
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), recommendModel());
    assert.match(result.stderr, /Unknown configured Whisper model.*recommended/);
    assert.doesNotMatch(result.stderr, /Error:|at .*setup-model/);
    result = run('base');
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main');
    assert.match(result.stderr, /Invalid model download URL.*Hugging Face/);
    assert.doesNotMatch(result.stderr, /Error:|at .*setup-model/);
    assert.equal(store.getSettings().asr.model, recommendModel());
    assert.equal(store.getSettings().asr.modelBaseUrl, result.stdout.trim());
    assert.equal(store.getSettings().ui.language, 'zh');
    result = run('base', 'file:///tmp/models');
    assert.equal(result.status, 0);
    assert.match(result.stderr, /Invalid model download URL/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an unattended setup does not silently select or save a mirror after a failed connectivity check', () => {
  const setup = readFileSync(new URL('../scripts/setup.sh', import.meta.url), 'utf8');
  const start = setup.indexOf('  if [[ $BASE == https://huggingface.co/');
  const snippet = setup.slice(start, setup.indexOf('  echo "  Downloading', start));
  for (const interactive of ['0', '1']) {
    const result = spawnSync('bash', ['-c', `set -euo pipefail\nBASE=https://huggingface.co/ggerganov/whisper.cpp/resolve/main\nMODEL=test.bin\ncurl() { return 1; }\nwarn() { echo "$1"; }\nask() { echo ASK >&2; }\nnode() { echo SAVE >&2; echo https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main; }\n${snippet}\necho "$BASE"`], { env: { ...process.env, INTERACTIVE: interactive }, encoding: 'utf8' });
    assert.equal(result.status, 0);
    if (interactive === '0') {
      assert.doesNotMatch(result.stderr, /ASK|SAVE/);
      assert.match(result.stdout, /rerun setup with --mirror/);
      assert.ok(result.stdout.trim().endsWith('https://huggingface.co/ggerganov/whisper.cpp/resolve/main'));
    } else {
      assert.match(result.stderr, /ASK/);
      assert.match(result.stderr, /SAVE/);
      assert.ok(result.stdout.trim().endsWith('https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main'));
    }
  }
});
