import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'chumi-agent-check-'));
process.env.CHUMI_DATA_DIR = DATA;
process.env.HOME = DATA;
if (process.platform === 'win32') process.env.USERPROFILE = DATA;
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
    integration.cli = async () => fixtureCli('reads-after-eof', true);
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
    integration.cli = async () => fixtureCli('replies-without-reading', false);
    const result = await integration.verify('codex');
    assert.equal(result.ok, false);
    assert.equal(result.detail, 'No read was recorded. The agent said: OK');
  } finally {
    store.close();
  }
});

// Like Claude's commander parser, -e consumes all following values up to the next option or --.
function claudeCli(fail = false): string {
  return cliFile(fail ? 'claude-fail' : 'claude', `const fs = require('node:fs'), path = require('node:path');
const file = path.join(process.env.CLAUDE_CONFIG_DIR || require('node:os').homedir(), '.claude.json');
const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
cfg.mcpServers ||= {};
const [, sub, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(path.dirname(file), 'calls.log'), sub + '\\n');
if (sub === 'remove') {
  if (!cfg.mcpServers[args[0]]) { console.error('not found'); process.exit(1); }
  delete cfg.mcpServers[args[0]];
  fs.writeFileSync(file, JSON.stringify(cfg)); process.exit(0);
}
if (sub !== 'add') { console.error('unexpected command'); process.exit(1); }
const positional = [], env = {};
let command = [];
while (args.length) {
  const arg = args.shift();
  if (arg === '--') { command = args; break; }
  if (arg === '--scope' || arg === '-s') { args.shift(); continue; }
  if (arg === '-e' || arg === '--env') {
    while (args.length && !args[0].startsWith('-')) {
      const kv = args.shift(), i = kv.indexOf('=');
      if (i < 1) { console.error('Invalid environment variable format: ' + kv); process.exit(1); }
      env[kv.slice(0, i)] = kv.slice(i + 1);
    }
  } else positional.push(arg);
}
const name = positional[0];
if (${fail}) { console.error('add failed'); process.exit(1); }
if (!name || !command.length) { console.error('missing name or command'); process.exit(1); }
if (cfg.mcpServers[name]) { console.error('already exists'); process.exit(1); }
cfg.mcpServers[name] = { command: command[0], args: command.slice(1), env };
fs.writeFileSync(file, JSON.stringify(cfg));
`);
}

test('Claude Code: Connect puts the name before greedy env flags and Reconnect replaces an existing registration', async () => {
  const store = new Store();
  const dir = join(DATA, 'claude-config');
  const file = join(dir, '.claude.json');
  const saved = process.env.CLAUDE_CONFIG_DIR;
  mkdirSync(dir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const integration = new AgentIntegration(store);
    integration.cli = async () => claudeCli();
    const setup = integration.setupCommands()['claude-code'];
    assert.match(setup, /^claude mcp add --scope user chumi -e CHUMI_DATA_DIR=/);
    await integration.connect('claude-code');
    let entry = JSON.parse(readFileSync(file, 'utf8')).mcpServers.chumi;
    assert.deepEqual(entry.args, [MCP_SCRIPT]);
    assert.equal(entry.env.CHUMI_DATA_DIR, DATA);
    const old = { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'old token' }, custom: { keep: true } };
    writeFileSync(file, JSON.stringify({ mcpServers: { chumi: old, other: { command: 'other' } }, theme: 'dark' }));
    await integration.connect('claude-code');
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    entry = cfg.mcpServers.chumi;
    assert.equal(entry.command, integration.mcpServer().command);
    assert.deepEqual(entry.args, [MCP_SCRIPT]);
    assert.equal(entry.env.CHUMI_DATA_DIR, DATA);
    assert.deepEqual(cfg.mcpServers.other, { command: 'other' });
    assert.equal(cfg.theme, 'dark');
    writeFileSync(file, JSON.stringify({ mcpServers: { chumi: old, other: { command: 'other' } }, theme: 'dark' }));
    integration.cli = async () => claudeCli(true);
    await assert.rejects(integration.connect('claude-code'), /add failed/);
    const restored = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(restored.mcpServers.chumi, old, 'the old entry is restored after add fails');
    assert.deepEqual(restored.mcpServers.other, { command: 'other' });
    assert.equal(restored.theme, 'dark');
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8');
    assert.deepEqual(calls.trim().split('\n').slice(-2), ['remove', 'add']);
    const invalid = '{ invalid JSON';
    writeFileSync(file, invalid);
    await assert.rejects(integration.connect('claude-code'));
    assert.equal(readFileSync(file, 'utf8'), invalid, 'an unreadable config is left untouched');
    assert.equal(readFileSync(join(dir, 'calls.log'), 'utf8'), calls, 'no CLI command ran without a safe snapshot');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    store.close();
  }
});

