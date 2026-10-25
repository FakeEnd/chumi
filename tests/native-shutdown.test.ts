import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the macOS shell waits for a save longer than three seconds and bounds an unresponsive child', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-native-shutdown-'));
  try {
    const source = join(root, 'main.swift');
    const binary = join(root, 'shutdown-test');
    writeFileSync(source, String.raw`
import Foundation
import Darwin

let node = CommandLine.arguments[1]
let marker = CommandLine.arguments[2]

func launch(_ script: String) throws -> Process {
    let child = Process()
    child.executableURL = URL(fileURLWithPath: node)
    child.arguments = ["-e", script, marker]
    let output = Pipe()
    child.standardOutput = output
    child.standardError = FileHandle.standardError
    try child.run()
    // Do not race SIGTERM against registration of the child's signal handler.
    let ready = try output.fileHandleForReading.read(upToCount: 6)
    precondition(ready == Data("ready\n".utf8))
    return child
}

let saving = try launch(#"""
const fs = require('node:fs');
process.on('SIGTERM', () => setTimeout(() => {
  fs.writeFileSync(process.argv[1], 'saved');
  process.exit(0);
}, 3400));
setTimeout(() => process.exit(10), 12000);
process.stdout.write('ready\n');
"""#)
let started = ProcessInfo.processInfo.systemUptime
precondition(ServerManager.stopOwnedProcess(saving))
saving.waitUntilExit()
precondition(saving.terminationReason == .exit && saving.terminationStatus == 0)
precondition(ProcessInfo.processInfo.systemUptime - started >= 3.3)
precondition(FileManager.default.fileExists(atPath: marker))
precondition(ServerManager.stopOwnedProcess(saving)) // Already exited: never signal a reused PID.

let stalled = try launch(#"""
process.on('SIGTERM', () => {});
setTimeout(() => process.exit(10), 12000);
process.stdout.write('ready\n');
"""#)
let stalledAt = ProcessInfo.processInfo.systemUptime
precondition(!ServerManager.stopOwnedProcess(stalled, timeout: 0.15))
stalled.waitUntilExit()
precondition(stalled.terminationReason == .uncaughtSignal && stalled.terminationStatus == SIGKILL)
precondition(ProcessInfo.processInfo.systemUptime - stalledAt < 2)
print("graceful-save-and-bounded-kill-ok")
`);
    execFileSync('/usr/bin/swiftc', [resolve('native/app/ServerManager.swift'), source, '-module-cache-path', join(root, 'swift-cache'), '-o', binary], {
      timeout: 60_000, stdio: 'pipe',
    });
    const output = execFileSync(binary, [process.execPath, join(root, 'saved')], { timeout: 20_000, encoding: 'utf8' });
    assert.match(output, /graceful-save-and-bounded-kill-ok/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
