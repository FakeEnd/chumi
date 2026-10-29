import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'chumi-codex-process-'));
process.env.CHUMI_DATA_DIR = dir;
process.env.HOME = dir;
process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
const { CodexProvider } = await import('../server/ai/codex.ts');
test.after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'codex'), `#!/usr/bin/env node
if (process.argv[2] === 'features') { console.log('shell_tool stable false'); return; }
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id == null) return;
  if (m.method === 'initialize' && process.env.FAKE_CODEX_MODE === 'init-hang') return;
  let result = {};
  if (m.method === 'account/read') result = { account: { type: 'chatgpt' } };
  if (m.method === 'account/rateLimits/read') result = { ordinaryUsageAllowed: true, rateLimits: { primary: null, secondary: null } };
  if (m.method === 'model/list') result = { data: [] };
  if (m.method === 'thread/start') result = { thread: { id: 't' } };
  if (m.method === 'turn/start') result = { turn: { id: 'u' } };
  send({ id: m.id, result });
  if (m.method === 'turn/start') {
    const bytes = Buffer.from(JSON.stringify({ method: 'item/completed', params: { threadId: 't', item: { type: 'agentMessage', text: '你好🌱'.repeat(10000) } } }) + '\\n');
    const split = bytes.indexOf(Buffer.from('你')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => { process.stdout.write(bytes.subarray(split)); send({ method: 'turn/completed', params: { threadId: 't', turn: { status: 'completed' } } }); }, 30);
  }
});
`, { mode: 0o755 });

test('Codex completed items preserve CJK characters split between pipe reads', { skip: process.platform === 'win32' }, async () => {
  const provider = new CodexProvider(() => ({ model: 'fixture', allowCredits: false }));
  try {
    const result = await provider.complete({ task: 'ask', instructions: 'Answer.', input: 'Synthetic meeting.' });
    assert.equal(result.text, '你好🌱'.repeat(10000));
  } finally { await provider.shutdown(); }
});


test('failed Codex initialization stops its child and old events cannot break the replacement', { skip: process.platform === 'win32', timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  process.env.FAKE_CODEX_MODE = 'init-hang';
  const provider = new CodexProvider(() => ({ model: 'fixture', allowCredits: false }));
  const transport = provider as unknown as { proc: ChildProcess | null; ensure(): Promise<void>; request(method: string, params: unknown, timeout?: number): Promise<any> };
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const request = transport.request.bind(transport);
  let first: ChildProcess | null = null;
  let exited: Promise<unknown> | undefined;
  t.mock.method(transport, 'request', (method: string, params: unknown, timeout?: number) => {
    if (method === 'initialize' && !first) { first = transport.proc; exited = once(first!, 'exit'); entered(); }
    return request(method, params, timeout);
  });
  try {
    const initializing = transport.ensure();
    assert.equal(transport.ensure(), initializing, 'concurrent callers share startup even before the child exists');
    const rejected = assert.rejects(initializing, /initialize timed out/);
    await started;
    t.mock.timers.tick(20_000);
    await rejected;
    await exited;
    assert.equal(transport.proc, null);
    process.env.FAKE_CODEX_MODE = '';
    await transport.ensure();
    const replacement = transport.proc;
    assert.ok(replacement && replacement !== first);
    (first as unknown as ChildProcess).emit('exit', 1);
    (first as unknown as ChildProcess).emit('error', new Error('late process error'));
    (first as unknown as ChildProcess).stdout!.emit('data', '{"id":999,"result":{}}\n');
    assert.equal(transport.proc, replacement);
    const result = await provider.complete({ task: 'ask', instructions: 'Answer.', input: 'Synthetic meeting.' });
    assert.equal(result.text, '你好🌱'.repeat(10000));
  } finally { process.env.FAKE_CODEX_MODE = ''; await provider.shutdown(); }
});

test('Codex spawn errors reject startup and stdin errors settle pending requests', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const provider = new CodexProvider(() => ({ model: 'fixture', allowCredits: false }));
  const transport = provider as unknown as { proc: ChildProcess | null; ensure(): Promise<void>; request(method: string, params: unknown): Promise<any> };
  try {
    chmodSync(join(dir, 'codex'), 0o600);
    await assert.rejects(transport.ensure(), /Could not start Codex/);
    assert.equal(transport.proc, null);
    chmodSync(join(dir, 'codex'), 0o755);
    await transport.ensure();
    const proc = transport.proc!;
    const closed = once(proc, 'exit');
    const rejected = assert.rejects(transport.request('fixture/pending', {}), /connection to Codex/);
    proc.stdin!.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    await rejected; await closed;
    assert.equal(transport.proc, null);
    await transport.ensure();
    assert.ok(transport.proc);
  } finally { chmodSync(join(dir, 'codex'), 0o755); await provider.shutdown(); }
});
