import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the macOS port probe reuses TIME_WAIT ports but rejects live listeners', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-native-ports-'));
  try {
    const source = join(root, 'main.swift'), binary = join(root, 'ports-test');
    writeFileSync(source, String.raw`
import Foundation
import Darwin

var addr = sockaddr_in()
addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
addr.sin_family = sa_family_t(AF_INET)
addr.sin_addr.s_addr = inet_addr("127.0.0.1")
var size = socklen_t(MemoryLayout<sockaddr_in>.size)
func withAddress(_ body: (UnsafePointer<sockaddr>) -> Int32) -> Int32 {
    withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1, body) }
}
let listener = socket(AF_INET, SOCK_STREAM, 0)
var reuse: Int32 = 1
precondition(setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size)) == 0)
precondition(withAddress { bind(listener, $0, size) } == 0)
precondition(withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &size) } } == 0)
let port = Int(UInt16(bigEndian: addr.sin_port))
precondition(port != ServerManager.defaultPort)
precondition(listen(listener, 8) == 0)

let client = socket(AF_INET, SOCK_STREAM, 0)
precondition(withAddress { connect(client, $0, size) } == 0)
let accepted = accept(listener, nil, nil)
precondition(accepted >= 0)
precondition(ServerManager.portBusy(port))
// The server closes first, just as it does with an open SSE stream on quit.
close(accepted)
var byte: UInt8 = 0
precondition(read(client, &byte, 1) == 0)
close(client)
close(listener)
usleep(100_000)
let plain = socket(AF_INET, SOCK_STREAM, 0)
precondition(withAddress { bind(plain, $0, size) } == -1 && errno == EADDRINUSE, "Expected TIME_WAIT to block a plain bind")
close(plain)
precondition(!ServerManager.portBusy(port), "Node can reuse the port during TIME_WAIT")
print("port-reuse-ok")
`);
    execFileSync('/usr/bin/swiftc', [resolve('native/app/ServerManager.swift'), resolve('native/app/ShellLocalization.swift'), source, '-module-cache-path', join(root, 'swift-cache'), '-o', binary], { timeout: 60_000, stdio: 'pipe' });
    assert.match(execFileSync(binary, { timeout: 5000, encoding: 'utf8' }), /port-reuse-ok/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
