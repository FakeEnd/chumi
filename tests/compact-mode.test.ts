import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactShortcutLabel, isCompactShortcut, type Keys } from '../web/src/compactMode.ts';

const key = (p: Partial<Keys>): Keys =>
  ({ code: 'Period', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, repeat: false, isComposing: false, ...p });

test('compact view toggles on ⌘⇧. or Ctrl+Shift+. only', () => {
  assert.equal(isCompactShortcut(key({ metaKey: true })), true);
  assert.equal(isCompactShortcut(key({ ctrlKey: true })), true);
  assert.equal(isCompactShortcut(key({ metaKey: true, shiftKey: false })), false, '⌘. alone is left to the system');
  assert.equal(isCompactShortcut(key({})), false, 'Shift+. types ">"');
  assert.equal(isCompactShortcut(key({ metaKey: true, altKey: true })), false);
  assert.equal(isCompactShortcut(key({ metaKey: true, code: 'Comma' })), false);
  assert.equal(isCompactShortcut(key({ metaKey: true, repeat: true })), false, 'holding the keys does not flicker');
  assert.equal(isCompactShortcut(key({ metaKey: true, isComposing: true })), false, 'not while an input method is composing');
});

test('the compact view shortcut is labelled for the platform', () => {
  assert.equal(compactShortcutLabel('darwin'), '⌘⇧.');
  assert.equal(compactShortcutLabel('win32'), 'Ctrl+Shift+.');
});
