import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Store } from '../server/db.ts';
import { componentHarness } from './component-harness.ts';
const { composing, onEnter } = new Function(stripTypeScriptTypes(readFileSync(new URL('../web/src/keys.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')) + '\nreturn { composing, onEnter };')();

test('title editing restores blank drafts, trims saves, and cancels on Escape before blur', async () => {
  const saves: unknown[] = [];
  const ui = await componentHarness('TopBar.tsx', 'SessionTitleInput', { id: 's', saved: 'Original' }, { composing, onEnter, renameSession: async (...args: unknown[]) => saves.push(args) });
  const input = () => ui.find((e) => e.type === 'input');
  for (const draft of ['', '   ', ' Original ']) {
    input().props.onChange({ target: { value: draft } }); ui.render(); input().props.onBlur(); ui.render();
    assert.equal(input().props.value, 'Original');
  }
  assert.deepEqual(saves, []);
  input().props.onChange({ target: { value: 'Cancel me' } }); ui.render();
  input().props.onKeyDown({ key: 'Escape', nativeEvent: {}, preventDefault() {}, currentTarget: { blur: () => input().props.onBlur() } }); ui.render();
  assert.equal(input().props.value, 'Original'); assert.deepEqual(saves, []);
  input().props.onChange({ target: { value: '  New title  ' } }); ui.render();
  input().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {}, target: { blur: () => input().props.onBlur() } }); ui.render();
  assert.deepEqual(saves, [['s', { title: 'New title' }]]);
});

test('session PATCH rejects blank titles and missing IDs before mutations or broadcasts', async () => {
  const main = readFileSync(new URL('../server/main.ts', import.meta.url), 'utf8');
  const src = main.slice(main.indexOf("route('PATCH', '/api/sessions/:id'"), main.indexOf("route('DELETE', '/api/sessions/:id'"));
  const store = new Store(':memory:'), events: unknown[] = [];
  store.createSession({ id: 's', title: 'Original', type: 'other', audio_source: 'mic' });
  let patch!: (body: unknown, res: unknown, params: { id: string }) => Promise<any>;
  class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
  const deps = { store, HttpError, route: (_m: string, _p: string, h: typeof patch) => { patch = h; }, readJson: async (b: unknown) => b, syncMybot: () => events.push('mybot'), broadcast: (_e: string, data: unknown) => events.push(data) };
  new Function(...Object.keys(deps), stripTypeScriptTypes(src))(...Object.values(deps));
  try {
    for (const title of ['', ' \t ', null, 123]) await assert.rejects(patch({ title }, null, { id: 's' }), (e: unknown) => e instanceof HttpError && e.status === 400);
    await assert.rejects(patch({ title: 'Valid' }, null, { id: 'missing' }), (e: unknown) => e instanceof HttpError && e.status === 404);
    assert.deepEqual(events, []); assert.equal(store.getSession('s')!.title, 'Original');
    const result = await patch({ title: '  Valid  ' }, null, { id: 's' });
    assert.equal(result.session.title, 'Valid'); assert.equal(events.length, 2);
  } finally { store.close(); }
});
