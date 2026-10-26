import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { Store } from '../server/db.ts';
import { HandoffService } from '../server/projects/handoff.ts';
import { ProjectWorkService } from '../server/projects/work.ts';
import type { Assistant } from '../server/ai/assistant.ts';
import { AGENTS } from '../shared/agents.ts';

// Execute the real route handlers with inert desktop/AI adapters and an isolated database.
const main = readFileSync(new URL('../server/main.ts', import.meta.url), 'utf8');
type Handler = (req: unknown, res: unknown, params: Record<string, string>) => any;
function routeSource(start: string, end: string): string {
  return main.slice(main.indexOf(start), main.indexOf(end, main.indexOf(start)));
}
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function fixture(openDesktop: (...args: string[]) => Promise<unknown> = async () => ({}), openDsh: (...args: string[]) => Promise<unknown> = async () => ({ instruction: 'Read the handoff file.', copied: true })) {
  const store = new Store(':memory:');
  store.createProject({ id: 'project', name: 'Synthetic project', workspace: tmpdir() });
  store.createSession({ id: 'meeting', title: 'Synthetic meeting', type: 'lab_meeting', audio_source: 'mic' });
  store.assignSession('meeting', 'project');
  store.updateSession('meeting', { status: 'ended' });
  store.createHandoff({ id: 'handoff', session_id: 'meeting', project_id: 'project', status: 'confirmed' });
  store.updateHandoff('handoff', { confirmed_at: 1, confirmed_revision: store.getSession('meeting')!.revision });
  store.insertHandoffItem({ id: 'action', handoff_id: 'handoff', project_id: 'project', kind: 'action', position: 0,
    text: 'Run the comparison', rationale: null, conditions_json: '[]', acceptance_json: '[]', origin: 'agreed',
    owner: null, due: null, evidence_json: '[]', review: 'confirmed', edited: 0 });
  const handoffs = new HandoffService(store, {} as Assistant, () => {});
  const projectWork = new ProjectWorkService(store);
  const handlers = new Map<string, Handler>(), events: string[] = [], terminal: string[][] = [];
  const deps = {
    store, handoffs, projectWork, AGENTS, HttpError,
    route: (method: string, path: string, handler: Handler) => handlers.set(`${method} ${path}`, handler),
    readJson: async (body: unknown) => body,
    broadcast: (event: string) => events.push(event), syncMybot: () => events.push('mybot'),
    chumiLink: () => () => null, agents: { launch: (...args: string[]) => terminal.push(args) }, launchCodexDesktop: openDesktop,
    continueInDeepSeekHarness: openDsh, NO_LAUNCH: false, log: () => {},
  };
  const code = [
    routeSource("route('GET', '/api/projects/:id/brief'", "route('POST', '/api/projects',"),
    routeSource("route('PATCH', '/api/handoff-items/:id/progress'", "route('PATCH', '/api/handoff-items/:id',"),
    routeSource("route('POST', '/api/handoffs/:id/continue'", '// ---------------------------------------------------------------- coding agent connection'),
  ].join('\n');
  new Function(...Object.keys(deps), stripTypeScriptTypes(code))(...Object.values(deps));
  const call = (key: string, id: string, body: unknown = {}) => handlers.get(key)!(body, null, { id });
  return { store, handoffs, events, terminal, call };
}

test('desktop continuation waits for the opener and does not require or launch a CLI', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const opened: string[][] = [];
  const f = fixture(async (...args) => { opened.push(args); await wait; });
  try {
    const request = f.call('POST /api/handoffs/:id/continue', 'handoff', { agent: 'codex-app' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.store.getHandoff('handoff')!.delivered_at, null);
    assert.equal(opened.length, 1);
    assert.match(opened[0][2], /Run the comparison/);
    release();
    assert.equal((await request).launched, true);
    assert.equal(f.store.getHandoff('handoff')!.delivered_via, 'codex-app');
    assert.deepEqual(f.terminal, []);
  } finally { release(); f.store.close(); }
});

test('a desktop open failure preserves delivery state and copy remains available', async () => {
  const f = fixture(async () => { throw new Error('No registered application'); });
  try {
    await assert.rejects(f.call('POST /api/handoffs/:id/continue', 'handoff', { agent: 'codex-app' }), /No registered application/);
    assert.equal(f.store.getHandoff('handoff')!.delivered_at, null);
    const copied = await f.call('POST /api/handoffs/:id/continue', 'handoff', { agent: 'copy' });
    assert.equal(copied.launched, false);
    assert.match(copied.prompt, /Run the comparison/);
    assert.deepEqual(f.terminal, []);
  } finally { f.store.close(); }
});

test('DeepSeek Harness continues through its app with an instruction to paste, never through a terminal', async () => {
  const calls: string[][] = [];
  const f = fixture(undefined, async (...args) => { calls.push(args); return { instruction: 'Read the saved handoff.', copied: false }; });
  try {
    const r = await f.call('POST /api/handoffs/:id/continue', 'handoff', { agent: 'deepseek-harness' });
    assert.equal(r.launched, true);
    assert.deepEqual(r.paste, { text: 'Read the saved handoff.', copied: false }, 'the dialog shows the instruction when the clipboard failed');
    assert.equal(calls.length, 1);
    assert.match(calls[0][2], /Run the comparison/);
    assert.equal(f.store.getHandoff('handoff')!.delivered_via, 'deepseek-harness');
    assert.deepEqual(f.terminal, []);
  } finally { f.store.close(); }
});

test('progress updates refresh the handoff, export and project brief without changing review', async () => {
  const f = fixture();
  try {
    const saved = await f.call('PATCH /api/handoff-items/:id/progress', 'action', {
      expectedVersion: 0, status: 'completed', note: 'Comparison checked', results: [{ label: 'Report', url: 'https://example.org/report' }],
    });
    assert.equal(saved.progress.version, 1);
    assert.equal(saved.handoff.status, 'confirmed');
    assert.equal(saved.handoff.items[0].progress.status, 'completed');
    assert.deepEqual(f.events, ['handoff', 'project-work', 'mybot']);
    const brief = await f.call('GET /api/projects/:id/brief', 'project');
    assert.equal(brief.actions.length, 0);
    assert.equal(brief.completedActions[0].id, 'action');
    const prompt = f.handoffs.continuationPrompt('handoff', () => null, false);
    assert.match(prompt, /no unfinished confirmed actions/);
    assert.match(prompt, /Completed actions.*do not repeat/);
    assert.match(prompt, /https:\/\/example.org\/report/);
    f.events.length = 0;
    await assert.rejects(f.call('PATCH /api/handoff-items/:id/progress', 'action', {
      expectedVersion: 0, status: 'not_started', note: '', results: [],
    }), /another window|changed/i);
    assert.deepEqual(f.events, []);
  } finally { f.store.close(); }
});

test('agenda save is versioned and the brief returns the persisted agenda', async () => {
  const f = fixture();
  try {
    const r = await f.call('PATCH /api/projects/:id/agenda', 'project', { expectedVersion: 0, text: 'Discuss the result and next baseline.' });
    assert.equal(r.agenda.version, 1);
    const brief = await f.call('GET /api/projects/:id/brief', 'project');
    assert.equal(brief.agenda.text, r.agenda.text);
    await assert.rejects(f.call('PATCH /api/projects/:id/agenda', 'project', { expectedVersion: 0, text: 'Old draft' }), /changed/);
    assert.equal(f.events.length, 1);
  } finally { f.store.close(); }
});
