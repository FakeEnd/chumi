import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('macOS discovers the data folder server before the default port and rejects stale or unsafe records', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-native-discovery-'));
  try {
    const source = join(root, 'main.swift'), binary = join(root, 'discovery-test');
    writeFileSync(source, String.raw`
import Foundation
import Darwin
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let file = directory.appendingPathComponent("server.json")
let home = directory.appendingPathComponent("home", isDirectory: true)
precondition(ServerManager.dataDirectory(environment: [:], home: home, repo: directory.path) == home.appendingPathComponent("Library/Application Support/Chumi", isDirectory: true))
precondition(ServerManager.dataDirectory(environment: ["CHUMI_DATA_DIR": "scratch"], home: home, repo: directory.path).path == directory.appendingPathComponent("scratch").path)
precondition(ServerManager.dataDirectory(environment: ["CHUMI_DATA_DIR": directory.path], home: home, repo: "/unused").path == directory.path)
func record(_ url: String, pid: Int32 = getpid()) throws {
    try JSONSerialization.data(withJSONObject: ["url": url, "pid": pid]).write(to: file)
}
try record("http://127.0.0.1:48812")
precondition(ServerManager.recordedPort(in: directory) == 48812)
var probes = [Int]()
let found = ServerManager.existingPort(in: directory, fallback: 48813) { port in probes.append(port); return true }
precondition(found == 48812 && probes == [48812])
probes = []
let fallback = ServerManager.existingPort(in: directory, fallback: 48813) { port in probes.append(port); return port == 48813 }
precondition(fallback == 48813 && probes == [48812, 48812, 48813])
probes = []
precondition(ServerManager.existingPort(in: directory, fallback: 48813) { port in probes.append(port); return probes.count == 2 } == 48812)
precondition(probes == [48812, 48812])
precondition(ServerManager.recordedPort(in: directory, processExists: { _ in false }) == nil)
for raw in ["https://127.0.0.1:48812", "http://example.com:48812", "http://127.0.0.1:48812/other", "http://user@localhost:48812", "http://localhost:48812?x=1", "http://localhost:48812#x", "http://localhost:0", "http://localhost:65536"] {
    try record(raw)
    precondition(ServerManager.recordedPort(in: directory) == nil, raw)
}
try record("http://localhost:48812/", pid: -1)
precondition(ServerManager.recordedPort(in: directory) == nil)
try Data("not json".utf8).write(to: file)
precondition(ServerManager.recordedPort(in: directory) == nil)
probes = []
precondition(ServerManager.existingPort(in: directory, fallback: 48813) { port in probes.append(port); return false } == nil)
precondition(probes == [48813, 48813])
precondition(ServerManager.isChumi((200, ["app": "chumi"])))
precondition(!ServerManager.isChumi((200, ["app": "other"])))
precondition(!ServerManager.isChumi((503, ["app": "chumi"])))
print("server-discovery-ok")
`);
    execFileSync('/usr/bin/swiftc', [resolve('native/app/ServerManager.swift'), resolve('native/app/ShellLocalization.swift'), source, '-module-cache-path', join(root, 'swift-cache'), '-o', binary], { timeout: 60_000, stdio: 'pipe' });
    assert.match(execFileSync(binary, [root], { timeout: 5000, encoding: 'utf8' }), /server-discovery-ok/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
