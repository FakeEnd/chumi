import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentChecks } from '../server/agent-checks.ts';
import { AGENTS, AGENT_NAMES, type AgentId } from '../shared/agents.ts';
import type { AgentStatus } from '../server/projects/agents.ts';
import { componentHarness, defer, tick, words } from './component-harness.ts';

const status = (agent: AgentId = 'codex', registered = false) => ({ agent, name: AGENT_NAMES[agent], billing: 'plan', cli: '/tmp/cli', registered, clientHealth: 'unknown' }) as AgentStatus;

test('agent checks share pending work, expire and invalidate only the changed client', async () => {
  let now = 0, calls = 0;
  const pending = defer<AgentStatus>();
  const checks = new AgentChecks({ status: async (agent) => { calls++; return agent === 'opencode' ? pending.promise : status(agent); }, localCheck: async () => ({ ok: true, detail: '' }) }, () => now, 30);
  const slow = checks.status('opencode');
  assert.equal(slow, checks.status('opencode'));
  assert.equal((await checks.status('codex')).agent, 'codex');
  await checks.status('codex'); assert.equal(calls, 2);
  now = 31; await checks.status('codex'); assert.equal(calls, 3);
  await checks.status('codex', true); assert.equal(calls, 4);
  assert.equal(checks.status('opencode'), slow);
  pending.resolve(status('opencode')); await slow;
});

test('invalidating an in-flight check cannot put its old result back in the cache', async () => {
  const pending = defer<AgentStatus>(); let calls = 0;
  const checks = new AgentChecks({ status: () => ++calls === 1 ? pending.promise : Promise.resolve(status('codex', true)), localCheck: async () => ({ ok: true, detail: '' }) });
  const old = checks.status('codex'); await tick();
  assert.equal((await checks.status('codex', true)).registered, true);
  pending.resolve(status()); await old;
  assert.equal((await checks.status('codex')).registered, true);
  assert.equal(calls, 2);
});

test('agents render independently and actions update one card without rechecking all CLIs', async () => {
  const calls: string[] = [], slow = defer<AgentStatus>(); let fail = false;
  const ui = await componentHarness('Projects.tsx', 'AgentsTab', {}, { AGENTS, AGENT_NAMES, tn: (s: string) => s, api: async (path: string) => {
    calls.push(path);
    if (path.endsWith('/info')) return { commands: {}, exports: { mybot: null } };
    if (path.endsWith('/local')) return new Promise(() => {});
    if (path === '/api/agents/codex/status') return status();
    if (path.endsWith('/status')) return slow.promise;
    if (fail) throw new Error('Could not connect');
    return { status: status('codex', true) };
  } });
  await tick(); ui.render();
  assert.ok(ui.button('Connect'));
  assert.match(ui.text(), /Checking…/);
  const initial = calls.length;
  ui.button('Connect').props.onClick(); await tick(); ui.render();
  assert.ok(ui.button('Reconnect'));
  assert.deepEqual(calls.slice(initial), ['/api/agents/codex/connect']);
  fail = true;
  ui.button('Disconnect').props.onClick(); await tick(); ui.render();
  const card = ui.find((e) => e.props.className === 'agent-card' && words(e).includes('Codex'));
  assert.match(words(card), /Could not connect/);
});
