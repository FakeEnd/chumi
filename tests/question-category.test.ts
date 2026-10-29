import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type OutputRow } from '../server/db.ts';
import { Assistant } from '../server/ai/assistant.ts';
import { ProviderRegistry } from '../server/ai/registry.ts';
import type { CompletionRequest, CompletionResult } from '../server/ai/provider.ts';
import { splitCategory } from '../shared/question-category.ts';

test('question category marker is read and stripped, also while it streams', () => {
  assert.deepEqual(splitCategory('[[meeting]]\n\n**Short answer:** yes [0:12].'), { category: 'meeting', body: '**Short answer:** yes [0:12].' });
  assert.deepEqual(splitCategory('**[[Tangent]]**\nIt relates to…'), { category: 'tangent', body: 'It relates to…' });
  assert.deepEqual(splitCategory('[[tangent]]'), { category: 'tangent', body: '' });
  // No marker (older answers, models that ignore it): the text is left alone.
  assert.deepEqual(splitCategory('[0:12] They said yes.'), { category: null, body: '[0:12] They said yes.' });
  assert.deepEqual(splitCategory('[ok]'), { category: null, body: '[ok]' });
  // A marker still arriving is hidden while streaming, never in a finished answer.
  assert.deepEqual(splitCategory('[[mee', true), { category: null, body: '' });
  assert.deepEqual(splitCategory('[0:1', true), { category: null, body: '[0:1' });
});

test('Assistant.ask stores the category apart from the answer and the meeting time it was asked at', { timeout: 3000 }, async (t) => {
  const store = new Store(':memory:');
  const settings = store.getSettings();
  store.saveSettings({ ...settings, devMode: true, ai: { ...settings.ai, provider: 'mock' } });
  const registry = new ProviderRegistry(store);
  const assistant = new Assistant(store, registry, () => {});
  t.after(async () => { await registry.shutdown(); store.close(); });

  const session = store.createSession({ id: 'category-test', title: 'Lab meeting', type: 'lab_meeting', audio_source: 'mic' });
  store.addSegment({ session_id: session.id, t_start: 1000, t_end: 5000, text: 'We use a chromosome holdout for the test set.', lang: 'en', source: 'mic', run: 1 });
  const requests: CompletionRequest[] = [];
  const replies = ['[[tangent]]\n\n**Short answer:** It guards against leakage between nearby regions.', 'They hold out a chromosome [0:01].'];
  t.mock.method(registry.mock, 'complete', async (request: CompletionRequest): Promise<CompletionResult> => {
    requests.push(request);
    return { text: replies[requests.length - 1], provider: 'mock', model: 'category-test', billing: 'none' };
  });
  const done = () => new Promise<OutputRow>((resolve) => { assistant.onOutputDone = resolve; });

  // While recording: the session clock is recorded with the question.
  assistant.clock = (id) => (id === session.id ? 252_000 : null);
  let finished = done();
  const first = assistant.ask(session.id, 'Why hold out whole chromosomes in general?', null, 'standard');
  assert.equal(JSON.parse(store.getOutput(first)!.data_json!).askedT, 252_000, 'known before the answer arrives');
  await finished;
  assert.match(requests[0].instructions, /\[\[meeting\]\].*\[\[tangent\]\]/s);
  const tangent = store.getOutput(first)!;
  assert.equal(tangent.content, '**Short answer:** It guards against leakage between nearby regions.');
  assert.equal(JSON.parse(tangent.data_json!).category, 'tangent');
  assert.equal(JSON.parse(tangent.data_json!).askedT, 252_000);

  // After the meeting (reviewing): no session clock, and an answer without a marker keeps its text.
  assistant.clock = () => null;
  finished = done();
  const second = assistant.ask(session.id, 'What test set do they use?', null, 'quick');
  await finished;
  const plain = store.getOutput(second)!;
  assert.equal(plain.content, 'They hold out a chromosome [0:01].');
  const data = JSON.parse(plain.data_json!);
  assert.equal(data.category, undefined);
  assert.equal(data.askedT, undefined);
});
