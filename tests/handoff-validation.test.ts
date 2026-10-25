import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type HandoffItemRow } from '../server/db.ts';
import { Assistant } from '../server/ai/assistant.ts';
import { ProviderRegistry } from '../server/ai/registry.ts';
import { HandoffService } from '../server/projects/handoff.ts';

const draft = (texts: string[]) => ({ decisions: [], actions: texts.map((text) => ({ text, origin: 'agreed' })), open_questions: [] });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(t: TestContext) {
  const store = new Store(':memory:');
  const settings = store.getSettings();
  store.saveSettings({ ...settings, devMode: true, ai: { ...settings.ai, provider: 'mock' } });
  store.createProject({ id: 'original', name: 'Original project', workspace: '/tmp/fixture-original' });
  store.createProject({ id: 'destination', name: 'Destination project', workspace: '/tmp/fixture-destination' });
  store.createSession({ id: 'meeting', title: 'Fixture meeting', type: 'other', audio_source: 'mic' });
  store.assignSession('meeting', 'original');
  store.addSegment({ session_id: 'meeting', t_start: 0, t_end: 1000, text: 'We agreed to run the experiment.', lang: 'en', source: 'mic', run: 1 });
  const registry = new ProviderRegistry(store);
  let response: unknown;
  t.mock.method(registry.mock, 'complete', async () => ({ text: JSON.stringify(response), provider: 'mock', model: 'fixture', billing: 'none' as const }));
  const assistant = new Assistant(store, registry, () => {});
  const handoffs = new HandoffService(store, assistant, () => {});
  t.after(async () => { await registry.shutdown(); store.close(); });
  const generate = async (next: unknown) => {
    response = next;
    const h = handoffs.generate('meeting');
    for (let i = 0; i < 100 && store.getHandoff(h.id)!.status === 'generating'; i++) await tick();
    assert.notEqual(store.getHandoff(h.id)!.status, 'generating');
    return store.getHandoff(h.id)!;
  };
  const h = await generate(draft(['Run the experiment', 'Review the dataset']));
  return { store, handoffs, generate, id: h.id };
}

test('malformed handoff structures and items preserve every previous draft item', async (t) => {
  for (const invalid of [
    {}, { decisions: {}, actions: [], open_questions: [] },
    { decisions: [], actions: [{ text: 'Valid first item' }, null], open_questions: [] },
    { decisions: [], actions: [{ text: 42 }], open_questions: [] },
    { decisions: [], actions: [{ text: 'Malformed conditions', conditions: {} }], open_questions: [] },
  ]) {
    await t.test(JSON.stringify(invalid), async (t) => {
      const f = await fixture(t);
      const before = f.store.handoffItems(f.id);
      const previous = f.store.getHandoff(f.id)!;
      const h = await f.generate(invalid);
      assert.equal(h.status, 'draft');
      assert.equal(h.source_revision, previous.source_revision);
      assert.equal(h.output_id, previous.output_id, 'the retained draft keeps its original source snapshot');
      assert.match(h.error!, /invalid handoff.*previous draft was kept/i);
      assert.deepEqual(f.store.handoffItems(f.id), before);
      assert.ok(f.store.outputs('meeting').some((o) => o.status === 'error'));
    });
  }
});

test('a failed redraft after project reassignment cannot retarget the retained items', async (t) => {
  const f = await fixture(t);
  const before = f.store.handoffItems(f.id);
  f.store.assignSession('meeting', 'destination');
  const failed = await f.generate({ decisions: {}, actions: [], open_questions: [] });
  assert.equal(failed.project_id, 'original');
  assert.equal(f.handoffs.view('meeting')!.project_mismatch, true);
  assert.deepEqual(f.store.handoffItems(f.id), before);
  assert.throws(() => f.handoffs.confirm(f.id), /another project/);
  const succeeded = await f.generate(draft(['Publish the new result']));
  assert.equal(succeeded.project_id, 'destination');
  assert.equal(f.handoffs.view('meeting')!.project_mismatch, false);
  assert.ok(f.store.handoffItems(f.id).every((i) => i.project_id === 'destination'));
});

test('handoff replacement rolls back a partial write and a retry replaces only untouched items', async (t) => {
  const f = await fixture(t);
  const edited = f.store.handoffItems(f.id)[1];
  f.handoffs.updateItem(edited.id, { text: 'Review the dataset with my edits' });
  const before = f.store.handoffItems(f.id);
  const oldSource = f.store.getHandoff(f.id)!.source_revision;
  f.store.addSegment({ session_id: 'meeting', t_start: 2000, t_end: 3000, text: 'Also publish a chart and document limitations.', lang: 'en', source: 'mic', run: 1 });
  const originalInsert = f.store.insertHandoffItem.bind(f.store);
  let writes = 0;
  const insert = t.mock.method(f.store, 'insertHandoffItem', (item: Omit<HandoffItemRow, 'updated_at'>) => {
    if (++writes === 2) throw new Error('Simulated disk write failure');
    originalInsert(item);
  });
  const replacement = draft(['Publish a chart', 'Document limitations']);
  const failed = await f.generate(replacement);
  assert.equal(writes, 2, 'failure happened after an insertion within the replacement');
  assert.equal(failed.status, 'draft');
  assert.equal(failed.source_revision, oldSource);
  assert.match(failed.error!, /Simulated disk write failure/);
  assert.deepEqual(f.store.handoffItems(f.id), before, 'old pending and edited items both survive rollback');
  insert.mock.restore();
  const succeeded = await f.generate(replacement);
  assert.equal(succeeded.error, null);
  assert.equal(succeeded.source_revision, f.store.getSession('meeting')!.revision);
  assert.deepEqual(f.store.handoffItems(f.id).map((i) => i.text), ['Review the dataset with my edits', 'Publish a chart', 'Document limitations']);
  assert.equal(f.store.getHandoffItem(edited.id)!.edited, 1);
});
