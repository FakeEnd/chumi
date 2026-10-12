export type LocalModelPreset = 'ollama' | 'lmstudio';

export function isLocalModelPreset(value: unknown): value is LocalModelPreset {
  return value === 'ollama' || value === 'lmstudio';
}

export interface LocalModelDiscovery {
  state: 'ready' | 'empty' | 'unreachable' | 'auth_required' | 'error';
  models: Array<{ id: string; name: string }>;
  /** Absence from standard locations is not proof that the app is uninstalled. */
  installation: 'detected' | 'not_detected';
}
