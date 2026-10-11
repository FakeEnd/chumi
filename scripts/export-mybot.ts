/** Export all saved sessions as chumi-transcript/1 JSONL for mybot (works with the app closed). */
import { Store } from '../server/db.ts';
import { ensureDirs } from '../server/paths.ts';
import { MybotExporter } from '../server/integrations/mybot.ts';

ensureDirs();
const store = new Store();
const r = new MybotExporter(store).exportAll();
store.close();
console.log(`Exported ${r.exported} session(s) to ${r.dir}`);
