import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { certificateFingerprint, loadMobileConfiguration, pairingCode, setupMobileConfiguration, validateMobileAddress } from '../server/mobile-config.ts';

test('mobile pairing generates matching TLS credentials, private files, and a reusable revocable token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-mobile-pairing-'));
  try {
    const original = setupMobileConfiguration({ directory: dir, address: 'test-mac.local' });
    const loaded = loadMobileConfiguration(join(dir, 'companion.json'));
    assert.equal(loaded.token, original.token);
    assert.equal(new X509Certificate(loaded.tls.cert).checkHost('test-mac.local'), 'test-mac.local');
    assert.equal(certificateFingerprint(loaded.tls.cert), original.certificateSHA256);
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, 'companion.json')).mode & 0o777, 0o600);
      assert.equal(statSync(original.privateKeyPath).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    }
    assert.deepEqual(JSON.parse(pairingCode(original)), { url: 'https://test-mac.local:4778', token: original.token, certificateSHA256: original.certificateSHA256 });
    assert.equal(setupMobileConfiguration({ directory: dir }).token, original.token);
    assert.equal(setupMobileConfiguration({ directory: dir, address: 'TEST-MAC.local', port: 4778 }).token, original.token);
    assert.throws(() => setupMobileConfiguration({ directory: dir, address: 'another.local' }), /--rotate/);
    assert.throws(() => setupMobileConfiguration({ directory: dir, port: 4780 }), /--rotate/);
    assert.equal(loadMobileConfiguration(join(dir, 'companion.json')).token, original.token, 'rejected changes never revoke the pairing');
    const rotated = setupMobileConfiguration({ directory: dir, address: '192.168.1.20', rotate: true });
    assert.notEqual(rotated.token, original.token);
    assert.notEqual(rotated.certificateSHA256, original.certificateSHA256);
    assert.equal(new X509Certificate(readFileSync(rotated.certificatePath)).checkIP('192.168.1.20'), '192.168.1.20');
    const path = join(dir, 'companion.json');
    writeFileSync(path, JSON.stringify({ ...rotated, certificateSHA256: original.certificateSHA256 }));
    assert.throws(() => loadMobileConfiguration(path), /certificate changed/);
    writeFileSync(path, JSON.stringify({ ...rotated, url: 'http://192.168.1.20:4778' }));
    assert.throws(() => loadMobileConfiguration(path), /HTTPS/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mobile setup reuses a custom address and port when neither is specified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-mobile-custom-'));
  try {
    const original = setupMobileConfiguration({ directory: dir, address: '::1', port: 4988 });
    assert.deepEqual(setupMobileConfiguration({ directory: dir }), original);
    assert.deepEqual(setupMobileConfiguration({ directory: dir, address: '0:0:0:0:0:0:0:1' }), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mobile setup CLI reprints custom pairing and refuses address changes without rotation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-mobile-cli-'));
  try {
    const original = setupMobileConfiguration({ directory: join(dir, 'mobile'), address: 'test-mac.local', port: 4988 });
    const run = (...args: string[]) => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/mobile-setup.ts', import.meta.url)), ...args], {
      env: { ...process.env, HOME: dir, CHUMI_DATA_DIR: dir }, encoding: 'utf8',
    });
    const reused = run();
    assert.equal(reused.status, 0, reused.stderr);
    assert.ok(reused.stdout.includes(original.url));
    const rejected = run('--address', 'new-mac.local');
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /--rotate/);
    assert.equal(loadMobileConfiguration(join(dir, 'mobile', 'companion.json')).token, original.token);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pairing address rejects configuration injection, URL secrets, and invalid hostnames', () => {
  for (const value of ['https://mac.local', 'mac.local,IP:1.2.3.4', 'mac.local\nDNS:evil', '-bad.local', 'a..local', '', '127.0.0.1:4778']) {
    assert.throws(() => validateMobileAddress(value));
  }
  assert.equal(validateMobileAddress('Chumi-Mac.local'), 'Chumi-Mac.local');
  assert.equal(validateMobileAddress('::1'), '::1');
});
