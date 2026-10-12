import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'chumi-agent-check-'));
process.env.CHUMI_DATA_DIR = DATA;
process.env.XDG_CONFIG_HOME = join(DATA, 'config');
const { Store } = await import('../server/db.ts');
const { AgentIntegration, MCP_SCRIPT, parseJsonc } = await import('../server/projects/agents.ts');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

// Like Codex exec with piped stdin, this CLI waits for EOF even when given a prompt argument.
// It answers the way each agent's command would, records the read under that agent's MCP client name,
// and refuses to record it when an API key reaches a plan agent (or is missing for an API-key agent).
// It uses only a temporary database; no installed agent, credentials or model requests are involved.
function fixtureCli(name: string, recordRead: boolean): string {
  const path = join(DATA, name);
  writeFileSync(path, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'mcp' && args[1] === 'list') { console.log('●  ✓ chumi connected'); process.exit(0); }
const timer = setTimeout(() => {
  console.error('Reading additional input from stdin... (stdin was left open)');
  process.exit(1);
}, 2000);
process.stdin.resume();
process.stdin.on('end', async () => {
  clearTimeout(timer);
  if ((await import('node:fs')).readdirSync(process.cwd()).length) { console.log('the read check ran in a folder with files in it'); return; }
  const prompt = args.find(arg => arg.startsWith('Call the MCP tool '));
  const token = prompt?.match(/with token "([^"]+)"/)?.[1];
  if (!token) throw new Error('Missing verification prompt');
  const client = args[0] === 'exec' ? 'codex-mcp-client' : args[0] === 'run' ? 'opencode'
    : args.includes('--allowed-mcp-server-names') ? 'qwen-cli-mcp-client-chumi' : 'claude-code';
  const plan = client === 'codex-mcp-client' || client === 'claude-code';
  if (plan && process.env.OPENAI_API_KEY) { console.log('an API key reached a plan agent'); return; }
  if (!plan && !process.env.OPENAI_API_KEY) { console.log('the API key of an API-key agent was removed'); return; }
  if (client === 'opencode' && JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}').tools?.['*'] !== false) { console.log('tools not restricted'); return; }
  if (${recordRead}) {
    const { Store } = await import(${JSON.stringify(new URL('../server/db.ts', import.meta.url).href)});
    const store = new Store();
    store.recordAgentRead({ client, tool: 'connection_check', token, project_id: null, session_id: null, handoff_id: null, revision: null });
    store.close();
  }
  console.log('OK');
});
`, { mode: 0o755 });
  return path;
}

test('agent read checks close stdin, keep plan agents away from API keys, and match each client', async () => {
  const store = new Store();
  process.env.OPENAI_API_KEY = 'sk-test-only';
  try {
    const integration = new AgentIntegration(store);
    integration.cli = () => fixtureCli('reads-after-eof', true);
    for (const agent of ['codex', 'claude-code', 'opencode', 'qwen-code'] as const) {
      const result = await integration.verify(agent);
      assert.equal(result.ok, true, `${agent}: ${result.detail}`);
      assert.match(result.detail, /read Chumi's data through MCP/);
      assert.ok((await integration.status(agent)).verifiedAt, `${agent}: the read is attributed to it`);
    }
  } finally {
    delete process.env.OPENAI_API_KEY;
    store.close();
  }
});

test('a successful CLI reply without a matching read does not verify the connection', async () => {
  const store = new Store();
  try {
    const integration = new AgentIntegration(store);
    integration.cli = () => fixtureCli('replies-without-reading', false);
    const result = await integration.verify('codex');
    assert.equal(result.ok, false);
    assert.equal(result.detail, 'No read was recorded. The agent said: OK');
  } finally {
    store.close();
  }
});

test('opencode: connecting edits opencode.json only, keeps other settings, and leaves a commented opencode.jsonc alone', async () => {
  const store = new Store();
  const dir = join(DATA, 'config', 'opencode');
  mkdirSync(dir, { recursive: true });
  const jsonc = '// my settings\n{ "model": "x/y", }\n';
  writeFileSync(join(dir, 'opencode.jsonc'), jsonc);
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ theme: 'dark', mcp: { other: { type: 'remote', url: 'https://example.com' } } }));
  try {
    const integration = new AgentIntegration(store);
    integration.cli = () => fixtureCli('opencode-list', false);
    assert.equal((await integration.status('opencode')).registered, false);
    await integration.connect('opencode');
    const cfg = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'));
    assert.equal(cfg.theme, 'dark');
    assert.ok(cfg.mcp.other, 'other servers stay');
    assert.equal(cfg.mcp.chumi.type, 'local');
    assert.deepEqual(cfg.mcp.chumi.command.slice(1), [MCP_SCRIPT]);
    assert.equal(cfg.mcp.chumi.environment.CHUMI_DATA_DIR, DATA);
    assert.equal(readFileSync(join(dir, 'opencode.jsonc'), 'utf8'), jsonc);
    const st = await integration.status('opencode');
    assert.equal(st.registered, true);
    assert.equal(st.outdated, false);
    assert.equal(st.clientHealth, 'connected');
    await integration.disconnect('opencode');
    const after = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'));
    assert.equal(after.mcp.chumi, undefined);
    assert.ok(after.mcp.other);
    assert.equal((await integration.status('opencode')).registered, false);
  } finally {
    store.close();
  }
});

test('JSONC: comments and trailing commas are ignored, comment markers inside strings are kept', () => {
  assert.deepEqual(parseJsonc('// a\n{ "u": "http://x/*y*/", /* b */ "n": [1, 2,], }'), { u: 'http://x/*y*/', n: [1, 2] });
  assert.deepEqual(parseJsonc('{"s": "quote \\" // not a comment"}'), { s: 'quote " // not a comment' });
  assert.deepEqual(parseJsonc('{"i": "use {a, }", "j": "[1, ]", "k": [1, // last\n], }'), { i: 'use {a, }', j: '[1, ]', k: [1] }, 'commas inside strings are text');
});

test('opencode.json is only rewritten when it is plain JSON; the rewrite keeps its mode and a backup', async () => {
  const store = new Store();
  const dir = join(DATA, 'config', 'opencode');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'opencode.json');
  rmSync(join(dir, 'opencode.jsonc'), { force: true });
  try {
    const integration = new AgentIntegration(store);
    integration.cli = () => fixtureCli('opencode-strict', false);
    for (const text of ['{\n  // my provider\n  "model": "x/y",\n}\n', '[]\n']) {
      writeFileSync(file, text);
      await assert.rejects(integration.connect('opencode'), /did not change/);
      assert.equal(readFileSync(file, 'utf8'), text, 'a commented or unexpected file is left byte for byte');
    }
    writeFileSync(file, '{"model": "x/y"}');
    chmodSync(file, 0o600);
    await integration.connect('opencode');
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the file may hold API keys: its mode is kept');
    assert.equal(readFileSync(`${file}.bak`, 'utf8'), '{"model": "x/y"}');
    assert.equal(statSync(`${file}.bak`).mode & 0o777, 0o600, 'and so is the backup');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).model, 'x/y');
  } finally {
    store.close();
  }
});

test('continuing starts each agent in the project folder with the whole handoff as its first message', async () => {
  const { execFileSync } = await import('node:child_process');
  const { realpathSync } = await import('node:fs');
  const store = new Store();
  const workspace = mkdtempSync(join(DATA, 'project with spaces '));
  const log = join(DATA, 'launch.json');
  // Records how the agent was started instead of starting it.
  const recorder = join(DATA, 'recorder');
  writeFileSync(recorder, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n`, { mode: 0o755 });
  const prompt = 'Continue work from a meeting.\n\n1. Rerun with the "held-out" split; don\'t touch $HOME or `backticks`.';
  try {
    const integration = new AgentIntegration(store);
    integration.cli = () => recorder;
    const expected: Record<string, (ws: string) => string[]> = {
      'claude-code': () => [prompt], codex: (ws) => ['-C', ws, prompt], opencode: (ws) => [ws, '--prompt', prompt], 'qwen-code': () => ['-i', prompt],
    };
    for (const [agent, args] of Object.entries(expected)) {
      const script = integration.launchScript(agent as 'codex', 'hnd_test', workspace, prompt);
      execFileSync('/bin/zsh', [script]);
      const got = JSON.parse(readFileSync(log, 'utf8')) as { cwd: string; args: string[] };
      assert.equal(realpathSync(got.cwd), realpathSync(workspace), `${agent} starts in the project folder`);
      assert.deepEqual(got.args, args(workspace), `${agent} receives the handoff unchanged`);
    }
  } finally {
    store.close();
  }
});
