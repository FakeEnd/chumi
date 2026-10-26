import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { continueInDeepSeekHarness, launchCodexDesktop } from '../server/projects/desktop-handoff.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'chumi-desktop-handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, '研究项目 A&B #1 + café');
  const dataDir = join(root, 'App Data 中文 & #%');
  mkdirSync(workspace);
  const id = 'hf_fixture-123';
  const opened: string[] = [];
  const openUrl = async (url: string) => { opened.push(url); };
  return { root, workspace, dataDir, id, opened, openUrl };
}

/** Read the actual pointer sent to Codex, including JSON-escaped Windows paths. */
function handoffFile(link: string): string {
  const prefill = new URL(link).searchParams.get('prompt')!;
  const quoted = prefill.match(/file at ("(?:\\.|[^"\\])*") \(handoff/);
  assert.ok(quoted, 'the prefill must identify its saved handoff file');
  return JSON.parse(quoted[1]) as string;
}

test('desktop handoff preserves the full Unicode text while the URL contains only a short file pointer', async (t) => {
  const f = fixture(t);
  const prompt = '请先给出计划，不要修改文件。\nProject: café & research #1\n' + 'Long meeting details — 中文。\n'.repeat(10_000);
  const result = await launchCodexDesktop(f.id, f.workspace, prompt, f);
  assert.deepEqual(f.opened, [result.url]);
  const url = new URL(result.url);
  assert.equal(url.protocol, 'codex:');
  assert.equal(url.hostname, 'new');
  assert.equal(url.searchParams.get('path'), f.workspace);
  assert.deepEqual([...url.searchParams.keys()], ['path', 'prompt']);
  assert.equal(url.hash, '');
  assert.match(result.url, /%E7%A0%94/);
  const prefill = url.searchParams.get('prompt')!;
  const file = handoffFile(result.url);
  assert.equal(dirname(file), join(f.dataDir, 'handoffs'));
  assert.ok(prefill.includes(f.id));
  assert.match(prefill, /propose a plan and wait for my go-ahead/);
  assert.equal(readFileSync(file, 'utf8'), prompt);
  assert.ok(result.url.length < 2000, 'URL length is independent of meeting length');
  assert.ok(!result.url.includes('Long+meeting+details'));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('desktop launch waits for the opener and only calls it after the complete file has been saved', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const called = new Promise<void>((resolve) => { reached = resolve; });
  const openUrl = async (url: string) => {
    assert.equal(readFileSync(handoffFile(url), 'utf8'), 'Saved before launch.');
    reached();
    await gate;
  };
  let settled = false;
  const launching = launchCodexDesktop(f.id, f.workspace, 'Saved before launch.', { ...f, openUrl }).then((result) => { settled = true; return result; });
  await called;
  assert.equal(settled, false);
  release();
  assert.ok((await launching).url.startsWith('codex://new?'));
});

test('an unavailable desktop handler rejects with a copy fallback and retains the saved handoff', async (t) => {
  const f = fixture(t);
  const cause = new Error('No handler registered');
  let attempts = 0;
  let savedFile = '';
  await assert.rejects(launchCodexDesktop(f.id, f.workspace, 'Preserved instructions.', {
    ...f, openUrl: async (url) => { attempts++; savedFile = handoffFile(url); throw cause; },
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Could not open the Codex desktop app/);
    assert.match(error.message, /Copy instructions/);
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(readFileSync(savedFile, 'utf8'), 'Preserved instructions.');
});

test('unsafe handoff IDs never write files or request an app launch', async (t) => {
  const f = fixture(t);
  for (const id of ['', '..', '../outside', '/absolute', 'folder/id', 'folder\\id', 'id.md', 'id\0suffix', 'id\n', 'x'.repeat(129)]) {
    await assert.rejects(launchCodexDesktop(id, f.workspace, 'Instructions.', f), /Invalid handoff ID/);
  }
  assert.equal(existsSync(f.dataDir), false);
  assert.deepEqual(f.opened, []);
});

test('missing, relative and non-directory workspaces fail before saving or launching', async (t) => {
  const f = fixture(t);
  const plainFile = join(f.root, 'a-file');
  writeFileSync(plainFile, 'Not a folder.');
  for (const workspace of [join(f.root, 'missing'), plainFile]) {
    await assert.rejects(launchCodexDesktop(f.id, workspace, 'Instructions.', f), /project folder is not available/);
  }
  await assert.rejects(launchCodexDesktop(f.id, 'relative/project', 'Instructions.', f), /absolute project folder/);
  assert.equal(existsSync(f.dataDir), false);
  assert.deepEqual(f.opened, []);
});

test('saving failures reject before opening Codex', async (t) => {
  const f = fixture(t);
  writeFileSync(f.dataDir, 'A file blocks the data directory.');
  await assert.rejects(launchCodexDesktop(f.id, f.workspace, 'Instructions.', f), /could not save.*Copy instructions/);
  assert.deepEqual(f.opened, []);
});

test('relaunching after a project change creates an immutable snapshot for each pending composer', async (t) => {
  const f = fixture(t);
  const otherWorkspace = join(f.root, 'Other project');
  mkdirSync(otherWorkspace);
  const old = await launchCodexDesktop(f.id, f.workspace, 'Work in the original project.', f);
  const next = await launchCodexDesktop(f.id, otherWorkspace, 'Work in the other project.', f);
  const oldFile = handoffFile(old.url), nextFile = handoffFile(next.url);
  assert.notEqual(oldFile, nextFile);
  assert.equal(new URL(old.url).searchParams.get('path'), f.workspace);
  assert.equal(new URL(next.url).searchParams.get('path'), otherWorkspace);
  assert.equal(readFileSync(oldFile, 'utf8'), 'Work in the original project.');
  assert.equal(readFileSync(nextFile, 'utf8'), 'Work in the other project.');
  assert.equal(readdirSync(join(f.dataDir, 'handoffs')).length, 2, 'no temporary files remain');
  if (process.platform !== 'win32') for (const file of [oldFile, nextFile]) assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a pre-existing legacy handoff symlink is not used for a new snapshot', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t);
  const target = join(f.root, 'unrelated.md');
  const legacyFile = join(f.dataDir, 'handoffs', `${f.id}-codex-app.md`);
  writeFileSync(target, 'Keep this file.');
  mkdirSync(join(f.dataDir, 'handoffs'), { recursive: true });
  symlinkSync(target, legacyFile);
  const result = await launchCodexDesktop(f.id, f.workspace, 'New handoff.', f);
  assert.equal(readFileSync(target, 'utf8'), 'Keep this file.');
  assert.notEqual(handoffFile(result.url), legacyFile);
  assert.equal(readFileSync(handoffFile(result.url), 'utf8'), 'New handoff.');
});

test('DeepSeek Harness: the instruction is copied before the app opens and points at a private snapshot and the project folder', async (t) => {
  const f = fixture(t);
  const steps: string[] = [];
  const prompt = '请先给出计划。\nProject: café & research #1\n' + 'Long meeting details — 中文。\n'.repeat(1000);
  const r = await continueInDeepSeekHarness(f.id, f.workspace, prompt, {
    dataDir: f.dataDir,
    copy: async (text) => { steps.push(`copy ${text}`); },
    open: async () => { steps.push('open'); },
  });
  assert.deepEqual(steps, [`copy ${r.instruction}`, 'open'], 'Chumi still has focus, so the clipboard works, only before the app comes up');
  assert.equal(r.copied, true);
  const quoted = r.instruction.match(/file at ("(?:\\.|[^"\\])*") \(handoff/);
  assert.ok(quoted);
  const file = JSON.parse(quoted[1]) as string;
  assert.equal(dirname(file), join(f.dataDir, 'handoffs'));
  assert.equal(readFileSync(file, 'utf8'), prompt);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(r.instruction.includes(JSON.stringify(f.workspace)), 'the agent is told which folder to work in');
  assert.match(r.instruction, /propose a plan and wait for my go-ahead/);
  assert.ok(!r.instruction.includes('\n') && r.instruction.length < 1000, 'one short line, whatever the meeting length');
});

test('DeepSeek Harness: a clipboard failure still opens the app and reports it; an open failure keeps the snapshot', async (t) => {
  const f = fixture(t);
  let opened = 0;
  const r = await continueInDeepSeekHarness(f.id, f.workspace, 'Instructions.', { dataDir: f.dataDir, copy: async () => { throw new Error('no pasteboard'); }, open: async () => { opened++; } });
  assert.equal(r.copied, false);
  assert.equal(opened, 1);
  await assert.rejects(continueInDeepSeekHarness(f.id, f.workspace, 'Kept.', { dataDir: f.dataDir, copy: async () => {}, open: async () => { throw new Error('no handler'); } }),
    /Could not open the DeepSeek Harness app.*Copy instructions/);
  const kept = readdirSync(join(f.dataDir, 'handoffs')).filter((n) => n.includes('-dsh-')).map((n) => readFileSync(join(f.dataDir, 'handoffs', n), 'utf8'));
  assert.ok(kept.includes('Kept.'));
  await assert.rejects(continueInDeepSeekHarness('../x', f.workspace, 'x', { dataDir: f.dataDir, copy: async () => {}, open: async () => { opened++; } }), /Invalid handoff ID/);
  assert.equal(opened, 1);
});