test('Qwen Code: Connect and the manual command put the server and command before env flags', async () => {
  const store = new Store();
  const log = join(DATA, 'qwen-add.json');
  const qwen = cliFile('qwen', `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[1] === 'add') fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
`);
  try {
    const integration = new AgentIntegration(store);
    integration.cli = async () => qwen;
    const m = integration.mcpServer();
    await integration.connect('qwen-code');
    assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['mcp', 'add', '--scope', 'user', 'chumi', m.command, ...m.args, '-e', `CHUMI_DATA_DIR=${DATA}`]);
    assert.match(integration.setupCommands()['qwen-code'], /^qwen mcp add --scope user chumi .* -e CHUMI_DATA_DIR=/);
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
    integration.cli = async () => fixtureCli('opencode-list', false);
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
    integration.cli = async () => agy;
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
    integration.cli = async () => dshCli();
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
    integration.cli = async () => dshCli();
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
    integration.cli = async () => dshCli(true);
    await assert.rejects(integration.connect('deepseek-harness'), /did not accept the new entry, so .* was restored\. Error: dsh: failed to parse patches: invalid entry$/);
    assert.equal(readFileSync(file, 'utf8'), '- id: x\n  disabled: true\n', 'restored after dsh failed to compose it');
    assert.equal(readFileSync(`${file}.bak`, 'utf8'), '- id: x\n  disabled: true\n', 'and the backup is still the user\'s version');
    rmSync(file);
    await assert.rejects(integration.connect('deepseek-harness'));
    assert.equal(existsSync(file), false, 'a file Chumi created is removed again');

    const flow = '- insert: [{ id: mine, name: "@deepseek-ai/dsh-mcp-client", config: {serverName: chumi, command: node} }]\n';
    writeFileSync(file, flow);
    integration.cli = async () => dshCli();
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
    integration.cli = async () => fixtureCli('opencode-strict', false);
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
    integration.cli = async () => recorder;
    // cmd.exe cannot pass a multi-line argument: on Windows the agent is pointed at the handoff file instead.
    const message = (agent: string) => (WIN ? `Read the file ${join(DATA, 'handoffs', `hnd_test-${agent}.md`)} and follow the instructions in it.` : prompt);
    const expected: Record<string, (ws: string, m: string) => string[]> = {
      'claude-code': (_ws, m) => [m], codex: (ws, m) => ['-C', ws, m], opencode: (ws, m) => [ws, '--prompt', m], 'qwen-code': (_ws, m) => ['-i', m],
      antigravity: (_ws, m) => ['-i', m],
    };
    await assert.rejects(() => integration.launchScript('deepseek-harness', 'hnd_test', workspace, prompt), /no terminal session/);
    for (const [agent, args] of Object.entries(expected)) {
      const script = await integration.launchScript(agent as 'codex', 'hnd_test', workspace, prompt);
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

test('agent registrations flag a removed or changed Node command and accept the current command', async () => {
  const store = new Store(':memory:');
  const integration = new AgentIntegration(store);
  const m = integration.mcpServer();
  const { dshBlock } = await import('../server/projects/dsh.ts');
  const otherNode = join(DATA, 'other-node');
  writeFileSync(otherNode, 'different existing runtime');
  try {
    for (const command of [join(DATA, 'removed-node'), otherNode, m.command]) {
      const entry = { ...m, command };
      const jsonCli = cliFile('registration-json', `console.log(${JSON.stringify(JSON.stringify({ transport: entry }))});`);
      const textCli = cliFile('registration-text', `console.log(${JSON.stringify(`Command: ${command}\nArgs: ${MCP_SCRIPT}\nEnvironment:\n  CHUMI_DATA_DIR=${DATA}\nStatus: ✔ connected`)});`);
      for (const [file, content] of [
        [join(DATA, '.qwen', 'settings.json'), JSON.stringify({ mcpServers: { chumi: entry } })],
        [join(DATA, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { chumi: entry } })],
        [join(process.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), JSON.stringify({ mcp: { chumi: { command: [command, ...m.args], environment: m.env } } })],
        [join(process.env.DSH_HOME!, 'cordis.patch.yml'), dshBlock(entry)],
      ]) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, content); }
      for (const agent of ['codex', 'claude-code', 'opencode', 'qwen-code', 'antigravity', 'deepseek-harness'] as const) {
        integration.cli = async () => agent === 'codex' ? jsonCli : textCli;
        const status = await integration.status(agent);
        assert.equal(status.registered, true, agent);
        assert.equal(status.outdated, command !== m.command, agent);
        if (!existsSync(command)) assert.ok(status.outdatedReasons.some((reason) => reason.includes('Node.js command is missing')), agent);
      }
    }
  } finally { store.close(); }
});

