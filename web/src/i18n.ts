import { createElement, Fragment, type ReactNode } from 'react';
import { translateMessage } from '../../shared/messages.ts';
import { ZH } from './i18n-zh.ts';

/**
 * Interface language. Strings are written in English in the components and looked up in the
 * Chinese dictionary (i18n-zh.ts) when the interface language is 中文. Missing entries fall back
 * to English; tests/i18n.test.ts fails if a literal t()/tn() string has no translation.
 */
export type UiLang = 'en' | 'zh';
let lang: UiLang = 'en';
const EN = {};

export function resolveLang(pref: string | undefined, system?: string): UiLang {
  if (pref === 'en' || pref === 'zh') return pref;
  if (system === 'en' || system === 'zh') return system;
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
export function setLang(l: UiLang): void {
  lang = l;
  const doc = (globalThis as { document?: { documentElement: { lang: string } } }).document; // absent in tests (Node)
  if (doc) doc.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
}
export const getLang = (): UiLang => lang;

/** Translate a string; {name} placeholders are filled from vars. */
export function t(en: string, vars?: Record<string, string | number>): string {
  // Assistant adds this reassurance to provider errors; translate each known part.
  const suffix = ' Transcription continues and nothing captured is lost.';
  if (lang === 'zh' && !(en in ZH) && en.endsWith(suffix)) return `${translateMessage(en.slice(0, -suffix.length), ZH, vars)} ${ZH[suffix.trim()] ?? suffix.trim()}`;
  return translateMessage(en, lang === 'zh' ? ZH : EN, vars);
}

/** Translate a string whose {name} placeholders are React nodes (links, <b>, <code>). */
export function tn(en: string, nodes: Record<string, ReactNode>): ReactNode {
  const s = lang === 'zh' ? ZH[en] ?? en : en;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(/\{(\w+)\}/g)) {
    parts.push(s.slice(last, m.index));
    parts.push(m[1] in nodes ? nodes[m[1]] : m[0]);
    last = m.index! + m[0].length;
  }
  parts.push(s.slice(last));
  return createElement(Fragment, null, ...parts);
}

/** Marks a string for translation where it is defined (tables, ternaries); translate it later with t(). */
export const msg = (en: string): string => en;

/** Plural helper for English; Chinese has no plural forms. */
export const plural = (n: number, one: string, many: string): string => t(n === 1 ? one : many, { n });

/** Time/date formatting follows the interface language. */
export const locale = (): string => (lang === 'zh' ? 'zh-CN' : 'en-US');
