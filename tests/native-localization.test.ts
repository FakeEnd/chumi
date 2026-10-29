import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const native = (name: string) => readFileSync(new URL(`../native/app/${name}`, import.meta.url), 'utf8');

test('every macOS shell translation has Chinese text and the same placeholders', () => {
  const dictionary = new Map<string, string>();
  for (const match of native('ShellLocalization.swift').matchAll(/^\s*("(?:\\.|[^"\\])*"):\s*("(?:\\.|[^"\\])*")/gm)) {
    dictionary.set(JSON.parse(match[1]), JSON.parse(match[2]));
  }
  const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
  let used = 0;
  for (const file of ['AppDelegate.swift', 'ServerManager.swift', 'WebController.swift']) {
    const literal = /(?:\bL\(|\b(?:title|withTitle):\s*)("(?:\\.|[^"\\])*")/g;
    for (const match of native(file).matchAll(literal)) {
      const english = JSON.parse(match[1]);
      if (english === 'Chumi') continue;
      const chinese = dictionary.get(english);
      assert.ok(chinese, `${file}: missing ${english}`);
      assert.match(chinese, /[\u3400-\u9fff]/);
      assert.deepEqual(placeholders(chinese), placeholders(english), english);
      used++;
    }
  }
  assert.ok(used > 60);
});

test('the native language bridge follows resolved web settings and later language changes', () => {
  const script = native('WebController.swift').match(/static let languageScript = """\n([\s\S]*?)\n    """/)![1];
  const root = { lang: 'en' };
  const messages: Array<{ type: string; language: string }> = [];
  let changed!: () => void;
  vm.runInNewContext(script, {
    document: { documentElement: root },
    window: { webkit: { messageHandlers: { chumiShell: { postMessage: (message: typeof messages[number]) => messages.push(message) } } } },
    MutationObserver: class {
      constructor(callback: () => void) { changed = callback; }
      observe(element: unknown, options: { attributeFilter: string[] }) {
        assert.equal(element, root);
        assert.deepEqual([...options.attributeFilter], ['lang']);
      }
    },
  });
  assert.equal(messages.length, 0, 'wait for i18n.ts to resolve settings instead of reporting the initial HTML language');
  root.lang = 'zh-CN'; changed();
  changed(); changed();
  root.lang = 'en'; changed();
  changed(); changed();
  root.lang = 'unexpected'; changed();
  root.lang = 'en'; changed();
  root.lang = 'zh-CN'; changed();
  assert.deepEqual(messages.map((m) => [m.type, m.language]), [['language', 'zh-CN'], ['language', 'en'], ['language', 'zh-CN']]);
});

test('macOS shell uses system fallback, honors language switches and localizes recovery messages', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-native-localization-'));
  try {
    const source = join(root, 'main.swift'), binary = join(root, 'localization-test');
    writeFileSync(source, String.raw`
import Foundation
precondition(ShellLocalization.resolve(system: "zh-Hans-CN") == "zh")
precondition(ShellLocalization.resolve(system: "ZH_TW") == "zh")
precondition(ShellLocalization.resolve(system: "en-US") == "en")
precondition(ShellLocalization.resolve(system: "fr-FR") == "en")
precondition(ShellLocalization.resolve(preference: "en", system: "zh-Hans") == "en")
precondition(ShellLocalization.resolve(preference: "zh", system: "en-US") == "zh")
precondition(ShellLocalization.resolve(preference: "auto", system: "zh-Hans") == "zh")
let strings = ShellLocalization(system: "zh-Hans")
precondition(strings.text("OK") == "确定")
precondition(strings.text("Cancel") == "取消")
precondition(strings.text("Keep Chumi Open") == "保持 Chumi 打开")
precondition(strings.setLanguage("en"))
precondition(!strings.setLanguage("en"))
precondition(strings.text("Cancel") == "Cancel")
strings.setLanguage("zh-CN")
precondition(strings.text("Last lines of {path}:\n\n{tail}", ["path": "/tmp/{tail}/研究", "tail": "Details"]) == "/tmp/{tail}/研究 的最新日志：\n\nDetails")
ShellLocalization.shared.setLanguage("zh")
let dependency = ServerManager.startupFailure(tail: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@anthropic-ai/sdk'", repo: "/tmp/研究", reason: "unused")
precondition(dependency.contains("依赖缺失") && dependency.contains("npm install") && dependency.contains("/tmp/研究"))
precondition(ServerManager.startupFailure(tail: "EADDRINUSE", repo: "/tmp", reason: "unused").contains("端口已被占用"))
precondition(WebController.escapeHTML("<error> & details") == "&lt;error&gt; &amp; details")
print("shell-localization-ok")
`);
    execFileSync('/usr/bin/swiftc', [resolve('native/app/ShellLocalization.swift'), resolve('native/app/ServerManager.swift'), resolve('native/app/WebController.swift'), resolve('native/app/WindowChrome.swift'), source,
      '-swift-version', '5', '-module-cache-path', join(root, 'swift-cache'), '-o', binary], { timeout: 60_000, stdio: 'pipe' });
    assert.match(execFileSync(binary, { timeout: 5000, encoding: 'utf8' }), /shell-localization-ok/);
    const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', resolve('native/app/Info.plist')], { encoding: 'utf8' }));
    assert.deepEqual(plist.CFBundleLocalizations, ['en', 'zh-Hans']);
    assert.equal(plist.CFBundleAllowMixedLocalizations, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
