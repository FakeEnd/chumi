/** Import settings/profile from a JSON file into the local Chumi database (stop the app first). */
import { readFileSync } from 'node:fs';
import { Store } from '../server/db.ts';
import { ensureDirs } from '../server/paths.ts';
import { deepMerge } from '../server/util.ts';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/import-config.ts <config.json>'); process.exit(2); }
ensureDirs();
const cfg = JSON.parse(readFileSync(file, 'utf8'));
const store = new Store();
if (cfg.settings) store.saveSettings(deepMerge(store.getSettings(), cfg.settings));
if (cfg.profile) store.saveProfile({ ...store.getProfile(), ...cfg.profile });
store.close();
console.log('Imported', Object.keys(cfg).filter((k) => !k.startsWith('_')).join(', '));
