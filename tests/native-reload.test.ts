import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('macOS reload returns from an error document to the attached Chumi server', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-native-reload-'));
  try {
    const source = join(root, 'main.swift'), binary = join(root, 'reload-test');
    writeFileSync(source, String.raw`
import Foundation
let base = URL(string: "http://127.0.0.1:48812/")!
precondition(WebController.reloadURL(current: nil, base: base) == base)
for raw in ["about:blank", "data:text/html,error", "blob:http://127.0.0.1:48812/id", "https://example.com", "http://127.0.0.1:48813/", "http://example.com:48812/"] {
    precondition(WebController.reloadURL(current: URL(string: raw), base: base) == base)
}
for raw in ["http://127.0.0.1:48812/?meeting=123#transcript", "http://localhost:48812/"] {
    let current = URL(string: raw)!
    precondition(WebController.reloadURL(current: current, base: base) == current)
}
print("reload-recovery-ok")
`);
    execFileSync('/usr/bin/swiftc', [resolve('native/app/WebController.swift'), resolve('native/app/ShellLocalization.swift'), resolve('native/app/WindowChrome.swift'), source,
      '-swift-version', '5', '-module-cache-path', join(root, 'swift-cache'), '-o', binary], { timeout: 60_000, stdio: 'pipe' });
    assert.match(execFileSync(binary, { timeout: 5000, encoding: 'utf8' }), /reload-recovery-ok/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
