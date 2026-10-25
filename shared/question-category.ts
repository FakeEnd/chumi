/**
 * Answers start with a marker line in which the model classifies the user's question: about what the meeting
 * is discussing, or a tangent beyond it (background, related ideas, the user's own curiosity). The server
 * strips the marker from the stored answer; the interface strips it while the answer streams.
 */
export type QuestionCategory = 'meeting' | 'tangent';

const MARKER = /^\s*[*_`]*\[\[\s*(meeting|tangent)\s*\]\][*_`]*[ \t]*(?:\r?\n|$)/i;
/** The start of a marker that has not fully arrived yet ("[[", "[[mee"). */
const PARTIAL = /^\s*[*_`]*\[{1,2}\s*[a-z]*\s*\]?$/i;

/** `streaming`: the text is still arriving, so hide what may become the marker. */
export function splitCategory(text: string, streaming = false): { category: QuestionCategory | null; body: string } {
  const m = MARKER.exec(text);
  if (m) return { category: m[1].toLowerCase() as QuestionCategory, body: text.slice(m[0].length).replace(/^\s+/, '') };
  if (streaming && PARTIAL.test(text)) return { category: null, body: '' };
  return { category: null, body: text };
}
