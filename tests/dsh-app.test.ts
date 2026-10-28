import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'chumi-dsh-app-'));
process.env.CHUMI_DATA_DIR = DATA;
const { chosenDshApp, dshAppDir, dshAppInstalled, dshCliIn, findDsh, rememberDshApp, usableSpotlightApps } = await import('../server/projects/dsh.ts');
const { which } = await import('../server/paths.ts');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

/** A stand-in desktop install: only the dsh command, where the real app keeps it. */
function install(dir: string): string {
  mkdirSync(dirname(dshCliIn(dir)), { recursive: true });
  writeFileSync(dshCliIn(dir), '', { mode: 0o755 });
  return dir;
}

test('DeepSeek Harness: a chosen app is remembered only when its dsh command is inside, and used while it is there', () => {
  const app = join(DATA, 'DIY_APP', 'DeepSeek Harness.app');
  mkdirSync(app, { recursive: true });
  assert.throws(() => rememberDshApp(app), /not the DeepSeek Harness app|no DeepSeek Harness in it/);
  assert.equal(chosenDshApp(), null, 'nothing is remembered from a refused choice');

  rememberDshApp(install(app));
  assert.equal(chosenDshApp(), app);
  assert.equal(dshAppDir(), app, 'the chosen copy comes before the usual places and the system\'s lookup');
  assert.equal(dshAppInstalled(), true);
  assert.equal(findDsh(), which('dsh') ?? dshCliIn(app), 'a dsh command on PATH still comes first');

  rmSync(app, { recursive: true });
  assert.equal(chosenDshApp(), app, 'the choice is kept');
  assert.notEqual(dshAppDir(), app, 'but not used once the app has moved');
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
