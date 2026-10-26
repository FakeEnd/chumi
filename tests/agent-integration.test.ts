import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'chumi-agent-check-'));
process.env.CHUMI_DATA_DIR = DATA;
process.env.XDG_CONFIG_HOME = join(DATA, 'config');
process.env.DSH_HOME = join(DATA, 'dsh-home');
const { Store } = await import('../server/db.ts');
const { AgentIntegration, MCP_SCRIPT, parseJsonc } = await import('../server/projects/agents.ts');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const WIN = process.platform === 'win32';
/** An executable stand-in CLI: a script with a shebang, or on Windows a .cmd shim like the ones npm installs. */
function cliFile(name: string, js: string): string {
  const path = join(DATA, WIN ? `${name}.js` : name);
  writeFileSync(path, WIN ? js : `#!${process.execPath}\n${js}`, { mode: 0o755 });
  if (!WIN) return path;
  writeFileSync(join(DATA, `${name}.cmd`), `@"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
  return join(DATA, `${name}.cmd`);
}

// Like Codex exec with piped stdin, this CLI waits for EOF even when given a prompt argument.
// It answers the way each agent's command would, records the read under that agent's MCP client name,
// and refuses to record it when an API key reaches a plan agent (or is missing for an API-key agent).
// It uses only a temporary database; no installed agent, credentials or model requests are involved.
function fixtureCli(name: string, recordRead: boolean): string {
  return cliFile(name, `const args = process.argv.slice(2);
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
  const client = args[0] === 'exec' ? 'codex-mcp-client' : args[0] === 'run' ? 'opencode' : args[0] === '--profile' ? 'dsh-mcp-client'
    : args.includes('--allowed-mcp-server-names') ? 'qwen-cli-mcp-client-chumi' : args.includes('--allowedTools') ? 'claude-code' : 'antigravity-client';
  const plan = client === 'codex-mcp-client' || client === 'claude-code';
  if (plan && process.env.OPENAI_API_KEY) { console.log('an API key reached a plan agent'); return; }
  if (!plan && !process.env.OPENAI_API_KEY) { console.log('the API key of an API-key agent was removed'); return; }
  if (client === 'opencode' && JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}').tools?.['*'] !== false) { console.log('tools not restricted'); return; }
  if (client === 'dsh-mcp-client') {
    if (args[1] !== 'headless' || process.env.DSH_PERMISSION_MODE !== 'read-only') { console.log('not a read-only headless run'); return; }
    const patch = args[args.indexOf('--patch') + 1];
    if (!(await import('node:fs')).readFileSync(patch, 'utf8').includes('- id: credentials')) { console.log('saved sign-ins are not readable'); return; }
  }
  if (${recordRead}) {
    const { Store } = await import(${JSON.stringify(new URL('../server/db.ts', import.meta.url).href)});
    const store = new Store();
    store.recordAgentRead({ client, tool: 'connection_check', token, project_id: null, session_id: null, handoff_id: null, revision: null });
    store.close();
  }
  console.log('OK');
});
`);
}

test('agent read checks close stdin, keep plan agents away from API keys, and match each client', async () => {
  const store = new Store();
  process.env.OPENAI_API_KEY = 'sk-test-only';
  try {
    const integration = new AgentIntegration(store);
    integration.cli = () => fixtureCli('reads-after-eof', true);
    for (const agent of ['codex', 'claude-code', 'opencode', 'qwen-code', 'antigravity', 'deepseek-harness'] as const) {
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

test('Antigravity: connecting registers the server and pre-approves only the check tool; disconnecting removes both', async () => {
  const store = new Store();
  const home = join(DATA, 'agy-home');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  const mcpConfig = join(home, '.gemini', 'config', 'mcp_config.json');
  const settings = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(settings, JSON.stringify({ colorScheme: 'dark', permissions: { allow: ['command(git status)'] } }));
  // Like `agy mcp add` (which replaces an entry) and `agy mcp remove`.
  const agy = cliFile('agy', `const fs = require('node:fs'), path = require('node:path');
