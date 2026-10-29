import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { serverStrings } from './server-strings.ts';
import { ZH } from '../web/src/i18n-zh.ts';
import { NATIVE_ZH } from '../shared/native-messages.ts';
import { matchServerMessage, translateMessage, SERVER_MESSAGE_TEMPLATES, SERVER_SETUP_HINTS } from '../shared/messages.ts';

const SRC = join(import.meta.dirname, '..', 'web', 'src');

/** Every literal string passed to t(), tn(), tr(), msg() or plural() in the web UI. */
export function uiStrings(): Set<string> {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { if (f.isDirectory()) walk(join(d, f.name)); else if (/\.tsx?$/.test(f.name) && !f.name.startsWith('i18n')) files.push(join(d, f.name)); } };
  walk(SRC);
  const lit = String.raw`(['"])((?:\\.|(?!\1).)*?)\1`;
  const call = new RegExp(String.raw`(?<![\w.])(?:t|tn|tr|msg)\(\s*${lit}`, 'g');
  const pl = new RegExp(String.raw`(?<![\w.])plural\([^,]+,\s*${lit}\s*,\s*${lit.replace('\\1', '\\3').replace('\\1', '\\3')}`, 'g');
  const unesc = (s: string) => s.replace(/\\(['"\\])/g, '$1');
  const out = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(call)) out.add(unesc(m[2]));
    for (const m of src.matchAll(pl)) { out.add(unesc(m[2])); out.add(unesc(m[4])); }
  }
  return out;
}

test('every interface string has a Chinese translation with the same placeholders', async () => {
  const { ZH } = await import('../web/src/i18n-zh.ts');
  const keys = uiStrings();
  assert.ok(keys.size > 300, `found only ${keys.size} strings; the extractor may be broken`);
  const missing = [...keys].filter((k) => !(k in ZH));
  assert.deepEqual(missing, [], `missing Chinese translations:\n${missing.join('\n')}`);
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const wrong = [...keys].filter((k) => ph(k) !== ph(ZH[k]));
  assert.deepEqual(wrong, [], `placeholders differ:\n${wrong.map((k) => `${k} → ${ZH[k]}`).join('\n')}`);
});

test('translation lookup and placeholders', async () => {
  const { t, setLang, resolveLang } = await import('../web/src/i18n.ts');
  setLang('en');
  assert.equal(t('{n}% used', { n: 40 }), '40% used');
  setLang('zh');
  assert.equal(t('{n}% used', { n: 40 }), '已用 40%');
  assert.equal(t('An unknown server message'), 'An unknown server message');
  setLang('en');
  assert.equal(resolveLang('zh', 'en'), 'zh');
  assert.equal(resolveLang('auto', 'zh'), 'zh');
  assert.equal(resolveLang('auto', 'en'), 'en');
});


test('provider errors stay translated when the assistant appends its recording reassurance', async () => {
  const { t, setLang } = await import('../web/src/i18n.ts');
  const message = 'The model API has no available credit or quota. Check its billing console before retrying.';
  const suffix = ' Transcription continues and nothing captured is lost.';
  try {
    setLang('zh');
    assert.equal(t(message + suffix), t(message) + ' 转写仍在继续，已采集的内容不会丢失。');
    setLang('en');
    assert.equal(t(message + suffix), message + suffix);
  } finally { setLang('en'); }
});