test('verification survives ordinary reads, log pruning and restart without counting Claude Desktop reads', async () => {
  const file = join(DATA, 'persistent-verification.db');
  let store = new Store(file);
  const read = (client: string, tool = 'get_passages', token: string | null = null) => store.recordAgentRead({ client, tool, token, project_id: null, session_id: null, handoff_id: null, revision: null });
  try {
    read('claude-code', 'connection_check', 'verified-token');
    const verified = store.agentReads({ client: 'claude-code', verifiedOnly: true })[0];
    store.db.exec('BEGIN');
    for (let i = 0; i < 2100; i++) read('claude-code');
    store.db.exec('COMMIT');
    read('claude-ai', 'get_meeting');
    read('other-claude-code', 'connection_check', 'unrelated-token');
    read('claude-code', 'connection_check');
    store.close();
    store = new Store(file);
    const integration = new AgentIntegration(store);
    integration.cli = async () => null;
    const status = await integration.status('claude-code');
    assert.equal(status.verifiedAt, verified.at);
    assert.equal(status.lastRead!.tool, 'connection_check');
    assert.equal(store.agentReads({ client: 'claude-code', verifiedOnly: true })[0].token, 'verified-token');
    read('claude-code', 'get_passages');
    read('claude-ai', 'get_handoff');
    assert.equal((await integration.status('claude-code')).lastRead!.tool, 'get_passages');
    assert.ok((store.db.prepare('SELECT COUNT(*) AS n FROM agent_reads').get() as { n: number }).n <= 2002, 'ordinary reads are still pruned');
  } finally { store.close(); }
});

test('registration prefers an nvm current link that resolves to the running Node', { skip: WIN }, () => {
  const store = new Store(':memory:');
  const saved = process.env.NVM_DIR;
  const nvm = join(DATA, 'nvm');
  mkdirSync(join(nvm, 'current', 'bin'), { recursive: true });
  const stable = join(nvm, 'current', 'bin', 'node');
  symlinkSync(process.execPath, stable);
  process.env.NVM_DIR = nvm;
  try { assert.equal(new AgentIntegration(store).mcpServer().command, stable); }
  finally { if (saved === undefined) delete process.env.NVM_DIR; else process.env.NVM_DIR = saved; store.close(); }
});

test('fnm shell links resolve to one durable registration across restarts', { skip: WIN }, async () => {
  const store = new Store(':memory:');
  const savedPath = process.env.PATH;
  const first = join(DATA, 'fnm_multishells', 'first', 'bin'), second = join(DATA, 'fnm_multishells', 'second', 'bin');
  for (const bin of [first, second]) { mkdirSync(bin, { recursive: true }); symlinkSync(process.execPath, join(bin, 'node')); }
  const integration = new AgentIntegration(store);
  try {
    process.env.PATH = first;
    const original = integration.mcpServer();
    assert.equal(original.command, realpathSync(process.execPath));
    process.env.PATH = second;
    assert.equal(integration.mcpServer().command, original.command);
    for (const command of [join(first, 'node'), join(second, 'node'), original.command]) {
      integration.cli = async () => cliFile('fnm-registration', `console.log(${JSON.stringify(JSON.stringify({ transport: { ...original, command } }))});`);
      assert.equal((await integration.status('codex')).outdated, false, 'aliases of the same binary do not require reconnecting');
    }
    rmSync(join(first, 'node'));
    integration.cli = async () => cliFile('fnm-removed', `console.log(${JSON.stringify(JSON.stringify({ transport: { ...original, command: join(first, 'node') } }))});`);
    assert.equal((await integration.status('codex')).outdated, true, 'a removed legacy shell link still needs repair');
  } finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; store.close(); }
});

test('registration reasons distinguish locations and Node while keeping disabled notices', async () => {
  const store = new Store(':memory:');
  const integration = new AgentIntegration(store), m = integration.mcpServer();
  try {
    const entry = { ...m, command: join(DATA, 'missing-node'), args: ['/another/chumi/main.ts'], env: { CHUMI_DATA_DIR: '/another/data' } };
    integration.cli = async () => cliFile('outdated-disabled', `console.log(${JSON.stringify(JSON.stringify({ transport: entry, enabled: false }))});`);
    const status = await integration.status('codex');
    assert.equal(status.outdated, true);
    assert.equal(status.detail, 'Registered but disabled in Codex.');
    assert.deepEqual(status.outdatedReasons, [
      'The registered Node.js command is missing. Reconnect to use the current Node.js.',
      'connected to another Chumi location',
      'Connected to another Chumi data folder. Reconnect to use this folder.',
    ]);
    integration.cli = async () => cliFile('claude-outdated-location', `console.log(${JSON.stringify(`Command: ${m.command}\nArgs: /another/chumi/main.ts\nCHUMI_DATA_DIR=/another/data\nStatus: ✔ connected`)});`);
    const claude = await integration.status('claude-code');
    assert.deepEqual(claude.outdatedReasons, status.outdatedReasons.slice(1));
  } finally { store.close(); }
});

test('the agent trial waits for CLI discovery and rejects a missing CLI', async () => {
  const source = readFileSync(new URL('../scripts/agent-trial.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const cli =', source.indexOf('// ---------------------------------------------------------------- trial'));
  const guard = source.slice(start, source.indexOf('  let extra:', start));
  const check = new Function('integration', 'agent', `return (async () => { ${guard} return cli; })();`);
  await assert.rejects(check({ cli: async () => null }, 'deepseek-harness'), /deepseek-harness is not installed/);
  assert.equal(await check({ cli: async () => '/fixture/dsh' }, 'deepseek-harness'), '/fixture/dsh');
});
