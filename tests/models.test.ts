import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

// A local server stands in for Hugging Face, so tests never download real models.
const payload = Buffer.alloc(300_000, 7);
const server = createServer((req, res) => {
  if (req.url?.endsWith('/ggml-tiny-q5_1.bin') || req.url?.endsWith('/ggml-medium-q5_0.bin')) { res.writeHead(200, { 'content-length': payload.length }); res.end(payload); return; }
  if (req.url?.endsWith('/ggml-base-q5_1.bin')) { // stalls after half, so it can be cancelled
    res.writeHead(200, { 'content-length': payload.length }); res.write(payload.subarray(0, 150_000)); return;
  }
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const modelsDir = mkdtempSync(join(tmpdir(), 'chumi-models-'));
process.env.CHUMI_MODEL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/m`;
process.env.CHUMI_MODELS_DIR = modelsDir;
const { MODEL_CATALOG, ModelDownloader, recommendModel, textAccuracy } = await import('../server/asr/models.ts');
// The stand-in tiny model is the payload; every other model keeps its real checksum, which the payload fails.
MODEL_CATALOG.find((m) => m.id === 'ggml-tiny-q5_1.bin')!.sha256 = createHash('sha256').update(payload).digest('hex');

test.after(() => server.close());

test('recommends a model that fits the hardware', () => {
  assert.equal(recommendModel({ chip: 'Apple M5 Max', appleSilicon: true, memoryGB: 64, cores: 18 }), 'ggml-large-v3-turbo-q8_0.bin');
  assert.equal(recommendModel({ chip: 'Apple M1', appleSilicon: true, memoryGB: 8, cores: 8 }), 'ggml-large-v3-turbo-q5_0.bin');
  assert.equal(recommendModel({ chip: 'Intel Core i7', appleSilicon: false, memoryGB: 16, cores: 8 }), 'ggml-small-q5_1.bin');
  assert.equal(recommendModel({ chip: 'Intel Core i5', appleSilicon: false, memoryGB: 8, cores: 4 }), 'ggml-base-q5_1.bin');
  assert.equal(recommendModel({ chip: 'Intel Core i9-12900H', appleSilicon: false, memoryGB: 48, cores: 20, gpu: { name: 'NVIDIA GeForce RTX 3060 Laptop GPU', memoryGB: 6 } }), 'ggml-large-v3-turbo-q8_0.bin');
  assert.equal(recommendModel({ chip: 'Intel Core i5', appleSilicon: false, memoryGB: 16, cores: 4, gpu: { name: 'NVIDIA GeForce MX150', memoryGB: 2 } }), 'ggml-small-q5_1.bin');
  for (const m of MODEL_CATALOG) assert.ok(m.note.en && m.note.zh, `${m.id} needs notes in both languages`);
  for (const m of MODEL_CATALOG) assert.match(m.sha256, /^[0-9a-f]{64}$/, `${m.id} needs a SHA-256`);
});

test('text accuracy ignores case, spacing and punctuation', () => {
  assert.equal(textAccuracy('Hello, World!', 'hello world'), 1);
  assert.equal(textAccuracy('我们用三个重复', '我们用三个生物学重复'), 0.7);
  assert.equal(textAccuracy('', 'abc'), 0);
});

test('downloads a model to a .part file, then renames it', async () => {
  const d = new ModelDownloader();
  const seen: string[] = [];
  d.on('progress', (s) => seen.push(s.status));
  await d.start('ggml-tiny-q5_1.bin');
  assert.equal(d.current?.status, 'done');
  assert.equal(d.current?.received, payload.length);
  assert.deepEqual(readFileSync(join(modelsDir, 'ggml-tiny-q5_1.bin')), payload);
  assert.ok(!readdirSync(modelsDir).some((f) => f.endsWith('.part')));
  assert.equal(seen.at(-1), 'done');
});

test('a failed download leaves nothing behind', async () => {
  const d = new ModelDownloader();
  await d.start('ggml-small-q5_1.bin'); // mock server answers 404
  assert.equal(d.current?.status, 'error');
  assert.match(d.current?.error ?? '', /404/);
  assert.ok(!existsSync(join(modelsDir, 'ggml-small-q5_1.bin')) && !existsSync(join(modelsDir, 'ggml-small-q5_1.bin.part')));
});

test('a download that does not match its checksum is discarded', async () => {
  const d = new ModelDownloader();
  await d.start('ggml-medium-q5_0.bin'); // complete, but not the published file
  assert.equal(d.current?.status, 'error');
  assert.match(d.current?.error ?? '', /SHA-256/);
  assert.ok(!existsSync(join(modelsDir, 'ggml-medium-q5_0.bin')) && !existsSync(join(modelsDir, 'ggml-medium-q5_0.bin.part')));
});

test('cancelling stops the download and removes the partial file', async () => {
  const d = new ModelDownloader();
  const done = d.start('ggml-base-q5_1.bin');
  await new Promise<void>((r) => { const tick = () => (d.current && d.current.received > 0 ? r() : setTimeout(tick, 10)); tick(); });
  await assert.rejects(d.start('ggml-tiny-q5_1.bin'), /already downloading/);
  d.cancel();
  await done;
  assert.equal(d.current?.status, 'cancelled');
  assert.ok(!existsSync(join(modelsDir, 'ggml-base-q5_1.bin')) && !existsSync(join(modelsDir, 'ggml-base-q5_1.bin.part')));
});

test('rejects unknown model ids', async () => {
  await assert.rejects(new ModelDownloader().start('../../etc/passwd'), /Unknown model/);
});
