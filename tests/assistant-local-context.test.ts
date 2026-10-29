import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'chumi-local-context-'));
process.env.CHUMI_DATA_DIR = dir;
process.env.HOME = dir;
const { Store } = await import('../server/db.ts');
const { Assistant } = await import('../server/ai/assistant.ts');
const { ProviderRegistry } = await import('../server/ai/registry.ts');
const { CompatibleProvider, estimateContextTokens } = await import('../server/ai/compatible.ts');
const { digests } = await import('../server/ai/context.ts');
test.after(() => rmSync(dir, { recursive: true, force: true }));

async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await new Promise<void>((r) => setImmediate(r)); }
  assert.ok(check(), 'request did not settle');
}

for (const preset of ['ollama', 'lmstudio'] as const) for (const context of [4096, 8192]) for (const language of ['en', 'zh']) {
  test(`${preset} ${context}: a 40-minute ${language} meeting fits catch-up, recap, summary and handoff`, async (t) => {
    const store = new Store(':memory:');
    const settings = store.getSettings();
    settings.ai.provider = 'compatible'; settings.ai.compatible.preset = preset;
    Object.assign(settings.ai.compatible.profiles[preset], { model: 'fixture', contextTokens: context, contextExplicit: true });
    store.saveSettings(settings);
    store.createSession({ id: 'meeting', title: 'Experiment review', type: 'advisor', audio_source: 'mic' });
    for (let i = 0; i < 40; i++) store.addSegment({ session_id: 'meeting', t_start: i * 60000, t_end: i * 60000 + 59000,
      text: language === 'en' ? `Minute ${i}: ` + 'We will review the experiment results and plan the next study. '.repeat(30) : `第${i}分钟：` + '我们讨论实验结果并安排下一轮研究，明确每个人负责的任务。'.repeat(50), lang: language, source: 'mic', run: 1 });
    const registry = new ProviderRegistry(store);
    const sent: any[] = [];
    const provider = new CompatibleProvider(() => store.getSettings().ai.compatible, { readKey: async () => null, fetch: async (url, init) => {
      if (String(url).endsWith('/api/show')) return Response.json({ model_info: { architecture: 'fixture' } });
      const body = JSON.parse(String(init?.body)); sent.push(body);
      const system = body.messages[0].content, input = body.messages[1].content;
      const output = body.options?.num_predict ?? body.max_tokens;
      assert.equal(output, context / 4);
      assert.ok(estimateContextTokens(system + '\n' + input) + output <= context, 'sent prompt and answer allowance fit the selected context');
      if (preset === 'ollama') assert.equal(body.options.num_ctx, context);
      const content = system.includes('"current_topic"') ? JSON.stringify({ current_topic: 'Study plan', overview: ['Review the results'], topics: [], open_question: '', digest: 'Study plan agreed [0:00].' })
        : system.includes('"decisions"') ? '{"decisions":[],"actions":[],"open_questions":[]}' : 'Study plan agreed [0:00].';
      return preset === 'ollama' ? new Response(JSON.stringify({ message: { content }, done: true, done_reason: 'stop' }))
        : Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
    } });
    registry.providers.compatible = provider;
    const assistant = new Assistant(store, registry, () => {});
    t.after(async () => { assistant.cancelSession('meeting'); await registry.shutdown(); store.close(); });
    assert.equal((await provider.testConnection()).ready, true, '4K also leaves room for the connection test');
    for (const run of [() => assistant.catchup('meeting', 'all'), () => assistant.overview('meeting', true), () => assistant.summary('meeting'), () => assistant.handoffDraft('meeting', { onResult() {}, onFail() {} })]) {
      const before = sent.length;
      const id = run();
      await until(() => !['pending', 'streaming'].includes(store.getOutput(id)!.status));
      assert.equal(store.getOutput(id)!.status, 'done', store.getOutput(id)!.error ?? '');
      assert.ok(sent.length > before, 'the final request was actually sent');
      assert.match(sent.at(-1).messages[1].content, /Study plan agreed/);
      assert.match(sent.at(-1).messages[1].content, language === 'en' ? /Minute 39/ : /第39分钟/);
    }
    const covered = new Set(digests(store, 'meeting').flatMap((d) => d.segmentIds));
    assert.ok(covered.has(store.firstSegment('meeting')!.id), 'early meeting content is digested, not silently dropped');
  });
}

