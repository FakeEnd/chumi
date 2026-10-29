import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerDialogDraft } from '../web/src/dialogDraft.ts';
import { closeDialog, getState, setState } from '../web/src/store.ts';
import { dialogBrowser } from './helpers/dialog-browser.ts';
import { componentHarness } from './helpers/web-ui.ts';

const browser = globalThis as { confirm?: (message: string) => boolean };

test('closing and switching dialogs asks before discarding edits and rejects the whole navigation patch', () => {
  const previous = browser.confirm;
  let asks = 0;
  browser.confirm = () => { asks++; return false; };
  setState({ dialog: 'handoff', frameView: null });
  const unregister = registerDialogDraft(() => true);
  try {
    assert.equal(closeDialog(), false);
    assert.equal(setState({ dialog: 'frame', frameView: 9, dialogReturnTo: 'handoff' }), false);
    assert.equal(getState().dialog, 'handoff');
    assert.equal(getState().frameView, null);
    assert.equal(asks, 2);
    browser.confirm = () => true;
    assert.equal(setState({ dialog: 'frame', frameView: 9, dialogReturnTo: 'handoff' }), true);
    assert.equal(closeDialog(), true);
    assert.equal(getState().dialog, 'handoff');
  } finally { unregister(); browser.confirm = previous; setState({ dialog: null }); }
});

test('Escape, backdrop and close button all use the same guarded close', async () => {
  let closes = 0;
  const browser = dialogBrowser();
  const ui = await componentHarness('Dialog.tsx', 'Dialog', { title: 'Draft', children: null }, {
    closeDialog: () => { closes++; return false; }, composing: (e: any) => !!e.isComposing,
    ...browser.adapters,
  });
  browser.key('Escape');
  browser.key('Escape', { isComposing: true });
  const overlay = ui.find((e) => e.props.className === 'overlay');
  const target = {};
  overlay.props.onMouseDown({ target, currentTarget: target });
  overlay.props.onMouseDown({ target: {}, currentTarget: target });
  ui.find((e) => e.props['aria-label'] === 'Close').props.onClick();
  assert.equal(closes, 3);
});

test('Start keeps the whole draft across nested settings', async () => {
  let state: any = { projects: [], samples: [], helperBuilt: true, settings: { audio: { source: 'mic' }, asr: {} }, startDraft: null, startSource: 'both' };
  const adapters = {
    getState: () => state, setState: (patch: any) => { state = { ...state, ...patch }; }, useStore: (select: any) => select(state),
    DEFAULT_SESSION_TYPES: [{ id: 'lab_meeting' }], Dialog: 'dialog', SessionTypeSelect: 'session-types', ProjectSelect: 'project-select', WindowPicker: 'window-picker',
    onEnter: () => () => {}, speechPrivacy: () => '', tn: (s: string) => s,
  };
  const ui = await componentHarness('StartDialog.tsx', 'StartDialog', {}, adapters);
  assert.equal(ui.elements().filter((e) => e.type === 'input' && e.props.type === 'radio')[2].props.checked, true);
  assert.equal(state.startSource, null);
  assert.equal(state.settings.audio.source, 'mic');
  ui.input('Title').props.onChange({ target: { value: 'My meeting' } }); ui.render();
  ui.elements().filter((e) => e.type === 'input' && e.props.type === 'radio')[1].props.onChange(); ui.render();
  ui.input('Record audio').props.onChange({ target: { checked: true } }); ui.render();
  state.projects = [{ id: 'new-project' }, { id: 'brief-project' }];
  state.startDraft = { ...state.startDraft, projectId: 'new-project' };
  const returned = await componentHarness('StartDialog.tsx', 'StartDialog', {}, adapters);
  assert.equal(returned.input('Title').props.value, 'My meeting');
  assert.equal(returned.elements().filter((e) => e.type === 'input' && e.props.type === 'radio')[1].props.checked, true);
  assert.equal(returned.input('Record audio').props.checked, true);
  assert.equal(returned.find((e) => e.type === 'project-select').props.value, 'new-project');
  state.startProjectId = 'brief-project';
  const fromBrief = await componentHarness('StartDialog.tsx', 'StartDialog', {}, adapters);
  assert.equal(fromBrief.find((e) => e.type === 'project-select').props.value, 'brief-project');
  assert.equal(fromBrief.input('Title').props.value, 'My meeting');
});


test('dialog focus wraps through controls and notices, excludes the page, and restores the opener', async () => {
  const browser = dialogBrowser();
  const ui = await componentHarness('Dialog.tsx', 'Dialog', { title: 'Focus', children: null }, { ...browser.adapters, composing: () => false, closeDialog: () => {} });
  assert.equal(browser.active(), 'first');
  assert.equal(browser.key('Tab'), false); assert.equal(browser.active(), 'summary');
  assert.equal(browser.key('Tab'), false); assert.equal(browser.active(), 'last');
  assert.equal(browser.key('Tab'), true); assert.equal(browser.active(), 'notice');
  assert.equal(browser.key('Tab'), true); assert.equal(browser.active(), 'first');
  assert.equal(browser.key('Tab', { shiftKey: true }), true); assert.equal(browser.active(), 'notice');
  browser.focusOutside(); assert.equal(browser.active(), 'first');
  ui.unmount(); assert.equal(browser.active(), 'opener');
});


test('Start cancellation clears setup choices while nested settings retains them', () => {
  const draft = { title: 'Cancelled title', type: 'lab_meeting', source: 'system', file: '', speed: 1, capture: true, win: { id: 1, title: 'Window', app: 'App', bundleId: 'app', pid: 1, width: 800, height: 600, onScreen: true }, projectId: 'p', record: true };
  setState({ dialog: 'start', startDraft: draft });
  setState({ dialog: 'settings', dialogReturnTo: 'start', settingsTab: 'projects' });
  assert.equal(getState().startDraft, draft);
  closeDialog();
  assert.equal(getState().dialog, 'start');
  assert.equal(getState().startDraft, draft);
  closeDialog();
  assert.equal(getState().startDraft, null);
  assert.equal(getState().startSource, null);
  assert.equal(getState().startProjectId, null);
  setState({ dialog: 'start', startDraft: draft });
  setState({ dialog: 'settings', dialogReturnTo: 'start' });
  setState({ dialog: 'history' });
  assert.equal(getState().startDraft, null, 'abandoning the return route also discards Start setup');
  closeDialog();
});

test('editing session types from Start returns to the preserved setup form', async () => {
  setState({ dialog: 'start' });
  const ui = await componentHarness('SessionTypes.tsx', 'SessionTypeSelect', { value: 'lab_meeting', manage: true, onChange: () => {} }, {
    getState, setState, useStore: (select: any) => select(getState()), DEFAULT_SESSION_TYPES: [{ id: 'lab_meeting' }], availableSessionTypes: (options: any) => options, typeLabel: String,
  });
  ui.find((e) => e.type === 'select').props.onChange({ target: { value: '__manage' } });
  assert.equal(getState().dialog, 'settings');
  assert.equal(getState().settingsTab, 'session-types');
  assert.equal(getState().dialogReturnTo, 'start');
  closeDialog();
  assert.equal(getState().dialog, 'start');
  closeDialog();
});