test('native silence messages translate including microphone device and duration variables', async () => {
  const { ZH } = await import('../web/src/i18n-zh.ts');
  const { t, setLang } = await import('../web/src/i18n.ts');
  const mic = readFileSync(join(SRC, '../../native/audio/MicCapture.swift'), 'utf8');
  const system = readFileSync(join(SRC, '../../native/audio/SystemCapture.swift'), 'utf8');
  const messages = [...mic.matchAll(/"((?:[^"\n\\]|\\.)*digital silence(?:[^"\n\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"'));
  const systemMessage = system.match(/"(No system audio signal[^\n]+)"/)![1].replace(/\\\(Int\(SystemCapture.silenceSeconds\)\)/, '15');
  messages.push(systemMessage);
  assert.equal(messages.length, 4);
  setLang('zh');
  try {
    for (const message of messages) {
      assert.ok(ZH[message], `missing helper translation: ${message}`);
      assert.doesNotMatch(t(message, { device: 'USB Audio', seconds: 10 }), /\{\w+\}/);
    }
    const deviceMessage = messages.find((m) => m.includes('{device}'))!;
    assert.match(t(deviceMessage, { device: 'USB Audio', seconds: 10 }), /USB Audio.*10/);
  } finally { setLang('en'); }
});
// Source expressions are checked rather than a hand-maintained list of example output.
const serverMessages = serverStrings();
const nonProse = [
  { file: 'server/screen/watcher.ts', source: "'not_built'", why: 'machine error code; the accompanying message is checked' },
  { file: 'server/screen/watcher.ts', source: "'capture_failed'", why: 'machine error code; the accompanying message is checked' },
  { file: 'server/projects/agents.ts', source: '`Read the file ${promptFile} and follow the instructions in it.`', why: 'instruction sent to the coding agent, not interface prose' },
  { file: 'server/ai/local-model-download.ts', source: "state.preset === 'lmstudio' && !state.remoteJobId ? 'unknown_start' : 'interrupted'", why: 'download error codes rendered by the web as its own messages' },
  { file: 'server/ai/local-model-download.ts', source: "error instanceof DownloadFailure ? error.code : 'connection'", why: 'download error code' },
  { file: 'server/ai/local-model-download.ts', source: "'server'", why: 'download error code' },
];
const webMessages = serverMessages.filter((record) => !record.native && !nonProse.some((entry) => entry.file === record.file && entry.source === record.source));
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('server literals and interpolated UI messages have Chinese translations', () => {
  assert.ok(webMessages.length > 400, 'server message extraction stopped finding its sinks');
  for (const entry of nonProse) assert.ok(serverMessages.some((record) => entry.file === record.file && entry.source === record.source), `stale allowlist entry: ${entry.file}: ${entry.source}`);
  const missing = [];
  for (const { file, source, samples } of webMessages) for (const sample of samples) {
    const key = sample in ZH ? sample : matchServerMessage(sample)?.key;
    if (!key || !ZH[key]) missing.push(`${file}: ${source} → ${sample}`);
    else assert.deepEqual(placeholders(ZH[key]), placeholders(key), key);
  }
  assert.deepEqual(missing, [], `missing server translations:\n${missing.join('\n')}`);
});

test('every compatibility template matches its current producer wording', () => {
  const matched = new Set(webMessages.flatMap(({ samples }) => samples.map((sample) => matchServerMessage(sample)?.key)));
  for (const key of SERVER_MESSAGE_TEMPLATES) assert.ok(matched.has(key), `no current producer matches ${key}`);
  for (const hint of SERVER_SETUP_HINTS) {
    assert.ok(webMessages.some(({ samples }) => samples.includes(hint)), `setup hint changed: ${hint}`);
    assert.ok(webMessages.some(({ samples }) => samples.some((sample) => matchServerMessage(sample)?.vars.hint === hint)), `no producer joins ${hint}`);
  }
  assert.ok(webMessages.filter(({ source }) => source.includes('`')).length > 65);
});

test('native notifications and session title keys use the packaged native dictionary', () => {
  const native = serverMessages.filter((record) => record.native).flatMap(({ samples }) => samples);
  assert.ok(native.includes('Quick session · {date}'));
  assert.ok(native.includes('Session · {date}'));
  assert.ok(native.includes('Listening ({source}). Press {key} to pause.'));
  for (const key of native) { assert.ok(NATIVE_ZH[key], key); assert.deepEqual(placeholders(NATIVE_ZH[key]), placeholders(key), key); }
  assert.ok(serverMessages.every(({ file }) => !/^server\/(mobile\/|mcp\/|mobile-config\.ts)/.test(file)));
  for (const value of [...Object.values(ZH), ...Object.values(NATIVE_ZH)]) assert.doesNotMatch(value, /聆听|编程助手/);
});

test('English skips dictionary lookup and compatibility matching', () => {
  let reads = 0;
  const empty = new Proxy({}, { ownKeys: () => { reads++; return []; }, has: () => { throw new Error('English must not scan templates'); }, get: () => { throw new Error('English must not look up keys'); } });
  assert.equal(translateMessage('Codex app-server stopped (code 1).', empty), 'Codex app-server stopped (code 1).');
  assert.equal(translateMessage('Quick start failed: {error}', empty, { error: 'No API key stored.' }), 'Quick start failed: No API key stored.');
  assert.equal(reads, 1, 'empty dictionaries are checked only once');
});

test('dynamic server messages translate parameters and preserve diagnostic values', async () => {
  const { t, setLang } = await import('../web/src/i18n.ts');
  try {
    setLang('zh');
    assert.equal(t('Quick start: listening ({source}). Rename the session or change its type in the top bar.', { source: 'microphone' }), '快速开始：正在收听（麦克风）。可在顶部栏修改会话名称和类型。');
    assert.equal(t('Add your ElevenLabs API key in Settings → Transcription.'), '请在设置 → 转写中添加 ElevenLabs API 密钥。');
    assert.equal(t('Could not register ⌃⌥⌘L (error -9878); another app may already use it.'), '无法注册快捷键 ⌃⌥⌘L（错误 -9878），可能已被其他应用占用。');
    assert.equal(t('Quick start failed: {error}', { error: 'A session is already active.' }), '快速开始失败：已有会话正在进行。');
    assert.equal(t('This folder does not exist: {path}', { path: 'Home' }), '此文件夹不存在：Home');
    assert.equal(t('This folder does not exist: {path}', { path: '/tmp/My {folder}' }), '此文件夹不存在：/tmp/My {folder}');
    assert.equal(t('Last reported five_hour limit status: allowed (30% used), resets 10/28/2026, 3:00 PM.'), '上次报告的5 小时额度状态：可用（已用 30%），重置时间：10/28/2026, 3:00 PM。');
    assert.equal(t('Codex is not signed in. In Terminal run: codex login  → choose "Sign in with ChatGPT". Chumi never sees your credentials.'), `${ZH['Codex is not signed in.']} ${ZH[SERVER_SETUP_HINTS[3]]}`);
    assert.equal(t('Claude Code is authenticated with "api_key", which is billed per request. Chumi only uses this adapter with a Claude plan sign-in. Run "claude auth logout" then "claude auth login" with your Claude subscription.'), `${t('Claude Code is authenticated with "api_key", which is billed per request. Chumi only uses this adapter with a Claude plan sign-in.')} ${ZH[SERVER_SETUP_HINTS[2]]}`);
    assert.equal(t('ElevenLabs rejected the API key (HTTP 401).'), 'ElevenLabs 拒绝了 API 密钥（HTTP 401）。');
    assert.equal(t('Audio capture stopped unexpectedly (helper exited (code 1)). Trying to restart…'), '音频采集意外停止（音频组件已退出（代码 1）），正在尝试重启…');
    assert.equal(t('Audio input device changed to Studio Mic.'), '音频输入设备已切换为 Studio Mic。');
    assert.equal(t('Waiting for macOS permission for: mic, system. Look for a permission dialog and allow it.'), '正在等待 macOS 授权：麦克风、电脑音频。请在权限对话框中允许访问。');
    assert.equal(t('Claude Code sent nothing for 1.5 min; the request was stopped.'), 'Claude Code 已有 1.5 分钟 未返回内容，请求已停止。');
    assert.equal(t('5-hour limit: 30% used · included-usage status not reported'), '5 小时额度：已用 30% · 尚未报告套餐内含用量状态');
    setLang('en');
    assert.equal(t('Save your ElevenLabs API key first.'), 'Save your ElevenLabs API key first.');
  } finally { setLang('en'); }
});

test('saved titles and system notification prose follow the interface language', async () => {
  const { sessionTitle, localize } = await import('../server/i18n.ts');
  const date = new Date('2026-10-28T15:15:00Z');
  assert.match(sessionTitle('zh', true, date), /^快速会话 · /);
  assert.match(sessionTitle('zh', false, date), /^会话 · /);
  assert.match(sessionTitle('en', true, date), /^Quick session · /);
  assert.equal(localize('zh', 'Listening ({source}). Press {key} to pause.', { source: 'microphone', key: '⌃⌥⌘L' }), '正在收听（麦克风）。按 ⌃⌥⌘L 暂停。');
});


test('packaged server titles and notifications work without web source files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-native-i18n-'));
  try {
    for (const file of ['server/i18n.ts', 'shared/messages.ts', 'shared/native-messages.ts']) {
      const path = join(dir, file); mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, readFileSync(new URL('../' + file, import.meta.url)));
    }
    writeFileSync(join(dir, 'server/platform.ts'), "export const preferredLanguage = () => 'zh';");
    const { sessionTitle, localize } = await import(pathToFileURL(join(dir, 'server/i18n.ts')).href);
    assert.match(sessionTitle('auto', true), /^快速会话/);
    assert.match(localize('auto', 'Could not start. Open Chumi for details.'), /无法开始/);
    assert.match(sessionTitle('en'), /^Session/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
