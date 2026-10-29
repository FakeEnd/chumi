import { similarity } from '../util.ts';

/** Word trigrams avoid matching English replies just because they reuse part of a technical term. */
export function echoContained(system: string, mic: string): boolean {
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(mic);
  const tokens = (text: string) => {
    const clean = text.toLowerCase().replace(/['’]/g, '');
    return cjk ? [...clean.replace(/[^\p{L}\p{N}]/gu, '')] : clean.match(/[\p{L}\p{N}]+/gu) ?? [];
  };
  const words = tokens(mic);
  // Short acknowledgements and interjections are too ambiguous to discard.
  if (words.length < (cjk ? 8 : 5)) return false;
  const grams = (parts: string[]) => new Set(parts.slice(2).map((_, i) => parts.slice(i, i + 3).join(' ')));
  const systemWords = tokens(system);
  if (words.length > systemWords.length * 1.2) return false;
  const A = grams(systemWords), B = grams(words);
  let shared = 0;
  for (const gram of B) if (A.has(gram)) shared++;
  return shared / B.size >= 0.8 || similarity(system, mic) > 0.45;
}

interface TimedText { text: string; t_start: number; t_end: number }

export function isMicEcho(mic: TimedText, system: TimedText[]): boolean {
  return system.some((line) => {
    const overlap = Math.min(mic.t_end, line.t_end) - Math.max(mic.t_start, line.t_start);
    // A reply after the remote speaker finishes is real speech, even if it repeats the same words.
    return overlap >= 250 && overlap >= (mic.t_end - mic.t_start) * 0.5 && echoContained(line.text, mic.text);
  });
}
