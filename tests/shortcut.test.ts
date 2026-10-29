import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { localize } from '../server/i18n.ts';
import { SOURCE_NAMES } from '../server/settings.ts';

const main = readFileSync(new URL('../server/main.ts', import.meta.url), 'utf8');
const source = stripTypeScriptTypes(main.slice(main.indexOf('async function onShortcut('), main.indexOf("hotkey.on('pressed'")));
for (const status of ['starting', 'ending', 'idle', 'recording', 'paused']) {
  test(`shortcut gives localized feedback during ${status}`, async () => {
    const actions: string[] = [], messages: string[] = [], notices: any[] = [];
    const deps = {
      manager: { status, source: 'mic', pause: async () => actions.push('pause'), resume: async () => actions.push('resume') },
      store: { getSettings: () => ({ ui: { language: 'zh' } }) }, hotkey: { shortcut: '⌃⌥⌘L' }, SOURCE_NAMES, localize,
      macNotify: (key: string, vars?: Record<string, string>) => messages.push(localize('zh', key, vars)),
      broadcast: (_event: string, notice: unknown) => notices.push(notice), quickStart: async () => actions.push('start'),
    };
    const press = new Function(...Object.keys(deps), source + '\nreturn onShortcut;')(...Object.values(deps));
    await press();
    assert.equal(messages.length, 1);
    assert.match(messages[0], /[\u3400-\u9fff]/);
    if (status === 'starting' || status === 'ending') {
      assert.deepEqual(actions, []);
      assert.equal(notices[0].code, 'quick_start_busy');
      assert.match(localize('zh', notices[0].message), status === 'ending' ? /保存上一场会议/ : /启动语音识别/);
    } else assert.deepEqual(actions, [status === 'idle' ? 'start' : status === 'recording' ? 'pause' : 'resume']);
  });
}

test('low-key skips status banners only while the pet is shown, keeping busy replies, errors and the notify preference', async () => {
  const notifySource = stripTypeScriptTypes(main.slice(main.indexOf('function macNotify('), main.indexOf('async function quickStart(')));
  for (const language of ['en', 'zh']) for (const lowKey of [false, true]) for (const petEnabled of [false, true]) for (const enabled of [false, true]) {
    for (const status of ['idle', 'starting', 'recording', 'paused', 'ending', 'failure']) {
      const messages: string[] = [], actions: string[] = [], notices: any[] = [];
      const fail = async () => { throw new Error('Synthetic failure'); };
      const deps = {
        store: { getSettings: () => ({ ui: { language }, pet: { lowKey, enabled: petEnabled }, quickStart: { notify: enabled } }) },
        manager: { status: status === 'failure' ? 'idle' : status, source: 'mic', pause: async () => actions.push('pause'), resume: async () => actions.push('resume') },
        hotkey: { shortcut: 'Ctrl+Alt+L' }, SOURCE_NAMES, localize, notify: (text: string) => messages.push(text),
        quickStart: status === 'failure' ? fail : async () => actions.push('start'), broadcast: (_: string, notice: any) => notices.push(notice),
      };
      const press = new Function(...Object.keys(deps), `${notifySource}\n${source}\nreturn onShortcut;`)(...Object.values(deps));
      await press();
      const important = ['starting', 'ending', 'failure'].includes(status);
      assert.equal(messages.length, enabled && (!(lowKey && petEnabled) || important) ? 1 : 0, `${language}, lowKey=${lowKey}, pet=${petEnabled}, notify=${enabled}, ${status}`);
      if (status === 'failure') {
        assert.equal(notices[0].code, 'quick_start_failed');
        if (enabled) assert.equal(messages[0], localize(language, 'Could not start. Open Chumi for details.'));
      } else if (['idle', 'recording', 'paused'].includes(status)) {
        assert.deepEqual(actions, [status === 'idle' ? 'start' : status === 'recording' ? 'pause' : 'resume']);
      } else {
        assert.deepEqual(actions, []);
        assert.equal(notices[0].code, 'quick_start_busy');
        if (enabled) assert.equal(messages[0], localize(language, notices[0].message));
      }
    }
  }
});
