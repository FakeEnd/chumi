import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class DataDirectoryInUseError extends Error {
  constructor() { super('Chumi is already using this data folder. Close the other Chumi server before starting another one.'); }
}

/**
 * Only the app server owns this separate database. Holding its exclusive transaction prevents
 * another server from recovering a live meeting, without blocking the meeting database or MCP.
 * The OS releases SQLite's file locks even after a crash; no stale PID or lockfile removal races.
 */
export function acquireDataDirectoryLock(directory: string): { release(): void } {
  mkdirSync(directory, { recursive: true });
  const path = join(realpathSync(directory), 'server-lock.sqlite');
  const lock = new DatabaseSync(path);
  try {
    lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
  } catch (error) {
    lock.close();
    const code = (error as { errcode?: number }).errcode;
    if (code != null && [5, 6].includes(code & 0xff)) {
      throw new DataDirectoryInUseError();
    }
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      lock.close();
      released = true;
    },
  };
}
