import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'chumi-agent-check-'));
process.env.CHUMI_DATA_DIR = DATA;
const { Store } = await import('../server/db.ts');
const { AgentIntegration } = await import('../server/projects/agents.ts');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

// Like Codex exec with piped stdin, this CLI waits for EOF even when given a prompt argument.
// It uses only a temporary database; no installed agent, credentials or model requests are involved.
function fixtureCli(name: string, recordRead: boolean): string {
  const path = join(DATA, name);
  writeFileSync(path, `#!${process.execPath}
const timer = setTimeout(() => {
  console.error('Reading additional input from stdin... (stdin was left open)');
  process.exit(1);
}, 2000);
process.stdin.resume();
process.stdin.on('end', async () => {
  clearTimeout(timer);
  const prompt = process.argv.find(arg => arg.startsWith('Call the MCP tool '));
  const token = prompt?.match(/with token "([^"]+)"/)?.[1];
  if (!token) throw new Error('Missing verification prompt');
  if (${recordRead}) {
    const { Store } = await import(${JSON.stringify(new URL('../server/db.ts', import.meta.url).href)});
    const store = new Store();
    store.recordAgentRead({
      client: process.argv[2] === 'exec' ? 'codex-mcp-client' : 'claude-code',
      tool: 'connection_check', token,
      project_id: null, session_id: null, handoff_id: null, revision: null,
    });
    store.close();
  }
  console.log('OK');
});
`, { mode: 0o755 });
  return path;
}

test('agent read checks close stdin so the CLI can reach the verification step', async () => {
  const store = new Store();
  try {
    const integration = new AgentIntegration(store);
    integration.cli = () => fixtureCli('reads-after-eof', true);
    for (const agent of ['codex', 'claude-code'] as const) {
      const result = await integration.verify(agent);
      assert.equal(result.ok, true, result.detail);
      assert.match(result.detail, /read Chumi's data through MCP/);
    }
  } finally {
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
