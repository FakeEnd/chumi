import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'chumi-dsh-app-'));
process.env.CHUMI_DATA_DIR = DATA;
const { chosenDshApp, dshAppDir, dshAppInstalled, dshCliIn, findDsh, rememberDshApp, usableSpotlightApps } = await import('../server/projects/dsh.ts');
const { which } = await import('../server/paths.ts');
const { AgentIntegration } = await import('../server/projects/agents.ts');
const { Store } = await import('../server/db.ts');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

/** A stand-in desktop install: only the dsh command, where the real app keeps it. */
function install(dir: string): string {
  mkdirSync(dirname(dshCliIn(dir)), { recursive: true });
  writeFileSync(dshCliIn(dir), '', { mode: 0o755 });
  return dir;
}

test('DeepSeek Harness: a chosen app is remembered only when its dsh command is inside, and used while it is there', async () => {
  const app = join(DATA, 'DIY_APP', 'DeepSeek Harness.app');
  mkdirSync(app, { recursive: true });
  assert.throws(() => rememberDshApp(app), /not the DeepSeek Harness app|no DeepSeek Harness in it/);
  assert.equal(chosenDshApp(), null, 'nothing is remembered from a refused choice');

  rememberDshApp(install(app));
  assert.equal(chosenDshApp(), app);
  assert.equal(await dshAppDir(), app, 'the chosen copy comes before the usual places and the system\'s lookup');
  assert.equal(await dshAppInstalled(), true);
  assert.equal(await findDsh(), which('dsh') ?? dshCliIn(app), 'a dsh command on PATH still comes first');

  rmSync(app, { recursive: true });
  assert.equal(chosenDshApp(), app, 'the choice is kept');
  assert.notEqual(await dshAppDir(), app, 'but not used once the app has moved');
});

test('DeepSeek Harness: Spotlight results skip the installer disk image, the Trash, copies inside other apps and apps without dsh', { skip: process.platform === 'win32' && 'Spotlight is macOS only' }, () => {
  const good = install(join(DATA, 'Apps', 'DeepSeek Harness.app'));
  const trashed = install(join(DATA, '.Trash', 'DeepSeek Harness.app'));
  const nested = install(join(DATA, 'Host.app', 'Contents', 'Resources', 'DeepSeek Harness.app'));
  const empty = join(DATA, 'Empty', 'DeepSeek Harness.app');
  mkdirSync(empty, { recursive: true });
  const dmg = '/Volumes/DeepSeek Harness/DeepSeek Harness.app';
  assert.deepEqual(usableSpotlightApps([dmg, trashed, nested, empty, good, join(DATA, 'Apps')]), [good]);
});

test('DeepSeek Harness status reports whether the desktop app was found, separately from the dsh command', async () => {
  const store = new Store(':memory:');
  try {
    const agents = new AgentIntegration(store);
    const before = await agents.status('deepseek-harness', true);
    assert.equal(before.appFound, await dshAppInstalled(), 'the status matches the app lookup Continue uses');
    rememberDshApp(install(join(DATA, 'Chosen', 'DeepSeek Harness.app')));
    const after = await agents.status('deepseek-harness', true);
    assert.equal(after.appFound, true, 'a chosen app counts at once');
    assert.ok(after.cli, 'and its dsh command is found');
    assert.equal((await agents.status('codex')).appFound, undefined, 'other agents have no desktop app to find');
  } finally { store.close(); }
});
