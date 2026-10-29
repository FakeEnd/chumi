import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('macOS startup failures explain missing dependencies and locks without putting stacks in the alert', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-native-startup-errors-'));
  try {
    const source = join(root, 'main.swift'), binary = join(root, 'startup-errors-test');
    writeFileSync(source, String.raw`
import Foundation
ShellLocalization.shared.setLanguage("en")
let repo = "/tmp/Chumi repo/研究"
for detail in ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@anthropic-ai/sdk' imported from /repo/server/main.ts", "Error: Cannot find module 'missing-package'", "Error: Cannot find module 'some-package/subpath'", "Error: Cannot find module '@scope/pkg/subpath'"] {
    let message = ServerManager.startupFailure(tail: "\(detail)\n at node:internal/modules/esm/resolve:12", repo: repo, reason: "Startup failed")
    precondition(message.contains("npm install") && message.contains(repo) && message.contains("Try Again"))
    precondition(!message.contains("node:internal"))
}
for specifier in ["./missing.js", "../shared/missing.ts", "/tmp/missing.js", "file:///tmp/missing.js", #"C:\repo\missing.js"#, #"\\server\share\missing.js"#, "node:missing"] {
    let detail = "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '\(specifier)' imported from /repo/server/main.ts"
    let message = ServerManager.startupFailure(tail: "\(detail)\n at node:internal/modules/esm/resolve:12\n code: 'MODULE_NOT_FOUND'", repo: repo, reason: "Startup failed")
    precondition(!message.contains("npm install"), "A missing local file is not a missing package: \(specifier)")
    precondition(message.contains(detail) && !message.contains("node:internal"))
}
precondition(!ServerManager.startupFailure(tail: "Error: MODULE_NOT_FOUND", repo: repo, reason: "Startup failed").contains("npm install"))
let locked = ServerManager.startupFailure(tail: "Error: Chumi is already using this data folder", repo: repo, reason: "Startup failed")
precondition(locked.contains("Another Chumi server") && locked.contains("Try Again"))
let port = ServerManager.startupFailure(tail: "listen EADDRINUSE", repo: repo, reason: "Startup failed")
precondition(port.contains("available port"))
let unknown = ServerManager.startupFailure(tail: "Error: earlier failure\n at old.frame\nTypeError: configuration must be an object\n at node:internal/loader", repo: repo, reason: "The server exited (status 2).")
precondition(unknown.contains("status 2") && unknown.contains("Open Log") && unknown.contains("TypeError: configuration must be an object"))
precondition(!unknown.contains("earlier failure") && !unknown.contains("old.frame"))
precondition(!unknown.contains("node:internal"))
let noError = ServerManager.startupFailure(tail: "Starting…\n at node:internal/loader", repo: repo, reason: "The server exited (status 2).")
precondition(noError.contains("status 2") && !noError.contains("node:internal"))
print("startup-errors-ok")
`);
    execFileSync('/usr/bin/swiftc', [resolve('native/app/ServerManager.swift'), resolve('native/app/ShellLocalization.swift'), source, '-module-cache-path', join(root, 'swift-cache'), '-o', binary], { timeout: 60_000, stdio: 'pipe' });
    assert.match(execFileSync(binary, { timeout: 5000, encoding: 'utf8' }), /startup-errors-ok/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
