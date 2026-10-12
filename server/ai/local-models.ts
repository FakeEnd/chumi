import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeCompatibleUrl } from '../../shared/compatible-provider.ts';
import { isLocalModelPreset, type LocalModelDiscovery, type LocalModelPreset } from '../../shared/local-models.ts';
import { which } from '../paths.ts';
import { readCompatibleKey } from './compatible-credentials.ts';

interface Dependencies {
  fetch?: typeof fetch;
  readKey?: typeof readCompatibleKey;
  installed?: (preset: LocalModelPreset) => boolean;
  timeoutMs?: number;
}

function installed(preset: LocalModelPreset): boolean {
  const app = preset === 'ollama' ? 'Ollama.app' : 'LM Studio.app';
  return [join('/Applications', app), join(homedir(), 'Applications', app),
    ...(preset === 'lmstudio' ? [join(homedir(), '.lmstudio', 'bin', 'lms')] : [])].some(existsSync)
    || !!which(preset === 'ollama' ? 'ollama' : 'lms');
}

/** Discovery only: no model ID, generation, download, settings write, or remote endpoint. */
export async function discoverLocalModels(target: { preset?: unknown; baseUrl?: unknown }, deps: Dependencies = {}): Promise<LocalModelDiscovery> {
  if (!isLocalModelPreset(target.preset)) throw new Error('Choose Ollama or LM Studio to find local models.');
  if (typeof target.baseUrl !== 'string' || target.baseUrl.length > 2048) throw new Error('Enter a valid model server URL.');
  const preset = target.preset;
  // Validate before reading credentials; never follow a redirect with a saved key.
  const baseUrl = normalizeCompatibleUrl(target.baseUrl, true);
  const result: LocalModelDiscovery = {
    state: 'unreachable', models: [], installation: (deps.installed ?? installed)(preset) ? 'detected' : 'not_detected',
  };
  let reached = false;
  try {
    const key = await (deps.readKey ?? readCompatibleKey)(preset, baseUrl);
    const response = await (deps.fetch ?? fetch)(`${baseUrl}/models`, {
      method: 'GET', headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000), redirect: 'error',
    });
    reached = true;
    if (!response.ok) {
      await response.body?.cancel();
      return { ...result, state: response.status === 401 || response.status === 403 ? 'auth_required' : 'error' };
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('data' in body) || !(body.data === null || Array.isArray(body.data))) {
      return { ...result, state: 'error' };
    }
    const ids = new Set<string>();
    for (const model of body.data ?? []) {
      if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim()
        || model.id.length > 200 || /[\x00-\x1f]/.test(model.id)) continue;
      if (model.remote_host || model.remote_model || model.remoteHost || model.remoteModel) continue;
      if (preset === 'ollama' && /(?:^|[-:])cloud(?:$|[-:])/i.test(model.id)) continue;
      if (model.type === 'embedding' || model.type === 'embeddings') continue;
      ids.add(model.id);
    }
    const models = [...ids].sort().map((id) => ({ id, name: id }));
    return { ...result, installation: 'detected', state: models.length ? 'ready' : 'empty', models };
  } catch {
    return { ...result, state: reached ? 'error' : 'unreachable' };
  }
}
