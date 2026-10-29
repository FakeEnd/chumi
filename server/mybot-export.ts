import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expandDir, type MybotExporter } from './integrations/mybot.ts';
import type { Store } from './db.ts';
import { uid } from './util.ts';

export function validateMybotDirectory(value: unknown): string {
  const dir = typeof value === 'string' ? value.trim() : '';
  if (!dir || !(isAbsolute(dir) || dir.startsWith('~/'))) throw new Error('Choose an absolute mybot export folder, or a path starting with ~/.');
  const expanded = expandDir(dir), probe = join(expanded, `.chumi-write-test-${uid()}`);
  try {
    mkdirSync(expanded, { recursive: true });
    closeSync(openSync(probe, 'wx', 0o600));
    rmSync(probe);
  } catch {
    throw new Error('The mybot export folder cannot be written. Choose another folder or check its permissions.');
  }
  return dir;
}

/** Yield between meetings so a bulk export does not stall live audio and settings responses. */
export async function exportMybotSessions(store: Pick<Store, 'getSettings' | 'listSessions'>, exporter: Pick<MybotExporter, 'sync' | 'dir'>, force = false): Promise<{ exported: number; dir: string }> {
  const config = JSON.stringify(store.getSettings().integrations.mybot);
  const dir = exporter.dir;
  let exported = 0;
  await setImmediate();
  for (const session of store.listSessions()) {
    const current = store.getSettings().integrations.mybot;
    // A newer save owns the next export, especially if sharing was disabled meanwhile.
    if (JSON.stringify(current) !== config || (!current.enabled && !force)) break;
    if (exporter.sync(session.id, force)) exported++;
    await setImmediate();
  }
  return { exported, dir };
}
