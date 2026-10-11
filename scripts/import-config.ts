/** Import settings/profile from a JSON file into the local Chumi database (stop the app first). */
import { readFileSync } from 'node:fs';
import { Store } from '../server/db.ts';
import { ensureDirs } from '../server/paths.ts';
import { deepMerge } from '../server/util.ts';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/import-config.ts <config.json>'); process.exit(2); }
ensureDirs();
/** Drop "_comment"-style keys at any depth; they document the file and are not settings. */
const strip = (v: unknown): unknown => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, strip(x)])) : v);
const cfg = strip(JSON.parse(readFileSync(file, 'utf8'))) as { settings?: Record<string, unknown>; profile?: Record<string, unknown> };
const store = new Store();
if (cfg.settings) store.saveSettings(deepMerge(store.getSettings(), cfg.settings));
if (cfg.profile) store.saveProfile({ ...store.getProfile(), ...cfg.profile });
store.close();
console.log('Imported', Object.keys(cfg).join(', '));