const file = path.join(require('node:os').homedir(), '.gemini', 'config', 'mcp_config.json');
const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { mcpServers: {} };
const [, sub, ...rest] = process.argv.slice(2);
if (sub === 'add') {
  const env = {};
  while (rest[0] === '-e') { const kv = rest[1]; env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1); rest.splice(0, 2); }
  const name = rest.shift(); if (rest[0] === '--') rest.shift();
  cfg.mcpServers[name] = { command: rest[0], args: rest.slice(1), disabled: false, ...(Object.keys(env).length ? { env } : {}) };
} else if (sub === 'remove') {
  if (!cfg.mcpServers[rest[0]]) { console.error('not found'); process.exit(1); }
  delete cfg.mcpServers[rest[0]];
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(cfg));
`);
  try {
    const integration = new AgentIntegration(store);
    integration.cli = () => agy;
    assert.equal((await integration.status('antigravity')).registered, false);
    await integration.connect('antigravity');
    await integration.connect('antigravity');
    const entry = JSON.parse(readFileSync(mcpConfig, 'utf8')).mcpServers.chumi;
    assert.deepEqual(entry.args, [MCP_SCRIPT]);
    assert.equal(entry.env.CHUMI_DATA_DIR, DATA);
    const cfg = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(cfg.colorScheme, 'dark', 'other settings stay');
    assert.deepEqual(cfg.permissions.allow, ['command(git status)', 'mcp(chumi/chumi_connection_check)'], 'only the check tool, added once');
    const st = await integration.status('antigravity');
    assert.equal(st.registered, true);
    assert.equal(st.outdated, false);
    assert.equal(st.clientHealth, 'unknown');
    await integration.disconnect('antigravity');
    assert.equal(JSON.parse(readFileSync(mcpConfig, 'utf8')).mcpServers.chumi, undefined);
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).permissions.allow, ['command(git status)'], 'the user\'s own rules stay');
    assert.equal((await integration.status('antigravity')).registered, false);
  } finally {
    Object.assign(process.env, saved);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    store.close();
  }
});

/** Like `dsh --profile headless --dump-config`: prints the home patch layer (as dsh would compose it), or fails like a bad layer. */
function dshCli(fail = false): string {
  return cliFile(fail ? 'dsh-bad' : 'dsh', `const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args.join(' ') !== '--profile headless --dump-config') { console.error('unexpected ' + args.join(' ')); process.exit(2); }
