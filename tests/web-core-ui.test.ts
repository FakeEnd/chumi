import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentHarness, defer, tick } from './helpers/web-ui.ts';
import { providerSetupCommand } from '../web/src/providerSetup.ts';
import { AGENT_NAMES } from '../shared/agents.ts';

const handoffState = () => ({ data: { session: { id: 's', title: 'Meeting', project_id: 'p' }, handoff: { id: 'h', status: 'confirmed', items: [], project: { id: 'p', name: 'Project' }, project_mismatch: false, freshness: { stale: false, detail: {} } } }, live: null });
const handoffAdapters = { AGENT_NAMES, api: async () => ({ agents: [] }), loadHandoffDestination: () => 'codex', saveHandoffDestination: () => {}, fmtClock: String, Dialog: 'dialog', ProjectSelect: 'project-select', ActionProgress: 'action-progress', plural: (_n: number, one: string) => one };

test('a failed Continue displays the launch error in the handoff and permits retry', async () => {
  let attempts = 0;
  const state = handoffState();
  const ui = await componentHarness('Handoff.tsx', 'HandoffDialog', {}, {
    ...handoffAdapters, useStore: (select: any) => select(state),
    continueHandoff: async () => { attempts++; throw new Error('The project folder is not available.'); },
  });
  ui.button('Continue').props.onClick(); await tick(); ui.render();
  assert.match(ui.find((e) => e.props.role === 'alert').children.join(''), /project folder is not available/);
  assert.equal(ui.button('Continue').props.disabled, false);
  ui.button('Continue').props.onClick(); await tick();
  assert.equal(attempts, 2);
});


test('failed item saves keep edits open and successful saves close them', async () => {
  let saved: any;
  const item = { id: 'i', text: 'Original', kind: 'action', origin: 'user', conditions: [], acceptance: [], review: 'pending', evidence: [] };
  const ui = await componentHarness('Handoff.tsx', 'ItemRow', { item, locked: false, trackProgress: false }, {
    ...handoffAdapters, updateHandoffItem: async () => saved,
  });
  ui.button('Edit').props.onClick(); ui.render();
  ui.find((e) => e.props['aria-label'] === 'Description').props.onChange({ target: { value: 'Edited task' } }); ui.render();
  ui.button('Save').props.onClick(); await tick(); ui.render();
  assert.equal(ui.find((e) => e.props['aria-label'] === 'Description').props.value, 'Edited task');
  saved = { handoff: {} };
  ui.button('Save').props.onClick(); await tick(); ui.render();
  assert.ok(ui.button('Edit'));
});

test('adding an item waits for success and preserves failed text for retry', async () => {
  let pending = defer<any>(); let calls = 0;
  const ui = await componentHarness('Handoff.tsx', 'AddItem', { handoff: { id: 'h' }, kind: 'action' }, {
    ...handoffAdapters, onEnter: (fn: any) => fn, addHandoffItem: () => { calls++; return pending.promise; },
  });
  ui.button('+ Add your own').props.onClick(); ui.render();
  ui.find((e) => e.type === 'input').props.onChange({ target: { value: 'Keep my sentence' } }); ui.render();
  ui.button('Add').props.onClick(); ui.render();
  assert.equal(ui.button('Add').props.disabled, true);
  ui.button('Add').props.onClick();
  assert.equal(calls, 1);
  pending.resolve(undefined); await tick(); ui.render();
  assert.equal(ui.find((e) => e.type === 'input').props.value, 'Keep my sentence');
  assert.equal(ui.button('Add').props.disabled, false);
  pending = defer<any>();
  ui.button('Add').props.onClick();
  pending.resolve({ handoff: {} }); await tick(); ui.render();
  assert.ok(ui.button('+ Add your own'));
});


test('resume uses saved desktop sources, hides mobile sessions, and stays open after failure', async () => {
  for (const source of ['mic', 'system', 'both', 'file', 'mobile']) {
    const calls: any[] = []; let closes = 0, accepted: any;
    const ui = await componentHarness('ResumeRecording.tsx', 'ResumeRecording', { session: { id: 's', status: 'interrupted', audio_source: source }, onResumed: () => { closes++; } }, {
      useStore: (select: any) => select({ live: { status: 'idle' }, settings: { audio: { source: 'both' } } }),
      sourceLabel: String, resumeSaved: async (...args: any[]) => { calls.push(args); return accepted; },
    });
    if (source === 'mobile') { assert.equal(ui.elements().length, 0); continue; }
    ui.button('Resume recording').props.onClick(); await tick(); ui.render();
    assert.deepEqual(calls[0], ['s', source === 'file' ? 'both' : source]);
    assert.equal(closes, 0);
    accepted = { session: {} };
    ui.button('Resume recording').props.onClick(); await tick(); ui.render();
    assert.equal(closes, 1);
  }
});


