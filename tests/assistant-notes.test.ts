import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.ts';
import { Assistant } from '../server/ai/assistant.ts';
import { ProviderRegistry } from '../server/ai/registry.ts';
import type { CompletionRequest, CompletionResult } from '../server/ai/provider.ts';
import { renderDigests, renderOverview, type Digest, type OverviewData } from '../server/ai/context.ts';

const overview: OverviewData = { current_topic: 'Testing the hypothesis', overview: ['The opening hypothesis was that barcode diversity predicts stability [0:10].'], topics: [{ title: 'Opening hypothesis', start: '0:10' }], open_question: 'Does the held-out sample support it?' };
const notes: Digest[] = Array.from({ length: 30 }, (_, i) => ({ from: i * 60_000, to: i * 60_000 + 10_000, text: `Note ${i}: ` + 'This is preliminary evidence with a hedge [0:10]. '.repeat(7), segmentIds: [i + 1] }));

test('digest budgets keep complete newest notes, preserve chronology, and count omissions', () => {
  const text = renderDigests(notes, Infinity, 1400);
  assert.ok(text.length <= 1400);
  const count = Number(text.match(/^\[… (\d+) earlier notes omitted …\]/)![1]);
  assert.equal(text, [`[… ${count} earlier notes omitted …]`, renderDigests(notes.slice(count))].join('\n'));
  assert.match(text, /Note 29:/);
  assert.doesNotMatch(text, /Note 0:/);
  const multiline = [{ ...notes[0], text: 'First sentence [0:10].\nSecond sentence [0:11].' }, notes[1]];
  assert.equal(renderDigests(multiline, Infinity, 2000), renderDigests(multiline));
  assert.equal(renderDigests(multiline, Infinity, 300), '[… 2 earlier notes omitted …]', 'an oversized note is omitted whole');
  assert.equal(renderDigests(notes, 0, 1000), '');
});

test('an oversized overview is capped at whole lines without cutting citations', () => {
  const text = renderOverview({ ...overview, overview: Array.from({ length: 30 }, () => overview.overview[0]) }, 1500);
  assert.ok(text.length <= 1500);
  assert.match(text, /^Current topic: Testing the hypothesis\n/);
  assert.match(text, /\[0:10\]\.\n\[… overview details omitted …\]$/);
});

for (const kind of ['ask', 'explain', 'catchup', 'overview'] as const) {
  test(`${kind} preserves the meeting overview and trims earlier notes at complete boundaries`, { timeout: 3000 }, async (t) => {
    const store = new Store(':memory:');
    const settings = store.getSettings();
    store.saveSettings({ ...settings, devMode: true, ai: { ...settings.ai, provider: 'mock' } });
    store.createSession({ id: 'meeting', title: 'Seminar', type: 'lecture', audio_source: 'mic' });
    for (const [i, note] of notes.entries()) {
      const s = store.addSegment({ session_id: 'meeting', t_start: note.from, t_end: note.to, text: 'Discussing evidence.', source: 'mic', lang: 'en', run: 1 });
      store.insertOutput({ id: `digest-${i}`, session_id: 'meeting', kind: 'digest', status: 'done', content: note.text, covered_from: note.from, covered_to: note.to, data_json: JSON.stringify({ segmentIds: [s.id] }) });
    }
    store.insertOutput({ id: 'overview', session_id: 'meeting', kind: 'overview', status: 'done', content: 'Overview', data_json: JSON.stringify({ ...overview, lastSegmentId: store.maxSegmentId('meeting') }), covered_from: 0, covered_to: notes.at(-1)!.to });
    store.addSegment({ session_id: 'meeting', t_start: 31 * 60_000, t_end: 31 * 60_000 + 5000, text: 'A new question.', source: 'mic', lang: 'en', run: 1 });
    const registry = new ProviderRegistry(store);
    const requests: CompletionRequest[] = [];
    t.mock.method(registry.mock, 'complete', async (request: CompletionRequest): Promise<CompletionResult> => {
      requests.push(request);
      return { text: kind === 'overview' ? JSON.stringify(overview) : 'Answer.', provider: 'mock', model: 'notes-test', billing: 'none' };
    });
    const assistant = new Assistant(store, registry, () => {});
    t.after(async () => { await registry.shutdown(); store.close(); });
    const completed = new Promise<void>((resolve) => { assistant.onOutputDone = () => resolve(); });
    if (kind === 'ask') assistant.ask('meeting', 'What was the opening hypothesis?', null, 'standard');
    else if (kind === 'explain') assistant.explain('meeting', 'Opening hypothesis', null, 'standard');
    else if (kind === 'catchup') assistant.catchup('meeting', '2m');
    else assistant.overview('meeting');
    await completed;
    assert.equal(requests.length, 1);
    const input = requests[0].input;
    assert.ok(input.includes(renderOverview(overview)), 'the complete overview fits and must be retained');
    assert.match(input, /\[… \d+ earlier notes omitted …\]\n\[\d+:\d+–\d+:\d+\] Note \d+:/);
    assert.doesNotMatch(input, /Note 0:/);
    if (kind === 'ask' || kind === 'explain') {
      const context = input.split('EARLIER DISCUSSION NOTES (AI-generated, may be imperfect):\n')[1].split('\n\n')[0];
      assert.ok(context.length <= 4000);
    }
  });
}
