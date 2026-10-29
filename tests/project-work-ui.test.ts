import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { type ActionProgress, type ProjectAgenda } from '../shared/project-work.ts';
import { AGENT_NAMES } from '../shared/agents.ts';

import { componentHarness, defer, tick } from './component-harness.ts';

const baseProgress = (): ActionProgress => ({ status: 'not_started', note: '', results: [], updatedAt: null, version: 0 });

test('progress refresh preserves the draft and requires an explicit version comparison', async () => {
  const calls: any[] = [];
  const props = { itemId: 'a', progress: baseProgress() };
  const ui = await componentHarness('ActionProgress.tsx', 'ActionProgress', props, { updateActionProgress: async (...args: any[]) => { calls.push(args); return null; } });
  ui.button('Update progress').props.onClick(); ui.render();
  ui.input('Progress note').props.onChange({ target: { value: 'My unsaved note' } }); ui.render();
  ui.render({ ...props, progress: { ...baseProgress(), version: 2, note: 'Remote note' } });
  assert.equal(ui.input('Progress note').props.value, 'My unsaved note');
  assert.equal(ui.button('Save progress').props.disabled, true);
  ui.button('Use this version and keep my edits').props.onClick(); ui.render();
  ui.button('Save progress').props.onClick(); await tick(); ui.render();
  assert.equal(calls[0][1].expectedVersion, 2);
  assert.equal(calls[0][1].note, 'My unsaved note');
  assert.equal(ui.input('Progress note').props.value, 'My unsaved note', 'a failed update keeps the editor');
});

test('saving progress disables the input fieldset and an older response cannot replace a newer version', async () => {
  const pending = defer<ActionProgress>(); const saved: ActionProgress[] = [];
  const props = { itemId: 'a', progress: baseProgress(), onSaved: (p: ActionProgress) => saved.push(p) };
  const ui = await componentHarness('ActionProgress.tsx', 'ActionProgress', props, { updateActionProgress: () => pending.promise });
  ui.button('Update progress').props.onClick(); ui.render();
  ui.input('Progress note').props.onChange({ target: { value: 'Submitted note' } }); ui.render();
  ui.button('Save progress').props.onClick(); ui.render();
  assert.equal(ui.find((e) => e.type === 'fieldset').props.disabled, true);
  ui.render({ ...props, progress: { ...baseProgress(), version: 2, note: 'Newer saved note' } });
  pending.resolve({ ...baseProgress(), version: 1, note: 'Submitted note' }); await tick(); ui.render();
  assert.equal(saved.length, 0);
  assert.equal(ui.input('Progress note').props.value, 'Submitted note');
  assert.equal(ui.button('Save progress').props.disabled, true);
});

test('progress results stop at eight and invalid URLs never submit', async () => {
  let calls = 0;
  const ui = await componentHarness('ActionProgress.tsx', 'ActionProgress', { itemId: 'a', progress: { ...baseProgress(), results: Array.from({ length: 8 }, (_, i) => ({ label: `Result ${i}`, url: 'javascript:alert(1)' })) } }, { updateActionProgress: async () => { calls++; return null; } });
  ui.button('Update progress').props.onClick(); ui.render();
  assert.equal(ui.button('Add result link').props.disabled, true);
  ui.button('Save progress').props.onClick(); await tick(); ui.render();
  assert.equal(calls, 0);
  assert.match(ui.text(), /Give each result a label/);
});

test('agenda refresh keeps unsaved text and saving uses the explicitly chosen version', async () => {
  const calls: any[] = [];
  const props = { projectId: 'p', agenda: { text: 'Old agenda', version: 0, updatedAt: null }, onSaved: () => {}, onRefresh: async () => {} };
  const ui = await componentHarness('ProjectBrief.tsx', 'AgendaEditor', props, { api: async (...args: any[]) => { calls.push(args); throw new Error('Save rejected'); } });
  ui.button('Edit agenda').props.onClick(); ui.render();
  ui.input('Discussion points').props.onChange({ target: { value: 'My draft agenda' } }); ui.render();
  ui.render({ ...props, agenda: { text: 'Remote agenda', version: 3, updatedAt: 1 } });
  assert.equal(ui.input('Discussion points').props.value, 'My draft agenda');
  assert.equal(ui.button('Save agenda').props.disabled, true);
  ui.button('Use this version and keep my edits').props.onClick(); ui.render();
  ui.button('Save agenda').props.onClick(); await tick(); ui.render();
  assert.deepEqual(calls[0][1].body, { text: 'My draft agenda', expectedVersion: 3 });
  assert.equal(ui.input('Discussion points').props.value, 'My draft agenda');
});

test('an agenda response cannot overwrite a newer saved agenda', async () => {
  const pending = defer<{ agenda: ProjectAgenda }>(); const saved: ProjectAgenda[] = [];
  const props = { projectId: 'p', agenda: { text: '', version: 0, updatedAt: null }, onSaved: (a: ProjectAgenda) => saved.push(a), onRefresh: async () => {} };
  const ui = await componentHarness('ProjectBrief.tsx', 'AgendaEditor', props, { api: () => pending.promise });
  ui.button('Edit agenda').props.onClick(); ui.render();
  ui.input('Discussion points').props.onChange({ target: { value: 'Submitted agenda' } }); ui.render();
  ui.button('Save agenda').props.onClick(); ui.render();
  assert.equal(ui.input('Discussion points').props.disabled, true);
  ui.render({ ...props, agenda: { text: 'Newest agenda', version: 2, updatedAt: 2 } });
  pending.resolve({ agenda: { text: 'Submitted agenda', version: 1, updatedAt: 1 } }); await tick(); ui.render();
  assert.equal(saved.length, 0);
  assert.equal(ui.input('Discussion points').props.value, 'Submitted agenda');
});

