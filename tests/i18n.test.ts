import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
