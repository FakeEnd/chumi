// The tags of Chumi's answer cards, as in its window's filter chips: what the meeting discussed, a tangent beyond it,
// background, or the summary. The desktop pet filters its cards and speech bubbles by them (Settings → Desktop pet).

export const TAGS = ['meeting', 'tangent', 'background', 'summary'] as const;
export type Tag = typeof TAGS[number];
/** What the pet's speech bubbles can be about: the answers' tags, and its own chatter (greetings, reactions). */
export type Topic = Tag | 'chatter';
export const TOPICS: readonly Topic[] = [...TAGS, 'chatter'];

/** A card's tag. Answers carry the category the model gave the question; one still arriving counts as the meeting. */
export function tagOf(o: { kind: string; data?: { category?: unknown } | null }): Tag | null {
  switch (o.kind) {
    case 'answer': return o.data?.category === 'tangent' ? 'tangent' : 'meeting';
    case 'catchup': case 'overview': return 'meeting';
    case 'explain': case 'auto_explain': return 'background';
    case 'final_summary': case 'handoff': return 'summary';
    default: return null;
  }
}
