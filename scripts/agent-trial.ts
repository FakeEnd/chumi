/**
 * Virtual trial of a coding-agent connection with the real agent CLI and a stand-in model.
 *
 *   node scripts/agent-trial.ts opencode
 *   node scripts/agent-trial.ts qwen-code
 *   node scripts/agent-trial.ts deepseek-harness
 *   DEEPSEEK_API_KEY=… node scripts/agent-trial.ts deepseek-harness --real
 *
 * Runs Chumi's own Connect, status and "Test a real agent read" code against the installed CLI. The agent talks to
 * a local OpenAI-compatible stand-in that answers the read check with a call to chumi_connection_check (directly,
 * or through tool_search/tool_call when the agent defers MCP tools), so no model account is used and nothing is billed.
 * Everything happens in a throwaway home and data folder: the user's agent settings and meetings are not touched.
 * opencode fetches its OpenAI-compatible provider package on first use, so it needs network access (or a proxy).
 * DeepSeek Harness gets the stand-in through a --patch overlay naming it as a custom OpenAI-compatible provider. With
 * --real it uses DeepSeek's own API with DEEPSEEK_API_KEY instead (one small, billed request), as dsh does by default.
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const agent = process.argv[2];
const real = process.argv[3] === '--real';
if ((agent !== 'opencode' && agent !== 'qwen-code' && agent !== 'deepseek-harness') || (real && agent !== 'deepseek-harness')) {
  console.error('usage: node scripts/agent-trial.ts opencode|qwen-code|deepseek-harness, or deepseek-harness --real');
  process.exit(2);
}
if (real && !process.env.DEEPSEEK_API_KEY) { console.error('--real needs DEEPSEEK_API_KEY in the environment.'); process.exit(2); }
const DIR = mkdtempSync(join(tmpdir(), 'chumi-agent-trial-'));
const HOME = join(DIR, 'home');
mkdirSync(HOME, { recursive: true });
mkdirSync(join(DIR, 'data'), { recursive: true });
// Before Chumi's modules load: they read these when imported.
Object.assign(process.env, { HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: join(HOME, '.config'), DSH_HOME: join(HOME, '.dsh'), CHUMI_DATA_DIR: join(DIR, 'data') });
const { Store } = await import('../server/db.ts');
const { AgentIntegration } = await import('../server/projects/agents.ts');

// ---------------------------------------------------------------- stand-in model
type Msg = { role: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
const requests: Array<{ tools: string[]; call: string | null }> = [];
function decide(body: { tools?: Array<{ function?: { name?: string } }>; messages?: Msg[] }) {
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? '');
  const msgs = body.messages ?? [];
  const text = msgs.map((m) => typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p: { text?: string }) => p.text ?? '').join('\n') : '').join('\n');
  // Some agents send the prompt JSON-quoted, so the quotes around the token may be escaped.
  const token = text.match(/with token \\?"([^"\\]+)\\?"/)?.[1];
  const prior = msgs.flatMap((m) => m.tool_calls ?? []).map((c) => `${c.function?.name} ${c.function?.arguments}`);
  const done = prior.some((s) => !s.startsWith('tool_search') && s.includes('chumi_connection_check'));
  const direct = tools.find((n) => n.includes('chumi_connection_check'));
  const deferred = text.match(/[\w-]*chumi_connection_check/g)?.find((n) => n !== 'chumi_connection_check');
  let call: { name: string; arguments: unknown } | null = null;
  if (token && !done) {
    if (direct) call = { name: direct, arguments: { token } };
    else if (deferred && tools.includes('tool_call')) {
      call = tools.includes('tool_search') && !prior.some((s) => s.startsWith('tool_search'))
        ? { name: 'tool_search', arguments: { query: `select:${deferred}` } }
        : { name: 'tool_call', arguments: { name: deferred, arguments: { token } } };
    }
  }
  if (tools.length) requests.push({ tools, call: call?.name ?? null });
  return { call, text: done ? 'OK' : 'No Chumi tool was offered.' };
}
const model = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  if (req.url?.endsWith('/models')) { res.end(JSON.stringify({ object: 'list', data: [{ id: 'stand-in', object: 'model' }] })); return; }
  const body = raw ? JSON.parse(raw) : {};
  const { call, text } = decide(body);
  const toolCalls = call ? [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] : undefined;
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (choice: object, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'trial', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`);
    chunk({ delta: call ? { role: 'assistant', tool_calls: toolCalls } : { role: 'assistant', content: text }, finish_reason: null });
    chunk({ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }, { usage });
    res.end('data: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'trial', object: 'chat.completion', model: body.model, usage, choices: [{ index: 0, finish_reason: call ? 'tool_calls' : 'stop', message: call ? { role: 'assistant', content: null, tool_calls: toolCalls?.map(({ index: _i, ...c }) => c) } : { role: 'assistant', content: text } }] }));
  }
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;

// ---------------------------------------------------------------- trial
let failed = false;
const step = (ok: boolean, what: string, detail: string) => { if (!ok) failed = true; console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}: ${detail}`); };
const store = new Store();
const integration = new AgentIntegration(store);
try {
  const cli = await integration.cli(agent);
  if (!cli) throw new Error(`${agent} is not installed.`);
  let extra: string[];
  if (agent === 'opencode') {
    // The stand-in goes in opencode.jsonc (with a comment), Chumi's entry in opencode.json: opencode reads both.
    mkdirSync(join(HOME, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(HOME, '.config', 'opencode', 'opencode.jsonc'), `// stand-in model for the trial\n${JSON.stringify({ provider: { trial: { npm: '@ai-sdk/openai-compatible', name: 'Stand-in', options: { baseURL: BASE, apiKey: 'stand-in' }, models: { 'stand-in': { name: 'stand-in', tool_call: true } } } } }, null, 2)}\n`);
    extra = ['-m', 'trial/stand-in'];
  } else if (agent === 'deepseek-harness') {
    const overlay = join(DIR, 'stand-in.cordis.yml');
    writeFileSync(overlay, `- id: llm-pi-ai\n  config:\n    providers:\n      trial:\n        apiKeyEnv: TRIAL_API_KEY\n        api: openai-completions\n        baseURL: ${JSON.stringify(BASE)}\n        models:\n          - id: stand-in\n- id: agent-default-model\n  config:\n    provider: trial\n    model: stand-in\n`);
    process.env.TRIAL_API_KEY = 'stand-in';
    extra = real ? [] : ['--patch', overlay];
    // The read check takes the model from the desktop app's own layer. This one is shaped like the app's (with entries
    // only the desktop has); under --real it names DeepSeek's API, so its model and effort are what the check uses.
    mkdirSync(join(HOME, '.dsh', 'profiles', 'desktop'), { recursive: true });
    writeFileSync(join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), '- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n    reasoningEffort: high\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n  config:\n    transcriptView: detailed\n');
  } else {
    extra = ['--auth-type', 'openai', '--openai-base-url', BASE, '--openai-api-key', 'stand-in', '-m', 'stand-in'];
  }
  await integration.connect(agent);
  const st = await integration.status(agent);
  step(st.registered === true && !st.outdated, 'Connect', `registered=${st.registered}, outdated=${st.outdated}`);
  if (agent !== 'deepseek-harness') step(st.clientHealth === 'connected', 'Client health', `${st.name} reports "${st.clientHealth}"`);
  const r = await integration.verify(agent, extra);
  step(r.ok, 'Agent read', r.detail);
  const offered = requests.find((q) => q.call)?.tools ?? requests[0]?.tools ?? [];
  if (!real) console.log(`      stand-in saw ${requests.length} request(s) with tools; the one that called Chumi offered: ${offered.join(', ') || 'none'}`);
  if (agent === 'opencode') step(offered.length > 0 && offered.every((n) => n.startsWith('chumi_')), 'Read check is limited to Chumi', `${offered.length} tool(s) offered`);
  await integration.disconnect(agent);
  step((await integration.status(agent)).registered === false, 'Disconnect', 'the chumi entry is gone');
} catch (e) {
  step(false, 'Trial', (e as Error).message);
} finally {
  store.close();
  model.close();
  rmSync(DIR, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
