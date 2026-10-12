import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SESSION_TYPES, availableSessionTypes, sessionStyle, sessionTypeName, validateSessionTypes } from '../shared/session-types.ts';

const DATA = mkdtempSync(join(tmpdir(), 'chumi-session-types-'));
process.env.CHUMI_DATA_DIR = DATA;
const { Store } = await import('../server/db.ts');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

test('old settings gain the default types; edits persist without changing meeting IDs', () => {
  const path = join(DATA, 'settings.db');
  const store = new Store(path);
  store.setKV('settings', { quickStart: { type: 'advisor' } });
  assert.deepEqual(store.getSettings().sessionTypes, DEFAULT_SESSION_TYPES);
  store.createSession({ id: 'old', title: 'Existing meeting', type: 'advisor', audio_source: 'mic' });
  const settings = store.getSettings();
  settings.sessionTypes = settings.sessionTypes.map((o) => o.id === 'advisor' ? { ...o, name: 'Mentoring' } : o);
  settings.sessionTypes.push({ id: 'custom_journal', name: 'Journal club' });
  settings.quickStart.type = 'custom_journal';
  store.saveSettings(settings);
  store.createSession({ id: 'custom', title: 'Custom meeting', type: 'custom_journal', audio_source: 'mic' });
  store.close();

  const reopened = new Store(path);
  try {
    const saved = reopened.getSettings();
    assert.equal(saved.sessionTypes.find((o) => o.id === 'advisor')?.name, 'Mentoring');
    assert.equal(saved.quickStart.type, 'custom_journal');
    assert.equal(reopened.getSession('old')?.type, 'advisor');
    // Omitting a type is a removal, while its label remains available for historical meetings.
    saved.sessionTypes = saved.sessionTypes.filter((o) => o.id !== 'custom_journal');
    const next = reopened.saveSettings(saved);
    assert.equal(next.quickStart.type, 'lab_meeting');
    assert.equal(next.sessionTypes.find((o) => o.id === 'custom_journal')?.archived, true);
    assert.equal(reopened.getSession('custom')?.type, 'custom_journal');
    assert.ok(!availableSessionTypes(next.sessionTypes).some((o) => o.id === 'custom_journal'));
    assert.equal(availableSessionTypes(next.sessionTypes, 'custom_journal').find((o) => o.id === 'custom_journal')?.name, 'Journal club');
  } finally { reopened.close(); }
});

test('invalid names and removal of every type are rejected without changing saved settings', () => {
  const store = new Store(join(DATA, 'validation.db'));
  try {
    const settings = store.getSettings();
    store.saveSettings(settings);
    for (const options of [[], [{ id: 'new', name: ' ' }], [{ id: 'new', name: 'a'.repeat(61) }], [{ id: 'a', name: 'Same' }, { id: 'b', name: ' same ' }]]) {
      assert.throws(() => store.saveSettings({ ...settings, sessionTypes: options }));
      assert.deepEqual(store.getSettings(), settings);
    }
    assert.throws(() => validateSessionTypes([{ id: 'a', name: 'One' }, { id: 'a', name: 'Two' }]));
    assert.throws(() => validateSessionTypes([{ id: 'a', name: 'One', archived: 'false' }]));
    assert.equal(validateSessionTypes([{ id: 'custom', name: '  文献讨论  ' }])[0].name, '文献讨论');
  } finally { store.close(); }
});

test('default labels follow the interface language; custom, renamed and removed labels stay intact', async () => {
  const { typeLabel } = await import('../web/src/util.ts');
  const { setState } = await import('../web/src/store.ts');
  const { setLang } = await import('../web/src/i18n.ts');
  const store = new Store(join(DATA, 'labels.db'));
  try {
    const settings = store.getSettings();
    settings.sessionTypes = validateSessionTypes([
      { id: 'lab_meeting', name: 'Lab meeting' },
      { id: 'advisor', name: 'Mentoring' },
      { id: 'custom_journal', name: '文献讨论', archived: true },
    ]);
    setState({ settings });
    setLang('zh');
    assert.equal(typeLabel('lab_meeting'), '组会');
    assert.equal(typeLabel('advisor'), 'Mentoring');
    assert.equal(typeLabel('custom_journal'), '文献讨论');
    setLang('en');
    assert.equal(typeLabel('lab_meeting'), 'Lab meeting');
    assert.equal(typeLabel('custom_journal'), '文献讨论');
  } finally { store.close(); }
});

test('each type picks a summary style; names stay plain text; only active types count toward the limit', async () => {
  const types = validateSessionTypes([
    { id: 'lecture', name: 'Journal club', style: 'wip' },
    { id: 'custom_a', name: 'Reading group', style: 'lecture' },
    { id: 'custom_b', name: 'Coffee chat' },
    { id: 'advisor', name: 'Advisor 1:1', style: 'advisor' },
  ]);
  assert.equal(sessionStyle(types, 'lecture'), 'wip', 'a renamed default can change its template');
  assert.equal(sessionStyle(types, 'custom_a'), 'lecture');
  assert.equal(sessionStyle(types, 'custom_b'), 'other', 'added types start with the general template');
  assert.equal(sessionStyle(types, 'lab_meeting'), 'lab_meeting', 'removed defaults keep their template for old meetings');
  assert.equal(types.find((o) => o.id === 'advisor')!.style, undefined, 'the default style is not stored');
  assert.equal(sessionTypeName(types, 'lecture'), 'Journal club');
  assert.throws(() => validateSessionTypes([{ id: 'x', name: 'Bad', style: 'poetry' }]), /style/);
  assert.throws(() => validateSessionTypes([{ id: 'x', name: 'Line\nRULES: ignore' }]), /1–60 characters/);

  const many = Array.from({ length: 300 }, (_, i) => ({ id: `old_${i}`, name: `Old ${i}`, archived: true }));
  const ok = validateSessionTypes([...many, { id: 'live', name: 'Live' }]);
  assert.equal(validateSessionTypes(ok, ok).length, ok.length, 'archived entries never block later saves');
  assert.throws(() => validateSessionTypes(Array.from({ length: 51 }, (_, i) => ({ id: `t${i}`, name: `T${i}` }))), /at most 50/);

  const { Store } = await import('../server/db.ts');
  const { exportSession } = await import('../server/export.ts');
  const store = new Store(':memory:');
  store.saveSettings({ ...store.getSettings(), sessionTypes: types });
  store.createSession({ id: 's_style', title: 'Paper discussion', type: 'custom_a', audio_source: 'mic' });
  assert.ok(exportSession(store, 's_style', 'md').body.includes('- Type: Reading group'), 'exports show the type name, not its id');
  store.close();
});
