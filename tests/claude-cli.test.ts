import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ProviderError } from '../server/ai/provider.ts';

/** A stand-in `claude` on PATH: signed in with a plan, and `-p` behaves as FAKE_CLAUDE_MODE says. */
const BIN = mkdtempSync(join(tmpdir(), 'chumi-fake-claude-'));
process.env.CHUMI_DATA_DIR = BIN;
process.env.HOME = BIN;
for (const root of ['ai-workdir', 'claude-prompts']) {
  const stale = join(BIN, root, 'claude-prompt-stale');
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'system.txt'), 'old instructions');
}
const { ClaudeCliProvider } = await import('../server/ai/claude-cli.ts');
const PID_FILE = join(BIN, 'pid');
writeFileSync(join(BIN, 'claude'), `#!/usr/bin/env node
const { spawn } = require('node:child_process');
if (process.argv[2] === 'auth') {
  const mode = process.env.FAKE_CLAUDE_AUTH;
  if (mode === 'slow') { setTimeout(() => console.log('{}'), 30000); return; }
  if (mode === 'text') { console.log('Logged in with Claude'); return; }
  if (mode === 'missing') { console.log('{}'); return; }
  if (mode === 'null') { console.log('null'); return; }
  if (mode === 'string') { console.log('{\"loggedIn\":\"false\"}'); return; }
  if (mode === 'signed-out') { console.log(JSON.stringify({ loggedIn: false })); process.exitCode = 1; return; }
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
  if (mode === 'error') process.exitCode = 2;
  return;
}
require('node:fs').writeFileSync(${JSON.stringify(PID_FILE)}, String(process.pid));
const promptFile = process.argv[process.argv.indexOf('--system-prompt-file') + 1];
require('node:fs').writeFileSync(${JSON.stringify(join(BIN, 'prompt.json'))}, JSON.stringify({ args: process.argv.slice(2), path: promptFile, text: require('node:fs').readFileSync(promptFile, 'utf8'), mode: require('node:fs').statSync(promptFile).mode & 0o777 }));
const result = JSON.stringify({ type: 'result', is_error: false, result: 'The answer [0:01].' });
const mode = process.env.FAKE_CLAUDE_MODE;
process.stdin.resume();
process.stdin.on('end', () => {
  if (mode === 'late') {
    // The CLI exits first; a process it started still holds stdout and writes the result line afterwards.
    const writer = spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 300)', result], { stdio: ['ignore', 'inherit', 'ignore'] });
    writer.once('spawn', () => process.exit(0));
    return;
  }
  if (mode === 'overage' || mode === 'quota') {
    console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', isUsingOverage: mode === 'overage' } }));
    console.log(result); return;
  }
  if (mode === 'cjk') {
    const bytes = Buffer.from(JSON.stringify({ type: 'result', result: '你好🌱'.repeat(10000) }));
    const split = bytes.indexOf(Buffer.from('你')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 30);
    return;
  }
  if (mode === 'no-newline') { process.stdout.write(result); return; }
  if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
});
`, { mode: 0o755 });
if (process.platform === 'win32') writeFileSync(join(BIN, 'claude.cmd'), `@"${process.execPath}" "${join(BIN, 'claude')}" %*\r\n`);
process.env.PATH = `${BIN}${delimiter}${process.env.PATH}`;
test.after(() => rmSync(BIN, { recursive: true, force: true }));

const request = { task: 'answer', instructions: 'Answer.', input: 'What did we agree?' };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('startup clears leftover prompt files from both the private and legacy locations', () => {
  new ClaudeCliProvider(() => ({ model: 'sonnet' }));
  for (const root of ['ai-workdir', 'claude-prompts']) assert.equal(existsSync(join(BIN, root, 'claude-prompt-stale')), false);
});

test('the result line is read even when it arrives after the CLI exits', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  process.env.FAKE_CLAUDE_MODE = 'late';
  const r = await new ClaudeCliProvider(() => ({ model: 'sonnet' })).complete(request);
  assert.equal(r.text, 'The answer [0:01].');
});

test('a final line without a trailing newline is not lost', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  process.env.FAKE_CLAUDE_MODE = 'no-newline';
  const r = await new ClaudeCliProvider(() => ({ model: 'sonnet' })).complete(request);
  assert.equal(r.text, 'The answer [0:01].');
});

test('a hung CLI is killed after the idle timeout, even if it ignores SIGTERM', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  process.env.FAKE_CLAUDE_MODE = 'hang';
  const provider = new ClaudeCliProvider(() => ({ model: 'sonnet' }), { idleMs: 300 });
  await assert.rejects(provider.complete(request), (e: unknown) => e instanceof ProviderError && e.kind === 'network' && /sent nothing/.test(e.message));
  assert.equal(alive(Number(readFileSync(PID_FILE, 'utf8'))), false, 'the child is gone');
});


test('long Claude results preserve CJK characters split between pipe reads', { skip: process.platform === 'win32' }, async () => {
  process.env.FAKE_CLAUDE_MODE = 'cjk';
  const r = await new ClaudeCliProvider(() => ({ model: 'sonnet' })).complete(request);
  assert.equal(r.text, '你好🌱'.repeat(10000));
});


