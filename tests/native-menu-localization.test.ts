import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('macOS language changes preserve menu identity, pet state and dynamic window entries', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'chumi-native-menu-language-'));
  try {
    const source = join(root, 'main.swift'), binary = join(root, 'menu-language-test');
    writeFileSync(source, String.raw`
import AppKit

MainActor.assumeIsolated {
    let main = NSMenu()
    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    let close = windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    let pet = windowMenu.addItem(withTitle: "Desktop Pet", action: nil, keyEquivalent: "")
    pet.state = .off
    windowItem.submenu = windowMenu
    main.addItem(windowItem)
    let localization = ShellMenuLocalization(main)
    // AppKit adds the list of open windows after the shell has built its menu.
    let liveWindow = windowMenu.addItem(withTitle: "Chumi meeting", action: nil, keyEquivalent: "")
    liveWindow.state = .on

    ShellLocalization.shared.setLanguage("zh")
    localization.retitle()
    precondition(main.item(at: 0) === windowItem && windowItem.submenu === windowMenu)
    precondition(windowMenu.title == "窗口" && windowItem.title == "窗口")
    precondition(close.title == "关闭" && close.keyEquivalent == "w" && close.action == #selector(NSWindow.performClose(_:)))
    precondition(pet.title == "桌宠" && pet.state == .off)
    precondition(windowMenu.items.count == 3 && windowMenu.item(at: 2) === liveWindow)
    precondition(liveWindow.title == "Chumi meeting" && liveWindow.state == .on)

    ShellLocalization.shared.setLanguage("en")
    localization.retitle()
    precondition(windowMenu.title == "Window" && windowItem.title == "Window")
    precondition(close.title == "Close" && pet.title == "Desktop Pet")
    precondition(windowMenu.item(at: 2) === liveWindow && pet.state == .off)
}
print("menu-language-ok")
`);
    execFileSync('/usr/bin/swiftc', [resolve('native/app/ShellLocalization.swift'), resolve('native/app/ShellMenuLocalization.swift'), source,
      '-swift-version', '5', '-module-cache-path', join(root, 'swift-cache'), '-o', binary], { timeout: 60_000, stdio: 'pipe' });
    assert.match(execFileSync(binary, { timeout: 5000, encoding: 'utf8', env: { ...process.env, HOME: root } }), /menu-language-ok/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
