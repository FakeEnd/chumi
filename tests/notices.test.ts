import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

test('notices deduplicate by code, key and variables regardless of variable order', () => {
  const source = stripTypeScriptTypes(readFileSync(new URL('../web/src/store.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
  const { notify, getState } = new Function('loadCompact', source + '\nreturn { notify, getState };')(() => false);
  const key = 'Quick start failed: {error}';
  notify('error', key, 'quick_start_failed', { error: 'first', source: 'mic' });
  notify('error', key, 'quick_start_failed', { error: 'second', source: 'mic' });
  assert.equal(getState().notices.length, 2);
  const first = getState().notices[0].id;
  notify('error', key, 'quick_start_failed', { source: 'mic', error: 'first' });
  assert.equal(getState().notices.length, 2);
  assert.ok(getState().notices.every((notice: { id: number }) => notice.id !== first));
});