test('an explicit resume clears the Claude overage block and stale overage rate status', { skip: process.platform === 'win32' }, async () => {
  process.env.FAKE_CLAUDE_MODE = 'overage';
  const provider = new ClaudeCliProvider(() => ({ model: 'sonnet' }));
  await assert.rejects(provider.complete(request), { kind: 'quota_gate' });
  assert.equal((await provider.status(true)).state, 'quota_blocked');
  assert.equal((await provider.status()).overageBlocked, true);
  assert.match((await provider.status()).message ?? '', /Resume Claude requests/);
  process.env.FAKE_CLAUDE_MODE = 'no-newline';
  await assert.rejects(provider.complete(request), { kind: 'quota_gate' });
  provider.clearOverageBlock();
  assert.equal((await provider.status(true)).ready, true);
  assert.equal((await provider.complete(request)).text, 'The answer [0:01].');
});


test('Claude receives long multiline instructions through a private temporary file, keeping argv short', async () => {
  process.env.FAKE_CLAUDE_MODE = 'no-newline';
  const instructions = 'Follow the meeting rules.\n中文指令 \"quoted\" $HOME & < > | ^ % !\n'.repeat(1000);
  const provider = new ClaudeCliProvider(() => ({ model: 'sonnet' }));
  await provider.complete({ ...request, instructions });
  const prompt = JSON.parse(readFileSync(join(BIN, 'prompt.json'), 'utf8'));
  assert.equal(prompt.text, instructions);
  assert.ok(prompt.args.includes('--system-prompt-file'));
  assert.ok(prompt.args.includes('--strict-mcp-config'));
  assert.ok(prompt.args.includes('--no-session-persistence'));
  assert.ok(prompt.args.every((arg: string) => !/[\r\n]/.test(arg)));
  assert.ok(prompt.args.join(' ').length < 2000);
  if (process.platform !== 'win32') assert.equal(prompt.mode, 0o600);
  assert.equal(existsSync(prompt.path), false);
  assert.ok(prompt.path.startsWith(join(BIN, 'claude-prompts')));
  assert.ok(!prompt.path.startsWith(join(BIN, 'ai-workdir')));
  await assert.rejects(provider.complete({ ...request, signal: AbortSignal.abort() }), { kind: 'aborted' });
  assert.equal(readdirSync(join(BIN, 'ai-workdir')).filter((name) => name.startsWith('claude-prompt-')).length, 0);
});


test('unreadable, failed and timed-out Claude auth checks report an error instead of signed out', { skip: process.platform === 'win32' }, async () => {
  try {
    const provider = new ClaudeCliProvider(() => ({ model: 'sonnet' }), { authMs: 10000 });
    for (const mode of ['text', 'missing', 'null', 'string', 'error']) {
      process.env.FAKE_CLAUDE_AUTH = mode;
      const status = await provider.status(true);
      assert.equal(status.state, 'error', mode);
      assert.equal(status.ready, false);
      assert.match(status.message ?? '', /claude update/);
      assert.ok(!status.setupHint?.includes('auth login'));
    }
    process.env.FAKE_CLAUDE_AUTH = 'slow';
    const slow = new ClaudeCliProvider(() => ({ model: 'sonnet' }), { authMs: 300 });
    assert.equal((await slow.status(true)).state, 'error');
    process.env.FAKE_CLAUDE_AUTH = 'signed-out';
    assert.equal((await provider.status(true)).state, 'signed_out');
    process.env.FAKE_CLAUDE_AUTH = '';
    assert.equal((await provider.status(true)).ready, true);
  } finally { delete process.env.FAKE_CLAUDE_AUTH; }
});


test('a plain Claude rate limit does not offer overage resume', { skip: process.platform === 'win32' }, async () => {
  process.env.FAKE_CLAUDE_MODE = 'quota';
  const provider = new ClaudeCliProvider(() => ({ model: 'sonnet' }));
  await provider.complete(request);
  const status = await provider.status(true);
  assert.equal(status.state, 'quota_blocked');
  assert.notEqual(status.overageBlocked, true);
  provider.clearOverageBlock();
  assert.equal((await provider.status(true)).state, 'quota_blocked');
});

test('a locked prompt file does not turn a successful Claude answer into a failure', { skip: process.platform === 'win32' }, async (t) => {
  process.env.FAKE_CLAUDE_MODE = 'no-newline';
  const remove = fs.rmSync;
  const mock = t.mock.method(fs, 'rmSync', (path: Parameters<typeof fs.rmSync>[0], options: Parameters<typeof fs.rmSync>[1]) => {
    if (String(path).includes('claude-prompt-')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return remove(path, options);
  });
  syncBuiltinESMExports();
  try {
    const result = await new ClaudeCliProvider(() => ({ model: 'sonnet' })).complete(request);
    assert.equal(result.text, 'The answer [0:01].');
  } finally {
    mock.mock.restore(); syncBuiltinESMExports();
    for (const name of readdirSync(join(BIN, 'claude-prompts'))) remove(join(BIN, 'claude-prompts', name), { recursive: true, force: true });
  }
});
