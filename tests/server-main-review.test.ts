import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateMybotDirectory } from '../server/mybot-export.ts';
import { translateMessage } from '../shared/messages.ts';
import { ZH } from '../web/src/i18n-zh.ts';

const main = readFileSync(new URL('../server/main.ts', import.meta.url), 'utf8');
const errorSource = main.slice(main.indexOf('class HttpError'), main.indexOf('\n', main.indexOf('class HttpError')));
const HttpError = new Function(stripTypeScriptTypes(errorSource) + '; return HttpError;')();
function route(path: string, deps: Record<string, unknown>) {
  let handler!: (...args: any[]) => any;
  const start = main.indexOf(`route('POST', '${path}'`);
  assert.ok(start >= 0);
  const source = stripTypeScriptTypes(main.slice(start, main.indexOf('\nroute(', start + 1)));
  const adapters = { HttpError, ...deps, route: (_method: string, _path: string, h: typeof handler) => { handler = h; } };
  new Function(...Object.keys(adapters), source)(...Object.values(adapters));
  return handler;
}

test('agent verification sends a translatable key and inner reason when plan lookup fails', async () => {
  const verify = route('/api/agents/:agent/verify', {
    isAgent: () => true, AGENT_BILLING: { codex: 'plan' },
    registry: { providers: { codex: { status: async () => { throw new Error('offline'); } } } },
    agentChecks: { status: async () => ({ agent: 'codex' }) },
    agents: { verify: () => assert.fail('a failed plan lookup must not make a paid request') },
  });
  const { result } = await verify({}, {}, { agent: 'codex' });
  assert.deepEqual(result, { ok: false, detail: 'Not run, so nothing is charged: {error}', vars: { error: 'the plan status could not be checked.' } });
  assert.equal(translateMessage(result.detail, ZH, result.vars), '尚未执行，因此未产生费用：无法检查套餐状态。');
});

test('manual mybot export rejects invalid folders with 400 and broadcasts only after completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-manual-export-')), events: unknown[] = [];
  let exportDir = '', started = false, finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  const exportAll = route('/api/integrations/mybot/export-all', {
    store: { getSettings: () => ({ integrations: { mybot: { exportDir } } }) }, mybot: {}, validateMybotDirectory,
    exportMybotSessions: () => { started = true; return pending; }, broadcast: (...args: unknown[]) => events.push(args),
  });
  try {
    assert.throws(() => exportAll(), (e: any) => e instanceof HttpError && e.status === 400);
    assert.equal(started, false); assert.deepEqual(events, []);
    exportDir = dir; const result = exportAll();
    assert.equal(started, true); assert.deepEqual(events, []);
    const done = { exported: 2, dir }; finish(done);
    assert.deepEqual(await result, done); assert.deepEqual(events, [['mybot-exported', done]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP 500 logging retains template variables with the underlying diagnostic', () => {
  const start = main.indexOf('    const status = e instanceof HttpError ||');
  const source = main.slice(start, main.indexOf('\n  }\n});', start));
  const logged: unknown[][] = [], replies: any[][] = [];
  const adapters = { HttpError, HandoffError: class extends Error {}, ProjectWorkError: class extends Error {}, res: { headersSent: false }, log: (...args: unknown[]) => logged.push(args), send: (...args: any[]) => replies.push(args) };
  const respond = new Function('e', ...Object.keys(adapters), stripTypeScriptTypes(source));
  const vars = { error: 'EIO reading /tmp/synthetic.wav' };
  respond(new HttpError(500, 'The audio recording cannot be read: {error}', vars), ...Object.values(adapters));
  assert.equal(logged[0][2], vars); assert.equal(replies[0][1], 500); assert.deepEqual(replies[0][2].vars, vars);
});
