/**
 * Spoken-language policy for automatic detection. Chumi transcribes Mandarin and English. Given a second or two of
 * speech, Whisper's detector often names Korean, Spanish, Japanese or Russian instead, and the decoder then writes either
 * the right Chinese under the wrong label or text in the wrong language. With 'auto', a result in any other language is
 * relabelled when its text is already Chinese, and otherwise transcribed again in the likelier of the two languages.
 */
export type Spoken = 'zh' | 'en';

export const isSpoken = (lang: string | null): lang is Spoken => lang === 'zh' || lang === 'en';

/**
 * The language a meeting most likely opens in, before anything has been said: Chinese when the interface, the system or
 * the explanation language is Chinese, otherwise English.
 */
export function languagePrior(o: { ui: string; system: string; explanation: string }): Spoken {
  const zh = (s: string) => /^zh|chinese|中文/i.test(s);
  return (o.ui === 'zh' || (o.ui === 'auto' && zh(o.system)) || zh(o.explanation)) ? 'zh' : 'en';
}

/** Scripts that rule out Mandarin and English text: kana, hangul, Cyrillic, Thai, Arabic, Devanagari, Hebrew, Greek. */
const FOREIGN_SCRIPT = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Thai}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Hebrew}\p{Script=Greek}]/u;

export type LanguageDecision = { action: 'keep' } | { action: 'relabel'; lang: Spoken } | { action: 'retry'; lang: Spoken };

/**
 * What to do with an automatically detected result. The label follows the text that was written.
 * - Mandarin or English: keep it, unless the text says otherwise: Chinese written under 'en' is Mandarin, and text
 *   with English words and no Chinese character under 'zh' is English.
 * - Another language, but the text is Chinese (mostly Han, no foreign script): the decoder followed the speech, only the
 *   label is wrong, so relabel it as Mandarin.
 * - Anything else: transcribe again, forcing Mandarin or English. Whisper's own probabilities choose when they clearly
 *   prefer one; otherwise the language this source spoke last, otherwise the meeting's prior.
 */
export function decideLanguage(r: { lang: string | null; probs: Record<string, number>; text: string }, recent: Spoken | null, prior: Spoken): LanguageDecision {
  if (!r.text.trim()) return { action: 'keep' };
  const han = r.text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = r.text.match(/[A-Za-z]+/g)?.length ?? 0;
  const chinese = han > latin && !FOREIGN_SCRIPT.test(r.text);
  if (r.lang === 'en') return chinese ? { action: 'relabel', lang: 'zh' } : { action: 'keep' };
  if (r.lang === 'zh') return han === 0 && latin > 0 && !FOREIGN_SCRIPT.test(r.text) ? { action: 'relabel', lang: 'en' } : { action: 'keep' };
  if (chinese) return { action: 'relabel', lang: 'zh' };
  const zh = r.probs.zh ?? 0, en = r.probs.en ?? 0;
  const lang: Spoken = Math.abs(zh - en) >= 0.05 ? (zh > en ? 'zh' : 'en') : (recent ?? prior);
  return { action: 'retry', lang };
}
