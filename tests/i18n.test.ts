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
