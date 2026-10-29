import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../ios/Chumi/', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('Localizable.xcstrings', root), 'utf8'));

test('iOS catalogs contain English and Simplified Chinese with matching format arguments', () => {
  for (const name of ['Localizable', 'InfoPlist']) {
    const file = JSON.parse(readFileSync(new URL(name + '.xcstrings', root), 'utf8'));
    assert.equal(file.sourceLanguage, 'en');
    for (const [key, value] of Object.entries(file.strings) as [string, any][]) {
      const en = value.localizations.en.stringUnit;
      const zh = value.localizations['zh-Hans'].stringUnit;
      assert.equal(en.state, 'translated', key);
      assert.equal(zh.state, 'translated', key);
      assert.ok(en.value && zh.value, key);
      assert.deepEqual(en.value.match(/%(?:lld|@)/g), zh.value.match(/%(?:lld|@)/g), key);
    }
  }
  const project = readFileSync(new URL('../ios/Chumi.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
  assert.match(project, /developmentRegion = en/);
  assert.match(project, /knownRegions = \(en, "zh-Hans", Base\)/);
});

test('every explicitly localized iOS interface string exists in the catalog', () => {
  const integerExpressions = new Set(['minutes', 'status', 'store.meetings.count', 'meeting.segments.count', 'meeting.outputs.count', 'index + 1', 'audioFiles.count']);
  let count = 0;
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.swift')) continue;
    const source = readFileSync(new URL(entry, root), 'utf8');
    for (const [, literal] of source.matchAll(/String\(\s*localized:\s*"((?:[^"\\]|\\.)*)"/g)) {
      const key = literal.replace(/\\\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_, expression) => integerExpressions.has(expression) ? '%lld' : '%@');
      assert.ok(catalog.strings[key], `${entry}: ${key}`);
      count++;
    }
    if (!entry.endsWith('Meeting.swift')) assert.doesNotMatch(source, /[\p{Script=Han}]/u, entry);
  }
  assert.ok(count >= 192);
});