test('checklist signs Codex in on Mac and Windows and installs missing CLIs before login', async () => {
  for (const platform of ['darwin', 'win32']) {
    for (const id of ['codex', 'claude-cli']) {
      for (const status of ['signed_out', 'not_installed']) {
        const calls: string[] = [], notices: string[] = [];
        const state = { platform, settings: { ai: { provider: id }, ui: {}, asr: { engine: 'whisper' } }, provider: { id, state: status, setupHint: 'Install Claude Code, then run: claude auth login' } };
        const ui = await componentHarness('SetupChecklist.tsx', 'SetupChecklist', {}, {
          useStore: (select: any) => select(state), providerSetupCommand, providerShort: String,
          api: async (path: string) => { calls.push(path); if (path.includes('/login')) throw new Error('Sign-in unavailable'); return { microphone: 'granted' }; },
          window: { addEventListener: () => {}, removeEventListener: () => {} }, notify: (_level: string, message: string) => notices.push(message),
        });
        if (status === 'not_installed' && platform === 'win32') {
          assert.equal(ui.elements().some((e) => e.type === 'code'), false, 'Windows installation must not require npm');
        } else if (status === 'not_installed') {
          const command = ui.find((e) => e.type === 'code').children.join('');
          assert.match(command, /^(brew|npm) install/);
          assert.doesNotMatch(command, /auth login|codex login/);
        } else if (id === 'codex') {
          ui.button('Sign in with ChatGPT').props.onClick(); await tick();
          assert.ok(calls.includes('/api/provider/codex/login'));
          assert.deepEqual(notices, ['Sign-in unavailable']);
        } else assert.equal(ui.find((e) => e.type === 'code').children.join(''), 'claude auth login');
      }
    }
  }
});


const homeState = () => ({ projects: [], settings: { audio: { source: 'mic' }, quickStart: { source: 'default' }, asr: { engine: 'whisper' } }, provider: { label: 'Codex', state: 'signed_out' }, live: { status: 'idle', asr: { state: 'missing_model' } } });
const homeAdapters = {
  ...Object.fromEntries(['IconArrow', 'IconBolt', 'IconBoth', 'IconMic', 'IconMonitor', 'IconShield', 'IconSpark', 'IconText', 'IconWindow', 'SetupChecklist'].map((name) => [name, name])),
  sourceLabel: String, getLang: () => 'en', providerShort: String, billingWord: String, tn: (s: string) => s, speechPrivacy: () => '',
};

test('Home status pills are native buttons that open the relevant settings tab', async () => {
  const state = homeState(), patches: any[] = [];
  const ui = await componentHarness('Home.tsx', 'Home', {}, { ...homeAdapters, api: async () => ({ sessions: [] }), useStore: (select: any) => select(state), setState: (p: any) => patches.push(p) });
  const pills = ui.elements().filter((e) => e.type === 'button' && e.props.className?.startsWith('pill '));
  assert.equal(pills.length, 2);
  pills[0].props.onClick(); pills[1].props.onClick();
  assert.deepEqual(patches, [{ dialog: 'settings', settingsTab: 'asr' }, { dialog: 'settings', settingsTab: 'ai' }]);
});


test('Home start cards pass a source to the dialog without saving a new default', async () => {
  const state = homeState(), patches: any[] = [];
  const ui = await componentHarness('Home.tsx', 'Home', {}, { ...homeAdapters, api: async () => ({ sessions: [] }), useStore: (select: any) => select(state), setState: (p: any) => patches.push(p), saveSettings: () => assert.fail('Opening setup must not save settings') });
  const cards = ui.elements().filter((e) => e.type === 'button' && e.props.className === 'start-card');
  cards.forEach((card) => card.props.onClick());
  assert.deepEqual(patches, ['mic', 'system', 'both'].map((startSource) => ({ startSource, dialog: 'start' })));
  assert.equal(state.settings.audio.source, 'mic');
});


const historyAdapters = { Dialog: 'dialog', SessionTitle: 'session-title', SessionMeta: 'session-meta', ResumeRecording: 'resume', exportUrl: () => '', setTimeout: (fn: any) => { fn(); return 1; }, clearTimeout: () => {} };

test('History deletion names screen captures and includes the recording when present', async () => {
  for (const has_audio of [false, true]) {
    let message = '';
    const ui = await componentHarness('HistoryDialog.tsx', 'HistoryDialog', {}, {
      ...historyAdapters, useStore: (select: any) => select({ projects: [] }), api: async () => ({ sessions: [{ id: 's', title: 'Meeting', has_audio }] }),
      confirm: (text: string) => { message = text; return false; }, deleteSession: () => assert.fail('Cancelled deletion must not run'),
    });
    await tick(); ui.render(); ui.button('Delete').props.onClick();
    assert.match(message, /permanently/);
    assert.match(message, /screen captures/);
    assert.equal(message.includes('audio recording'), has_audio);
    assert.equal(ui.find((e) => e.props.className === 'h-main').type, 'button');
  }
});


