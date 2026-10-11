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
