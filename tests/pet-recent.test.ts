import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../web/src/i18n.ts';
import { cardTitle, focusOf, preview, recent, tagCounts } from '../web/src/pet/recent.ts';
import { tagOf } from '../web/src/pet/tags.ts';
import type { Output } from '../web/src/types.ts';

const out = (o: Partial<Output>): Output => ({
  id: 'o', session_id: 's', kind: 'answer', status: 'done', question: null, selection: null, scope: null, depth: null, covered_from: null, covered_to: null,
  content: null, data: null, error: null, provider: null, model: null, billing: null, auto_epoch: null, parent_id: null, created_at: 0, completed_at: null, ...o,
});

test('the pet lists requested answers and explanations, newest first', () => {
  const list = recent([
    out({ id: 'old', kind: 'catchup', created_at: 1 }),
    out({ id: 'bg', kind: 'overview', question: null, created_at: 5 }),
    out({ id: 'recap', kind: 'overview', question: 'Recap now', created_at: 4 }),
    out({ id: 'term', kind: 'auto_explain', question: 'KV cache', created_at: 3 }),
    out({ id: 'gone', kind: 'answer', status: 'cancelled', created_at: 6 }),
    out({ id: 'digest', kind: 'digest', created_at: 7 }),
    out({ id: 'q', kind: 'answer', status: 'streaming', created_at: 2 }),
  ], 10);
  assert.deepEqual(list.map((o) => o.id), ['recap', 'term', 'q', 'old']);
  assert.deepEqual(recent(list, 1).map((o) => o.id), ['recap']);
});

test('cards are tagged like the chips in Chumi’s window, and filtered by them', () => {
  const cards = [
    out({ id: 'c', kind: 'catchup', created_at: 1 }),
    out({ id: 'm', kind: 'answer', data: { category: 'meeting' }, created_at: 2 }),
    out({ id: 't', kind: 'answer', data: { category: 'tangent' }, created_at: 3 }),
    out({ id: 'b', kind: 'auto_explain', question: 'KV cache', created_at: 4 }),
    out({ id: 's', kind: 'final_summary', created_at: 5 }),
    out({ id: 'w', kind: 'explain', status: 'streaming', created_at: 6 }),
  ];
  assert.deepEqual(cards.map(tagOf), ['meeting', 'meeting', 'tangent', 'background', 'summary', 'background']);
  assert.deepEqual(Object.fromEntries(tagCounts(cards)), { meeting: 2, tangent: 1, background: 2, summary: 1 });
  // Background hidden: a card still being written and one you opened stay.
  assert.deepEqual(recent(cards, 10, ['meeting', 'tangent', 'summary']).map((o) => o.id), ['w', 's', 't', 'm', 'c']);
  assert.deepEqual(recent(cards, 10, ['summary'], (o) => o.id === 'b').map((o) => o.id), ['w', 's', 'b']);
});

test('cards use the titles of Chumi’s window, in its language', () => {
  setLang('zh');
  assert.equal(cardTitle(out({ kind: 'catchup', scope: '2m' })), '回顾 · 最近 2 分钟');
  assert.equal(cardTitle(out({ kind: 'explain', question: 'KV cache' })), '解释：KV cache');
  assert.equal(cardTitle(out({ kind: 'final_summary' })), '最终总结');
  setLang('en');
  assert.equal(cardTitle(out({ kind: 'catchup', scope: '5m' })), 'Catch-up · last 5 min');
  assert.equal(cardTitle(out({ kind: 'answer', question: 'Is the gain real?' })), 'Is the gain real?');
});

test('the collapsed preview drops citations and markup, and cards open at their passage', () => {
  assert.equal(preview('## Now\n- **Maya** says the gain is real [2:41–3:05]，but [link](https://x.y) needs a *second* judge [3:48, 4:02].'),
    'Now Maya says the gain is real，but link needs a second judge.');
  assert.equal(preview('a'.repeat(300), 20).length, 20);
  assert.deepEqual(focusOf(out({ selection: { fromT: 1000, toT: 2000, text: 'x' } })), { t: 1000, t2: 2000 });
  assert.deepEqual(focusOf(out({ covered_from: 5000, covered_to: 9000 })), { t: 5000, t2: 9000 });
  assert.equal(focusOf(out({})), undefined);
});
