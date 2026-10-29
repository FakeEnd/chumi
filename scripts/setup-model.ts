import { Store } from '../server/db.ts';
import { MODEL_CATALOG, recommendModel } from '../server/asr/models.ts';
import { acquireDataDirectoryLock } from '../server/instance-lock.ts';
import { DATA_DIR } from '../server/paths.ts';
import { MODEL_BASE_URL, normalizeModelBaseUrl } from '../shared/model-source.ts';
import type { Settings } from '../server/settings.ts';

const [action, base] = process.argv.slice(2);
if (action !== 'base' && action !== 'model') throw new Error('Invalid setup model command.');
const lock = acquireDataDirectoryLock(DATA_DIR);
try {
  const store = new Store();
  try {
    const saveAsr = (patch: Record<string, string>) => {
      // Do not save defaults here: provider setup still needs to recognize a fresh install.
      const saved = store.getKV<Partial<Settings>>('settings', {});
      store.setKV('settings', { ...saved, asr: { ...saved.asr, ...patch } });
    };
    if (action === 'model') {
      let id = store.getSettings().asr.model;
      if (!MODEL_CATALOG.some((m) => m.id === id && !m.engine)) {
        id = recommendModel();
        console.error(`Unknown configured Whisper model. Using and saving the recommended model: ${id}.`);
        saveAsr({ model: id });
      }
      console.log(id);
    } else {
      const requested = base || process.env.CHUMI_MODEL_BASE_URL || store.getSettings().asr.modelBaseUrl || MODEL_BASE_URL;
      let selected: string;
      try { selected = normalizeModelBaseUrl(requested); }
      catch {
        selected = MODEL_BASE_URL;
        console.error('Invalid model download URL. Using and saving the Hugging Face source. Check CHUMI_MODEL_BASE_URL if it is set.');
      }
      if (base || process.env.CHUMI_MODEL_BASE_URL || selected !== requested) saveAsr({ modelBaseUrl: selected });
      console.log(selected);
    }
  } finally { store.close(); }
} finally { lock.release(); }