test('clipboard failure offers the exact prompt and never reports successful copying', async () => {
  const notices: string[] = [];
  const state = { data: { session: { id: 's', title: 'Meeting', project_id: 'p' }, handoff: { id: 'h', status: 'confirmed', items: [], project: { id: 'p', name: 'Project' }, project_mismatch: false, confirmed_at: 1, confirmed_revision: 1, freshness: { stale: false, detail: {} } } }, live: null };
  const ui = await componentHarness('Handoff.tsx', 'HandoffDialog', {}, {
    useStore: (selector: any) => selector(state), api: async () => ({ agents: [] }), AGENT_NAMES,
    loadHandoffDestination: () => 'copy', saveHandoffDestination: () => {},
    continueHandoff: async () => ({ prompt: 'Exact reviewed handoff prompt', launched: false }),
    navigator: { clipboard: { writeText: async () => { throw new Error('Denied'); } } },
    notify: (_level: string, message: string) => notices.push(message), fmtClock: String,
    Dialog: 'dialog', ProjectSelect: 'project-select', ActionProgress: 'action-progress',
    plural: (_n: number, one: string) => one,
  });
  ui.button('Copy instructions').props.onClick(); await tick(); ui.render();
  assert.equal(notices.length, 0);
  assert.equal(ui.input('Handoff instructions').props.value, 'Exact reviewed handoff prompt');
  assert.equal(ui.input('Handoff instructions').props.readOnly, true);
  assert.match(ui.text(), /Clipboard access failed/);
});

test('handoff destination defaults to Codex app, remembers valid choices, and handles unavailable storage', () => {
  const source = stripTypeScriptTypes(readFileSync(new URL('../web/src/handoffDestination.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
  let stored: string | null = null;
  const create = (storage: any) => new Function('localStorage', 'isAgent', `${source}\nreturn { loadHandoffDestination, saveHandoffDestination };`)(storage, (v: string) => Object.keys(AGENT_NAMES).includes(v));
  const pref = create({ getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } });
  assert.equal(pref.loadHandoffDestination(), 'codex-app');
  pref.saveHandoffDestination('codex'); assert.equal(pref.loadHandoffDestination(), 'codex');
  stored = 'invalid'; assert.equal(pref.loadHandoffDestination(), 'codex-app');
  const unavailable = create({ getItem: () => { throw new Error('Disabled'); }, setItem: () => { throw new Error('Disabled'); } });
  assert.equal(unavailable.loadHandoffDestination(), 'codex-app');
  assert.doesNotThrow(() => unavailable.saveHandoffDestination('copy'));
});

test('review warnings identify the meeting and open its handoff', async () => {
  const entries = [{ sessionId: 's', title: 'Seminar', reason: 'unconfirmed' }];
  const warning = await componentHarness('ProjectBrief.tsx', 'ReviewNeeded', { entries }, { plural: () => '1 handoff needs review' });
  assert.match(warning.text(), /Handoff not confirmed/);
  const source = warning.elements().find((e) => typeof e.type === 'function')!;
  assert.equal(source.props.item.sessionTitle, 'Seminar');
  const opened: string[] = [], states: unknown[] = [];
  const ui = await componentHarness('ProjectBrief.tsx', 'SourceLinks', source.props, {
    openSession: async (id: string) => { opened.push(id); }, getState: () => ({ viewId: 's' }), setState: (state: unknown) => states.push(state),
  });
  assert.match(ui.text(), /Seminar/);
  ui.button('Open source handoff').props.onClick(); await tick();
  assert.deepEqual(opened, ['s']);
  assert.deepEqual(states, [{ dialog: null }, { dialog: 'handoff' }]);
});

test('a moved handoff warning describes its arrival in the current project', async () => {
  const ui = await componentHarness('ProjectBrief.tsx', 'ReviewNeeded', { entries: [{ sessionId: 'moved', title: 'Imported meeting', reason: 'moved' }] }, { plural: () => '1 handoff needs review' });
  assert.match(ui.text(), /Moved here from another project after review/);
});

test('agent cards show each reconnect reason together with a disabled notice', async () => {
  const ui = await componentHarness('Projects.tsx', 'AgentsTab', {}, { api: async () => ({
    local: { ok: true, detail: 'Local server works' }, commands: {}, exports: {}, agents: [{
      agent: 'codex', name: 'Codex', cli: '/fixture/codex', registered: true, outdated: true, clientHealth: 'unknown',
      outdatedReasons: ['connected to another Chumi location', 'Connected to another Chumi data folder. Reconnect to use this folder.'],
      detail: 'Registered but disabled in Codex.', verifiedAt: null, lastRead: null,
    }],
  }), tn: (s: string) => s, AGENT_NAMES });
  await tick(); ui.render();
  assert.match(ui.text(), /connected to another Chumi location/);
  assert.match(ui.text(), /Connected to another Chumi data folder/);
  assert.match(ui.text(), /Registered but disabled in Codex/);
});
