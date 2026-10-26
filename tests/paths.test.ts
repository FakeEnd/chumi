import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { compareVersions, desktopClaudeCode, findClaude } from '../server/paths.ts';

/** A fake <version>/<hash>/claude.app/Contents/MacOS folder under root. */
function macos(root: string, version: string, hash: string): string {
  const dir = join(root, version, hash, 'claude.app', 'Contents', 'MacOS');
  mkdirSync(dir, { recursive: true });
  return dir;
}
function binary(dir: string, mode = 0o755, name = 'claude'): string {
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\n');
  chmodSync(p, mode);
  return p;
}

test('versions compare numerically', () => {
  assert.ok(compareVersions('2.1.304', '2.1.95') > 0);
  assert.ok(compareVersions('2.2', '2.1.999') > 0);
  assert.equal(compareVersions('2.1.0', '2.1'), 0);
});

test('the Claude app fallback picks the newest runnable Claude Code', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-claude-code-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (process.platform !== 'win32') {
    symlinkSync(join(root, '2.1.284', 'gone', 'claude'), join(macos(root, '2.1.310', 'a1'), 'claude')); // dangling link
    binary(macos(root, '2.1.308', 'c3'), 0o644); // not executable
  }
  macos(root, '2.1.309', 'b2'); // binary missing
  const want = binary(macos(root, '2.1.304', '6bbba6adc37f'));
  binary(macos(root, '2.1.95', 'd4')); // older, though it sorts after 2.1.304 as text
  binary(macos(root, 'latest', 'e5')); // not a version folder
  writeFileSync(join(root, '.DS_Store'), '');
  assert.equal(desktopClaudeCode(root), want);
});

test('the Claude app fallback finds nothing in a missing or empty folder', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-claude-code-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(desktopClaudeCode(join(root, 'absent')), null);
  macos(root, '2.1.304', 'a1');
  assert.equal(desktopClaudeCode(root), null);
});

test('a claude on PATH wins over the Claude app copy', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-path-'));
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); });
  const own = binary(dir, 0o755, process.platform === 'win32' ? 'claude.exe' : 'claude');
  process.env.PATH = [dir, path].join(delimiter);
  assert.equal(findClaude(), own);
});