// A rejected layer: dsh's own message, then a Node stack trace (as the real CLI prints it).
if (${fail}) { console.error('file:///dsh/cli.js:120\\n  throw e;\\nError: dsh: failed to parse patches: invalid entry\\n    at boot (file:///dsh/cli.js:115:2)\\n\\nNode.js v24.0.0'); process.exit(1); }
console.log(fs.readFileSync(path.join(process.env.DSH_HOME, 'cordis.patch.yml'), 'utf8'));
`);
}

test('DeepSeek Harness: Connect adds one block to the home patch layer, keeps everything else, and Disconnect takes only it out', async () => {
  const store = new Store();
  const file = join(DATA, 'dsh-home', 'cordis.patch.yml');
  mkdirSync(join(DATA, 'dsh-home'), { recursive: true });
  const mine = '# my layer\n- id: agent-default-model\n  config:\n    provider: deepseek-account # signed in\n    model: deepseek-flash\n';
  writeFileSync(file, mine, { mode: 0o600 });
  try {
    const integration = new AgentIntegration(store);
    integration.cli = () => dshCli();
    assert.equal((await integration.status('deepseek-harness')).registered, false);
    await integration.connect('deepseek-harness');
    await integration.connect('deepseek-harness');
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith(mine), 'the user\'s entries and comments stay as they were');
    assert.equal(text.match(/# >>> chumi/g)?.length, 1, 'reconnecting replaces the block');
    assert.ok(text.includes(`args: ${JSON.stringify([MCP_SCRIPT])}`), 'the server is this copy of Chumi');
    assert.match(text, /env: \{"CHUMI_DATA_DIR":/);
    if (!WIN) assert.equal(statSync(file).mode & 0o777, 0o600, 'dsh keeps this file private');
    const st = await integration.status('deepseek-harness');
    assert.equal(st.registered, true);
    assert.equal(st.outdated, false);
    assert.equal(st.clientHealth, 'unknown');
    await integration.disconnect('deepseek-harness');
    assert.equal(readFileSync(file, 'utf8'), mine);
    assert.equal((await integration.status('deepseek-harness')).registered, false);

    writeFileSync(file, '# empty\n[]\n');
    await integration.connect('deepseek-harness');
    assert.match(readFileSync(file, 'utf8'), /^# empty\n# >>> chumi[^\n]*\n- insert:/, 'an empty list is filled, not appended to');
    await integration.disconnect('deepseek-harness');
    assert.equal(readFileSync(file, 'utf8'), '# empty\n[]\n');
  } finally {
    store.close();
  }
});

test('DeepSeek Harness: YAML Chumi cannot safely extend, a chumi server added by hand, or a layer dsh rejects leave the file as it was', async () => {
  const store = new Store();
  const file = join(DATA, 'dsh-home', 'cordis.patch.yml');
  mkdirSync(join(DATA, 'dsh-home'), { recursive: true });
  try {
    const integration = new AgentIntegration(store);
    integration.cli = () => dshCli();
    for (const text of ['[{ id: x, disabled: true }]\n', 'key: value\n']) {
      writeFileSync(file, text);
      await assert.rejects(integration.connect('deepseek-harness'), /did not change/);
      assert.equal(readFileSync(file, 'utf8'), text);
    }
    const byHand = '- insert:\n    - id: mine\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: chumi\n        command: node\n';
    writeFileSync(file, byHand);
    const st = await integration.status('deepseek-harness');
    assert.equal(st.registered, true);
    assert.match(st.detail ?? '', /outside Chumi; Chumi leaves it to you/);
    await assert.rejects(integration.connect('deepseek-harness'), /already has a server named chumi/);
    await integration.disconnect('deepseek-harness');
    assert.equal(readFileSync(file, 'utf8'), byHand, 'Disconnect leaves an entry Chumi did not write');

    writeFileSync(file, '- id: x\n  disabled: true\n');
    integration.cli = () => dshCli(true);
    await assert.rejects(integration.connect('deepseek-harness'), /did not accept the new entry, so .* was restored\. Error: dsh: failed to parse patches: invalid entry$/);
    assert.equal(readFileSync(file, 'utf8'), '- id: x\n  disabled: true\n', 'restored after dsh failed to compose it');
    assert.equal(readFileSync(`${file}.bak`, 'utf8'), '- id: x\n  disabled: true\n', 'and the backup is still the user\'s version');
    rmSync(file);
    await assert.rejects(integration.connect('deepseek-harness'));
    assert.equal(existsSync(file), false, 'a file Chumi created is removed again');

    const flow = '- insert: [{ id: mine, name: "@deepseek-ai/dsh-mcp-client", config: {serverName: chumi, command: node} }]\n';
    writeFileSync(file, flow);
    integration.cli = () => dshCli();
    await assert.rejects(integration.connect('deepseek-harness'), /already has a server named chumi/, 'also in {…} form');
    assert.equal(readFileSync(file, 'utf8'), flow);
    rmSync(file);
    mkdirSync(file);
    await assert.rejects(integration.connect('deepseek-harness'), /EISDIR|directory/i, 'a file that cannot be read is not treated as missing');
    assert.ok(statSync(file).isDirectory());
    assert.equal((await integration.status('deepseek-harness')).registered, null);
    rmSync(file, { recursive: true });
  } finally {
    store.close();
  }
});

test('DeepSeek Harness: the block keeps Windows line endings and paths with quotes, and reads back exactly', async () => {
  const { withDshBlock, withoutDshBlock, splitDshPatch, readDshBlock } = await import('../server/projects/dsh.ts');
  const m = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['E:\\研究 "A"\\server\\mcp\\main.ts'], env: { CHUMI_DATA_DIR: 'D:\\Chumi data' } };
  const mine = '- id: agent-default-model\r\n  config:\r\n    model: deepseek-flash\r\n';
  const text = withDshBlock(mine, m, 'cordis.patch.yml');
  assert.ok(!/[^\r]\n/.test(text), 'CRLF throughout');
  assert.deepEqual(readDshBlock(splitDshPatch(text).block!), m);
  assert.equal(withoutDshBlock(text), mine);
  assert.equal(withoutDshBlock(mine), null);
});

test('DeepSeek Harness: a byte-order mark, a document start, blank lines at the end and a comment on [] all survive', async () => {
  const { withDshBlock, withoutDshBlock, splitDshPatch, handWrittenDsh } = await import('../server/projects/dsh.ts');
  const m = { command: 'node', args: ['main.ts'], env: {} };
  for (const mine of ['\uFEFF- id: x\n  disabled: true\n', '---\n- id: x\n  disabled: true\n', '- id: x\n  disabled: true\n\n\n', '\uFEFF', '']) {
    const text = withDshBlock(mine, m, 'f');
    assert.ok(text.startsWith(mine), JSON.stringify(mine));
    assert.equal(withoutDshBlock(text), mine.replace(/^\uFEFF?$/, (b) => `${b}[]\n`), JSON.stringify(mine));
  }
  const bomBlock = `\uFEFF${withDshBlock('', m, 'f')}`;
  assert.ok(splitDshPatch(bomBlock).block, 'Chumi\'s own block after a byte-order mark is still Chumi\'s');
  assert.equal(handWrittenDsh(splitDshPatch(bomBlock).rest), false);
  const commented = withDshBlock('[] # nothing yet\n', m, 'f');
  assert.match(commented, /^# nothing yet\n# >>> chumi/);
  assert.equal(withoutDshBlock(commented), '# nothing yet\n[]\n');
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
    const mode = statSync(file).mode & 0o777;
    await integration.connect('opencode');
    assert.equal(statSync(file).mode & 0o777, mode, 'the file may hold API keys: its mode is kept');
    assert.equal(readFileSync(`${file}.bak`, 'utf8'), '{"model": "x/y"}');
    assert.equal(statSync(`${file}.bak`).mode & 0o777, mode, 'and so is the backup');
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
  const recorder = cliFile('recorder', `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n`);
  const prompt = 'Continue work from a meeting.\n\n1. Rerun with the "held-out" split; don\'t touch $HOME or `backticks`.';
  try {
    const integration = new AgentIntegration(store);
    integration.cli = () => recorder;
    // cmd.exe cannot pass a multi-line argument: on Windows the agent is pointed at the handoff file instead.
    const message = (agent: string) => (WIN ? `Read the file ${join(DATA, 'handoffs', `hnd_test-${agent}.md`)} and follow the instructions in it.` : prompt);
    const expected: Record<string, (ws: string, m: string) => string[]> = {
      'claude-code': (_ws, m) => [m], codex: (ws, m) => ['-C', ws, m], opencode: (ws, m) => [ws, '--prompt', m], 'qwen-code': (_ws, m) => ['-i', m],
      antigravity: (_ws, m) => ['-i', m],
    };
    assert.throws(() => integration.launchScript('deepseek-harness', 'hnd_test', workspace, prompt), /no terminal session/);
    for (const [agent, args] of Object.entries(expected)) {
      const script = integration.launchScript(agent as 'codex', 'hnd_test', workspace, prompt);
      if (WIN) execFileSync('cmd.exe', ['/d', '/c', script]); else execFileSync('/bin/zsh', [script]);
      assert.equal(readFileSync(join(DATA, 'handoffs', `hnd_test-${agent}.md`), 'utf8'), prompt);
      const got = JSON.parse(readFileSync(log, 'utf8')) as { cwd: string; args: string[] };
      assert.equal(realpathSync(got.cwd), realpathSync(workspace), `${agent} starts in the project folder`);
      assert.deepEqual(got.args, args(workspace, message(agent)), `${agent} receives the handoff unchanged`);
    }
  } finally {
    store.close();
  }
});
