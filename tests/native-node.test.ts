import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function executable(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

test('the macOS build records only a usable Node 24 or later', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-node-build-'));
  try {
    const native = join(root, 'native');
    const bin = join(root, 'bin');
    mkdirSync(join(native, 'app'), { recursive: true });
    mkdirSync(join(root, 'build/.intermediates'), { recursive: true });
    copyFileSync(resolve('native/build.sh'), join(native, 'build.sh'));
    copyFileSync(resolve('native/app/Info.plist'), join(native, 'app/Info.plist'));
    writeFileSync(join(root, 'build/.intermediates/AppIcon.icns'), 'icon');
    executable(join(bin, 'swiftc'), '#!/bin/bash\nwhile [[ $# -gt 0 ]]; do if [[ $1 == -o ]]; then shift; : > "$1"; exit 0; fi; shift; done\nexit 1\n');
    executable(join(bin, 'codesign'), '#!/bin/sh\nexit 0\n');
    executable(join(bin, 'xcrun'), '#!/bin/sh\nexit 1\n');
    const selected = join(root, 'node with spaces', 'node');
    const old = join(root, 'old', 'node');
    const fallback = join(bin, 'node');
    executable(selected, '#!/bin/sh\nexit 0\n');
    executable(old, '#!/bin/sh\nexit 1\n');
    executable(fallback, '#!/bin/sh\nexit 0\n');
    const env = { HOME: root, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: root };
    const plist = join(root, 'build/Chumi.app/Contents/Info.plist');
    const build = (node?: string) => execFileSync('/bin/bash', [join(native, 'build.sh'), 'app'], {
      env: { ...env, ...(node === undefined ? {} : { CHUMI_NODE: node }) }, stdio: 'pipe', timeout: 30_000,
    });
    const recorded = () => execFileSync('/usr/bin/plutil', ['-extract', 'ChumiNodePath', 'raw', '-o', '-', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
    build(selected);
    assert.equal(recorded(), selected);
    build();
    assert.equal(recorded(), fallback);
    build(old);
    assert.throws(recorded);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the macOS shell finds version-managed Node and puts its directory on the server PATH', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-node-discovery-'));
  try {
    const node = (relative: string, version = 'v24.1.0') => {
      const path = join(root, relative);
      executable(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
      return path;
    };
    node('recorded/node');
    node('old/node', 'v22.0.0');
    node('brew/node');
    const shell = node('shell/node');
    node('nvm/.nvm/versions/node/v24.9.0/bin/node');
    node('nvm/.nvm/versions/node/v24.10.0/bin/node');
    node('nvm/.nvm/versions/node/v30.0.0/bin/node', 'v22.0.0');
    const managers = [
      ['fnm-linux', '.local/share/fnm/node-versions/v24.1.0/installation/bin/node'],
      ['fnm-mac', 'Library/Application Support/fnm/node-versions/v24.1.0/installation/bin/node'],
      ['volta', '.volta/bin/node'], ['mise', '.local/share/mise/shims/node'], ['asdf', '.asdf/shims/node'],
    ];
    for (const [home, path] of managers) node(`${home}/${path}`);
    const zdir = join(root, 'zdotdir');
    mkdirSync(zdir);
    writeFileSync(join(zdir, '.zshrc'), `print 'shell startup noise'\nexport PATH='${dirname(shell)}':/usr/bin:/bin\n`);
    const source = join(root, 'main.swift');
    const binary = join(root, 'node-test');
    writeFileSync(source, String.raw`
import Foundation
let root = CommandLine.arguments[1]
func path(_ relative: String) -> String { (root as NSString).appendingPathComponent(relative) }
func find(_ recorded: String? = nil, _ home: String = "empty", _ brew: [String] = [], _ shell: String? = nil) -> String? {
    ServerManager.findNode(recorded: recorded, home: URL(fileURLWithPath: path(home)), brewPaths: brew, shellOutput: { shell })
}
precondition(find(path("recorded/node"), "empty", [path("brew/node")], path("shell/node")) == path("recorded/node"))
precondition(find(path("old/node"), "empty", [path("brew/node")], path("shell/node")) == path("brew/node"))
precondition(find(nil, "empty", [], "startup noise\n/invalid\n  \(path("shell/node"))\n") == path("shell/node"))
precondition(find(nil, "nvm") == path("nvm/.nvm/versions/node/v24.10.0/bin/node"))
for (home, candidate) in [
    ("fnm-linux", ".local/share/fnm/node-versions/v24.1.0/installation/bin/node"),
    ("fnm-mac", "Library/Application Support/fnm/node-versions/v24.1.0/installation/bin/node"),
    ("volta", ".volta/bin/node"), ("mise", ".local/share/mise/shims/node"), ("asdf", ".asdf/shims/node")
] { precondition(find(nil, home) == path("\(home)/\(candidate)")) }
precondition(find(path("old/node")) == nil)
let interactive = ServerManager.findNode(recorded: nil, home: URL(fileURLWithPath: path("empty")), brewPaths: [])
precondition(interactive == path("shell/node"))
precondition(ServerManager.serverPath(node: path("shell/node"), inherited: "/usr/bin") == path("shell") + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin")
print("node-discovery-ok")
`);
    execFileSync('/usr/bin/swiftc', [resolve('native/app/ServerManager.swift'), source, '-module-cache-path', join(root, 'swift-cache'), '-o', binary], { timeout: 60_000, stdio: 'pipe' });
    const output = execFileSync(binary, [root], { timeout: 20_000, encoding: 'utf8', env: { HOME: root, ZDOTDIR: zdir, PATH: '/usr/bin:/bin', TMPDIR: root } });
    assert.match(output, /node-discovery-ok/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
