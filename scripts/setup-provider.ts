import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/db.ts';
import { acquireDataDirectoryLock, DataDirectoryInUseError } from '../server/instance-lock.ts';
import { DATA_DIR, DB_PATH } from '../server/paths.ts';
import type { Settings } from '../server/settings.ts';

const [action, provider] = process.argv.slice(2);
if (action !== 'current' && (action !== 'use' || !['codex', 'claude-cli', 'compatible'].includes(provider))) throw new Error('Invalid setup provider command.');

if (action === 'current') {
  // Read without opening Store: it can migrate the database while an older server is running.
  if (existsSync(DB_PATH)) {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get();
      const row = table && db.prepare("SELECT value FROM kv WHERE key = 'settings'").get() as { value: string } | undefined;
      let saved: Partial<Settings> | null = null;
      try { if (row) saved = JSON.parse(row.value); } catch { /* Treat invalid settings like Store.getKV. */ }
      console.log(saved?.ai?.provider ?? '');
    } finally { db.close(); }
  } else console.log('');
  process.exit(0);
}

let lock: ReturnType<typeof acquireDataDirectoryLock> | undefined;
try { lock = acquireDataDirectoryLock(DATA_DIR); } catch (error) {
  if (!(error instanceof DataDirectoryInUseError)) throw error;
  console.log('running');
  process.exit(0);
}
try {
  const store = new Store();
  try {
    const saved = store.getKV<Partial<Settings> | null>('settings', null)?.ai?.provider;
    if (saved) console.log(`existing:${saved}`);
    else {
      const settings = store.getSettings();
      settings.ai.provider = provider as Settings['ai']['provider'];
      if (provider === 'compatible') {
        settings.ai.compatible.preset = 'ollama';
        settings.ai.compatible.profiles.ollama.enabled = true;
      }
      store.saveSettings(settings);
      console.log(`saved:${provider}`);
    }
  } finally { store.close(); }
} finally { lock?.release(); }
