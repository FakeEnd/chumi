import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultCompatibleSettings, normalizeCompatibleUrl, validateCompatibleSettings } from '../shared/compatible-provider.ts';
import { DEFAULT_SETTINGS, isProviderId } from '../server/settings.ts';
import { deepMerge } from '../server/util.ts';

test('existing settings acquire disabled remote profiles without changing the active provider', () => {
  const oldSettings = { ai: { provider: 'claude-cli', claudeCli: { model: 'opus' } } };
  const settings = deepMerge(DEFAULT_SETTINGS, oldSettings);
  const compatible = validateCompatibleSettings(settings.ai.compatible);
  assert.equal(settings.ai.provider, 'claude-cli');
  assert.equal(settings.ai.claudeCli.model, 'opus');
  for (const preset of ['qwen', 'doubao', 'glm', 'minimax', 'custom'] as const) {
    assert.equal(compatible.profiles[preset].enabled, false);
    assert.equal(compatible.profiles[preset].supportsImages, false);
    assert.equal(compatible.profiles[preset].model, '');
  }
  assert.equal(isProviderId('compatible'), true);
  assert.equal(isProviderId('toString'), false);
});

test('model profiles keep separate configuration and normalize only the endpoint', () => {
  const settings = defaultCompatibleSettings();
  settings.preset = 'qwen';
  settings.profiles.qwen.model = ' my-account-model ';
  settings.profiles.qwen.baseUrl = 'https://EXAMPLE.com/compatible/v1///';
  const saved = validateCompatibleSettings(settings);
  assert.equal(saved.profiles.qwen.model, 'my-account-model');
  assert.equal(saved.profiles.qwen.baseUrl, 'https://example.com/compatible/v1');
  assert.equal(saved.profiles.minimax.model, '');
  assert.equal(settings.profiles.qwen.model, ' my-account-model ', 'validation does not mutate its input');
});

test('credentials and unknown configuration cannot be persisted through model settings', () => {
  const settings = defaultCompatibleSettings();
  assert.throws(() => validateCompatibleSettings({ ...settings, apiKey: 'secret' }), /Unknown/);
  assert.throws(() => validateCompatibleSettings({ ...settings, preset: '__proto__' }), /Invalid/);
  const withKey = structuredClone(settings);
  Object.assign(withKey.profiles.qwen, { apiKey: 'secret' });
  assert.throws(() => validateCompatibleSettings(withKey), /Keychain/);
  const unknown = structuredClone(settings);
  Object.assign(unknown.profiles, { other: unknown.profiles.qwen });
  assert.throws(() => validateCompatibleSettings(unknown), /Unknown/);
});

test('remote endpoints require HTTPS and local endpoints stay on loopback', () => {
  assert.equal(normalizeCompatibleUrl('http://localhost:11434/v1/', true), 'http://localhost:11434/v1');
  assert.equal(normalizeCompatibleUrl('http://[::1]:1234/v1', true), 'http://[::1]:1234/v1');
  for (const url of ['http://api.example.com/v1', 'file:///tmp/model', 'https://key:secret@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/#secret']) {
    assert.throws(() => normalizeCompatibleUrl(url, false));
  }
  for (const url of ['https://example.com/v1', 'http://localhost.example.com/v1', 'http://127.0.0.1.example.com/v1', 'http://192.168.1.1/v1']) {
    assert.throws(() => normalizeCompatibleUrl(url, true));
  }
});

test('malformed settings are rejected before a model request can run', () => {
  for (const invalid of [null, [], {}, { preset: 'ollama', profiles: {} }]) {
    assert.throws(() => validateCompatibleSettings(invalid));
  }
  for (const patch of [
    { enabled: 'yes' }, { supportsImages: 1 }, { maxOutputTokens: 0 }, { maxOutputTokens: 4096.5 },
    { maxOutputTokens: 999999 }, { structuredOutput: 'automatic' }, { structuredOutput: ['json_schema'] }, { model: 'model\r\nheader' },
    { baseUrl: 'https://remote.example.com' },
  ]) {
    const settings = defaultCompatibleSettings();
    Object.assign(settings.profiles.ollama, patch);
    assert.throws(() => validateCompatibleSettings(settings));
  }
});
