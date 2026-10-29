import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('macOS pet answer links open externally without replacing the pet or launching unsupported schemes', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-native-pet-links-'));
  try {
    const source = join(root, 'main.swift'), binary = join(root, 'pet-links-test');
    writeFileSync(source, String.raw`
import Foundation
let base = URL(string: "http://127.0.0.1:48812/")!
for raw in ["https://example.com/paper", "http://example.com/docs", "mailto:author@example.com"] {
    let url = URL(string: raw)!
    precondition(WebController.isExternalURL(url))
    precondition(PetPanel.navigation(url: url, base: base, mainFrame: nil, link: true) == .external)
    precondition(PetPanel.navigation(url: url, base: base, mainFrame: true, link: true) == .external)
    precondition(PetPanel.navigation(url: url, base: base, mainFrame: true, link: false) == .cancel)
}
for raw in ["file:///tmp/secret", "javascript:alert(1)", "codex://settings", "data:text/html,hello"] {
    let url = URL(string: raw)!
    precondition(!WebController.isExternalURL(url))
    precondition(PetPanel.navigation(url: url, base: base, mainFrame: nil, link: true) == .cancel)
    precondition(PetPanel.navigation(url: url, base: base, mainFrame: true, link: true) == .cancel)
}
precondition(PetPanel.navigation(url: base.appendingPathComponent("pet.html"), base: base, mainFrame: true, link: false) == .allow)
precondition(PetPanel.navigation(url: URL(string: "https://127.0.0.1:48812/pet.html"), base: base, mainFrame: true, link: false) == .cancel)
precondition(PetPanel.navigation(url: URL(string: "https://example.com/frame"), base: base, mainFrame: false, link: false) == .allow)
print("pet-links-ok")
`);
    execFileSync('/usr/bin/swiftc', [resolve('native/app/PetPanel.swift'), resolve('native/app/WebController.swift'), resolve('native/app/ShellLocalization.swift'), resolve('native/app/WindowChrome.swift'), source,
      '-swift-version', '5', '-module-cache-path', join(root, 'swift-cache'), '-o', binary], { timeout: 60_000, stdio: 'pipe' });
    assert.match(execFileSync(binary, { timeout: 5000, encoding: 'utf8' }), /pet-links-ok/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