for (const file of ['Home.tsx', 'HistoryDialog.tsx']) {
  test(`${file} distinguishes loading, failure and an empty list, and retries`, async () => {
    let pending = defer<any>();
    const state = homeState();
    const ui = await componentHarness(file, file === 'Home.tsx' ? 'Home' : 'HistoryDialog', {}, {
      ...homeAdapters, ...historyAdapters, useStore: (select: any) => select(state), api: () => pending.promise,
    });
    assert.match(ui.text(), /Loading…/);
    assert.doesNotMatch(ui.text(), /No (saved )?sessions yet/);
    pending.reject(new Error('Offline')); await tick(); ui.render();
    assert.match(ui.text(), /Could not load/);
    assert.doesNotMatch(ui.text(), /No (saved )?sessions yet|Loading…/);
    pending = defer<any>();
    ui.button('Retry').props.onClick(); ui.render();
    assert.match(ui.text(), /Loading…/);
    pending.resolve({ sessions: [] }); await tick(); ui.render();
    assert.match(ui.text(), /No (saved )?sessions yet/);
    assert.doesNotMatch(ui.text(), /Could not load/);
    ui.unmount();
  });

  test(`${file} ignores responses from an older list request`, async () => {
    const older = defer<any>(), newer = defer<any>(); let request = 0;
    const state = { ...homeState(), sessionsRev: 0 };
    const ui = await componentHarness(file, file === 'Home.tsx' ? 'Home' : 'HistoryDialog', {}, {
      ...homeAdapters, ...historyAdapters, useStore: (select: any) => select(state), api: () => request++ === 0 ? older.promise : newer.promise,
    });
    state.sessionsRev++; ui.render();
    newer.resolve({ sessions: [{ id: 'new', title: 'New result' }] }); await tick(); ui.render();
    older.resolve({ sessions: [] }); await tick(); ui.render();
    assert.equal(ui.find((e) => e.type === 'session-title').props.s.id, 'new');
    assert.doesNotMatch(ui.text(), /No (saved )?sessions yet/);
    ui.unmount();
  });
}


test('reopening a handoff edit starts from the normalized saved item', async () => {
  let dirty = false;
  const item = { id: 'i', text: 'Original', kind: 'action', origin: 'user', conditions: [], acceptance: [], review: 'pending', evidence: [] };
  const ui = await componentHarness('Handoff.tsx', 'ItemRow', { item, locked: false, trackProgress: false }, {
    ...handoffAdapters, useDialogDraft: (value: boolean) => { dirty = value; }, updateHandoffItem: async () => ({ handoff: {} }),
  });
  ui.button('Edit').props.onClick(); ui.render();
  ui.find((e) => e.props['aria-label'] === 'Description').props.onChange({ target: { value: 'Run tests ' } }); ui.render();
  ui.input('Unresolved conditions').props.onChange({ target: { value: 'Ready\n\n' } }); ui.render();
  assert.equal(dirty, true);
  ui.button('Save').props.onClick(); await tick();
  ui.render({ item: { ...item, text: 'Run tests', conditions: ['Ready'] }, locked: false, trackProgress: false });
  ui.button('Edit').props.onClick(); ui.render();
  assert.equal(ui.find((e) => e.props['aria-label'] === 'Description').props.value, 'Run tests');
  assert.equal(ui.input('Unresolved conditions').props.value, 'Ready');
  assert.equal(dirty, false);
});

test('API-key authentication errors retain the logout and plan-login commands', () => {
  for (const command of ['codex', 'claude auth']) {
    const status = { id: command === 'codex' ? 'codex' : 'claude-cli', state: 'error', setupHint: `Run "${command} logout" then "${command} login" with your subscription.` } as Parameters<typeof providerSetupCommand>[0];
    assert.equal(providerSetupCommand(status, 'darwin'), `${command} logout\n${command} login`);
  }
});

for (const file of ['Home.tsx', 'HistoryDialog.tsx']) {
  test(`${file} keeps existing rows during refresh, errors, retries and search`, async () => {
    let pending = defer<any>();
    const state = { ...homeState(), sessionsRev: 0 };
    const ui = await componentHarness(file, file === 'Home.tsx' ? 'Home' : 'HistoryDialog', {}, {
      ...homeAdapters, ...historyAdapters, useStore: (select: any) => select(state), api: () => pending.promise,
    });
    pending.resolve({ sessions: [{ id: 'saved', title: 'Saved meeting' }] }); await tick(); ui.render();
    pending = defer<any>(); state.sessionsRev++; ui.render();
    const assertRetained = () => {
      assert.equal(ui.find((e) => e.type === 'session-title').props.s.id, 'saved');
      assert.doesNotMatch(ui.text(), /Loading…/);
    };
    assertRetained();
    pending.reject(new Error('Offline')); await tick(); ui.render(); assertRetained();
    assert.match(ui.text(), /Could not load/);
    pending = defer<any>(); ui.button('Retry').props.onClick(); ui.render(); assertRetained();
    if (file === 'HistoryDialog.tsx') {
      ui.find((e) => e.props['aria-label'] === 'Search sessions').props.onChange({ target: { value: 'query' } }); ui.render(); assertRetained();
    }
    pending.resolve({ sessions: [{ id: 'updated', title: 'Updated meeting' }] }); await tick(); ui.render();
    assert.equal(ui.find((e) => e.type === 'session-title').props.s.id, 'updated');
    ui.unmount();
  });
}