test('the last-resort context error backs off automatic overviews and suits any task', async (t) => {
  const store = new Store(':memory:');
  const settings = store.getSettings();
  settings.ai.provider = 'compatible'; settings.ai.compatible.preset = 'lmstudio';
  Object.assign(settings.ai.compatible.profiles.lmstudio, { model: 'fixture', contextTokens: 1024, contextExplicit: true });
  settings.assist.autoOverview = true; settings.assist.autoExplain = false;
  store.saveSettings(settings);
  store.createSession({ id: 'tiny', title: 'Study plan', type: 'advisor', audio_source: 'mic' });
  store.addSegment({ session_id: 'tiny', t_start: 0, t_end: 60000, text: 'We will run the experiment. '.repeat(500), lang: 'en', source: 'mic', run: 1 });
  const registry = new ProviderRegistry(store);
  let sent = 0;
  registry.providers.compatible = new CompatibleProvider(() => settings.ai.compatible, { readKey: async () => null, fetch: async () => { sent++; throw new Error('should not send'); } });
  const assistant = new Assistant(store, registry, () => {});
  t.after(async () => { assistant.cancelSession('tiny'); await registry.shutdown(); store.close(); });
  const id = assistant.overview('tiny');
  await until(() => store.getOutput(id)!.status === 'error');
  const failed = store.getOutput(id)!;
  assert.equal(JSON.parse(failed.data_json!).errorKind, 'unavailable');
  assert.match(failed.error ?? '', /Increase Context length/);
  assert.doesNotMatch(failed.error ?? '', /shorter time range/);
  assert.equal(sent, 0);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 60000);
  assistant.onActivity('tiny', 'pause');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.outputs('tiny', ['overview']).length, 1, 'backoff prevents repeated error rows');
});

test('local digest splitting sends every character of an oversized line before recording its coverage', async (t) => {
  const store = new Store(':memory:');
  const settings = store.getSettings();
  settings.ai.provider = 'compatible'; settings.ai.compatible.preset = 'lmstudio';
  Object.assign(settings.ai.compatible.profiles.lmstudio, { model: 'fixture', contextTokens: 4096, contextExplicit: true });
  store.saveSettings(settings);
  store.createSession({ id: 'long-line', title: 'Long passage', type: 'advisor', audio_source: 'mic' });
  const text = '甲乙🌱'.repeat(6000);
  const line = store.addSegment({ session_id: 'long-line', t_start: 0, t_end: 5000, text, lang: 'zh', source: 'mic', run: 1 });
  const registry = new ProviderRegistry(store);
  const parts: string[] = [];
  registry.providers.compatible = new CompatibleProvider(() => settings.ai.compatible, { readKey: async () => null, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.ok(estimateContextTokens(body.messages[0].content + '\n' + body.messages[1].content) + body.max_tokens <= 4096);
    const chunk = body.messages[1].content.split('TRANSCRIPT CHUNK:\n')[1];
    if (chunk !== undefined) {
      assert.equal(digests(store, 'long-line').length, 0, 'coverage is saved only after the whole line is digested');
      parts.push(chunk.replace(/^\[0:00\] /, ''));
    }
    return Response.json({ choices: [{ message: { content: 'Notes [0:00].' }, finish_reason: 'stop' }] });
  } });
  const assistant = new Assistant(store, registry, () => {});
  t.after(async () => { assistant.cancelSession('long-line'); await registry.shutdown(); store.close(); });
  const id = assistant.summary('long-line');
  await until(() => store.getOutput(id)!.status === 'done' || store.getOutput(id)!.status === 'error');
  assert.equal(store.getOutput(id)!.status, 'done', store.getOutput(id)!.error ?? '');
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), text);
  assert.deepEqual(digests(store, 'long-line').flatMap((d) => d.segmentIds), [line.id]);
});
