import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ClaudeCliProvider } from '../server/ai/claude-cli.ts';
import { ProviderError } from '../server/ai/provider.ts';

/** A stand-in `claude` on PATH: signed in with a plan, and `-p` behaves as FAKE_CLAUDE_MODE says. */
const BIN = mkdtempSync(join(tmpdir(), 'chumi-fake-claude-'));
const PID_FILE = join(BIN, 'pid');
writeFileSync(join(BIN, 'claude'), `#!/usr/bin/env node
const { spawn } = require('node:child_process');
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); return; }
require('node:fs').writeFileSync(${JSON.stringify(PID_FILE)}, String(process.pid));
const result = JSON.stringify({ type: 'result', is_error: false, result: 'The answer [0:01].' });
const mode = process.env.FAKE_CLAUDE_MODE;
process.stdin.resume();
process.stdin.on('end', () => {
  if (mode === 'late') {
    // The CLI exits first; a process it started still holds stdout and writes the result line afterwards.
    spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 300)', result], { stdio: ['ignore', 'inherit', 'ignore'] }).unref();
    process.exit(0);
  }
  if (mode === 'no-newline') { process.stdout.write(result); return; }
  if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
});
`, { mode: 0o755 });
process.env.PATH = `${BIN}${delimiter}${process.env.PATH}`;
test.after(() => rmSync(BIN, { recursive: true, force: true }));

const request = { task: 'answer', instructions: 'Answer.', input: 'What did we agree?' };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

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
