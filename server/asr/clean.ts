import { readFileSync } from 'node:fs';
import type { WhisperSegment } from './whisper.ts';

/** Traditional → Simplified single-character map, generated from macOS ICU ("Hant-Hans"). */
const T2S: Record<string, string> = JSON.parse(readFileSync(new URL('./t2s.json', import.meta.url), 'utf8'));
export function toSimplified(text: string): string {
  let out = '';
  for (const ch of text) out += T2S[ch] ?? ch;
  return out;
}

/** Phrases Whisper is known to hallucinate on silence/noise (YouTube-caption artefacts). */
const ALWAYS_DROP = [
  /amara\.org/i, /subtitles by/i, /字幕由.*提供/, /请不吝点赞/, /订阅.*转发/, /明镜与点点/, /like and subscribe/i, /^字幕[:：]/,
];
const SUSPICIOUS = [
  /^(thank you|thanks|thank you for watching|thanks for watching|bye|you|okay|so|谢谢|谢谢观看|谢谢大家|嗯|好)[.!。！]*$/i,
];

const LANG_CODES: Record<string, string> = { english: 'en', chinese: 'zh', mandarin: 'zh', japanese: 'ja', korean: 'ko', cantonese: 'yue' };
export const langCode = (l: string | null): string | null => (l ? (LANG_CODES[l.toLowerCase()] ?? l.toLowerCase().slice(0, 2)) : null);

/** Collapse runaway repetition ("the model the model the model …"). */
export function collapseRepeats(text: string): string {
  let t = text;
  for (let n = 1; n <= 8; n++) {
    const re = new RegExp(`((?:\\S+\\s+){${n}})\\1{2,}`, 'g');
    t = t.replace(re, '$1');
  }
  t = t.replace(/(.{2,12}?)\1{3,}/gu, '$1'); // CJK / unspaced repeats
  return t;
}

export function cleanSegmentText(raw: string): string {
  return collapseRepeats(
    raw
      .replace(/\[(?:BLANK_AUDIO|MUSIC|Music|music|NOISE|Noise|silence|SILENCE|inaudible|音乐|掌声)[^\]]*\]/g, ' ')
      .replace(/\((?:music|Music|applause|laughs?|inaudible|音乐|掌声)[^)]*\)/g, ' ')
      .replace(/[♪♫]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/** More Chinese characters than Latin words: a Mandarin sentence with a few English terms still counts. */
export const mostlyHan = (text: string): boolean => (text.match(/\p{Script=Han}/gu)?.length ?? 0) > (text.match(/[A-Za-z]+/g)?.length ?? 0);

/**
 * The ASR glossary as an ordinary sentence. Whisper reads its prompt as transcript that came just before the audio,
 * so a labelled list ("Glossary: …") was sometimes echoed into the output as if it had been said.
 */
export function termSentence(terms: string[], chinese: boolean): string {
  if (!terms.length) return '';
  if (chinese) return `我们讨论了${terms.join('、')}。`;
  return `We talked about ${terms.length > 1 ? `${terms.slice(0, -1).join(', ')} and ${terms.at(-1)}` : terms[0]}.`;
}

/** `text` without a leading copy of `phrase` (ignoring case, spacing, punctuation and Chinese script), or null when it does not start with one. */
function dropLeading(text: string, phrase: string): string | null {
  const key = (s: string) => toSimplified(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const want = key(phrase);
  if (!want) return null;
  let i = 0, k = 0;
  while (i < text.length && k < want.length) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    i += ch.length;
    const n = key(ch);
    if (!n) continue;
    if (!want.startsWith(n, k)) return null;
    k += n.length;
  }
  return k === want.length ? text.slice(i).replace(/^[\s.,;:!?…。，、；：！？]+/u, '') : null;
}

/**
 * Remove prompt text Whisper repeated as speech: a leading "Glossary:" label (the old prompt format), or the term sentence
 * together with the previous-text tail that followed it in the prompt. The term sentence only counts when it lists three
 * or more terms; a short one ("We talked about CRISPR.") is something people actually say.
 */
export function stripPromptEcho(text: string, prompt: { terms: string[]; chinese: boolean; prev: string }): string {
  let t = text.replace(/^\s*glossary\s*[:：]\s*/i, '');
  const rest = prompt.terms.length >= 3 ? dropLeading(t, termSentence(prompt.terms, prompt.chinese)) : null;
  if (rest !== null) t = dropLeading(rest, prompt.prev) ?? rest;
  return t.trim();
}

/** Decide whether a Whisper segment is likely real speech. */
export function keepSegment(seg: WhisperSegment, text: string, utteranceSec: number): boolean {
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return false;
  if (ALWAYS_DROP.some((re) => re.test(text))) return false;
  const nsp = seg.no_speech_prob ?? 0;
  const lp = seg.avg_logprob ?? 0;
  if (nsp > 0.6 && lp < -0.8) return false;
  if (lp < -1.4) return false;
  if (SUSPICIOUS.some((re) => re.test(text)) && (nsp > 0.15 || lp < -0.6 || utteranceSec < 1.2)) return false;
  return true;
}
