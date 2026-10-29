import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the macOS shell reports only ready-server exits and accepts one start at a time', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-native-lifecycle-'));
  try {
    const source = join(root, 'main.swift'), binary = join(root, 'lifecycle-test');
    writeFileSync(source, String.raw`
import Foundation

var lifecycle = ServerLifecycle()
let failed = Process(), ready = Process(), replacement = Process()
precondition(lifecycle.beginStart())
precondition(!lifecycle.beginStart(), "Two restart requests must not spawn competing children")
precondition(!lifecycle.shouldReportExit(failed), "Startup failure has its own result alert")
lifecycle.finishStart()
precondition(!lifecycle.shouldReportExit(failed), "A queued startup exit must stay suppressed")
precondition(lifecycle.beginStart())
lifecycle.markReady(ready)
precondition(!lifecycle.shouldReportExit(ready), "Deliver the startup result before a crash alert")
lifecycle.finishStart()
precondition(lifecycle.shouldReportExit(ready))
precondition(!lifecycle.shouldReportExit(failed))
precondition(lifecycle.beginStart())
precondition(!lifecycle.shouldReportExit(ready), "Ignore stale crash callbacks during restart")
lifecycle.stop()
precondition(!lifecycle.beginStart(), "Stopping the old child must not release the start guard")
lifecycle.markReady(replacement)
lifecycle.finishStart()
precondition(!lifecycle.shouldReportExit(ready), "Ignore the previous child even after restart finishes")
precondition(lifecycle.shouldReportExit(replacement))
lifecycle.stop()
precondition(!lifecycle.shouldReportExit(replacement), "Do not report intentional or already reported exits")
print("server-lifecycle-ok")
`);
    execFileSync('/usr/bin/swiftc', [resolve('native/app/ServerManager.swift'), resolve('native/app/ShellLocalization.swift'), source, '-module-cache-path', join(root, 'swift-cache'), '-o', binary], { timeout: 60_000, stdio: 'pipe' });
    assert.match(execFileSync(binary, { timeout: 5000, encoding: 'utf8' }), /server-lifecycle-ok/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
