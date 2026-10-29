/** Browser-safe configuration shared by the server and settings UI. Never store API keys here. */
export const COMPATIBLE_PRESETS = {
  ollama: { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', local: true },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', local: true },
  qwen: { label: 'Qwen / Alibaba Cloud', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', local: false },
  doubao: { label: 'Doubao / Volcengine', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', local: false },
  minimax: { label: 'MiniMax', baseUrl: 'https://api.minimax.cn/v1', local: false },
  glm: { label: 'GLM / Zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', local: false },
  custom: { label: 'Custom compatible API', baseUrl: '', local: false },
} as const;

export type CompatiblePreset = keyof typeof COMPATIBLE_PRESETS;
export type StructuredOutputMode = 'prompt' | 'json_object' | 'json_schema';

export interface CompatibleProfile {
  /** Remote access requires a separate, explicit opt-in for this saved profile. */
  enabled: boolean;
  baseUrl: string;
  model: string;
  supportsImages: boolean;
  structuredOutput: StructuredOutputMode;
  maxOutputTokens: number;
  contextTokens: number;
  /** Only an explicit choice may override the local server’s context setting. */
  contextExplicit: boolean;
}

export interface CompatibleSettings {
  preset: CompatiblePreset;
  profiles: Record<CompatiblePreset, CompatibleProfile>;
}

export function isCompatiblePreset(value: unknown): value is CompatiblePreset {
  return typeof value === 'string' && Object.hasOwn(COMPATIBLE_PRESETS, value);
}

export function defaultCompatibleSettings(): CompatibleSettings {
  const profiles = Object.fromEntries(Object.entries(COMPATIBLE_PRESETS).map(([id, preset]) => [id, {
    enabled: preset.local,
    baseUrl: preset.baseUrl,
    model: '',
    supportsImages: false,
    structuredOutput: 'prompt',
    maxOutputTokens: 4096,
    contextTokens: 8192,
    contextExplicit: false,
  }])) as CompatibleSettings['profiles'];
  return { preset: 'ollama', profiles };
}

/** Keep secrets out of URLs and require encryption for remote endpoints. */
export function normalizeCompatibleUrl(value: string, local: boolean): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid model server URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) throw new Error('Model server URLs cannot contain credentials, query parameters, or fragments.');
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)) throw new Error('Remote model servers require HTTPS.');
  if (local && !loopback) throw new Error('Local model presets must use a loopback address on this computer.');
  return url.toString().replace(/\/+$/, '');
}

/** Validate persisted input before it can affect requests or reach the settings database. */
export function validateCompatibleSettings(value: unknown): CompatibleSettings {
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(value) || !isCompatiblePreset(value.preset) || !object(value.profiles)) throw new Error('Invalid compatible model settings.');
  if (Object.keys(value).some((key) => !['preset', 'profiles'].includes(key))) throw new Error('Unknown compatible model setting.');
  if (Object.keys(value.profiles).some((key) => !isCompatiblePreset(key))) throw new Error('Unknown model preset.');
  const profiles = {} as CompatibleSettings['profiles'];
  const fields = ['enabled', 'baseUrl', 'model', 'supportsImages', 'structuredOutput', 'maxOutputTokens', 'contextTokens', 'contextExplicit'];
  for (const id of Object.keys(COMPATIBLE_PRESETS) as CompatiblePreset[]) {
    const profile = value.profiles[id];
    if (!object(profile) || Object.keys(profile).some((key) => !fields.includes(key)) ||
        typeof profile.enabled !== 'boolean' || typeof profile.baseUrl !== 'string' || typeof profile.model !== 'string' ||
        typeof profile.supportsImages !== 'boolean' || typeof profile.structuredOutput !== 'string' ||
        !['prompt', 'json_object', 'json_schema'].includes(profile.structuredOutput) || typeof profile.maxOutputTokens !== 'number' ||
        !Number.isInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 64 || profile.maxOutputTokens > 32768) {
      throw new Error('Invalid model profile. API keys must be saved separately in Keychain.');
    }
    const contextTokens = profile.contextTokens === undefined ? 8192 : profile.contextTokens; // Profiles saved before context limits used the 8K recommendation.
    if (typeof contextTokens !== 'number' || !Number.isInteger(contextTokens) || contextTokens < 1024 || contextTokens > 1048576) throw new Error('Context tokens must be a whole number from 1024 to 1048576.');
    if (profile.contextExplicit !== undefined && typeof profile.contextExplicit !== 'boolean') throw new Error('Invalid model profile. API keys must be saved separately in Keychain.');
    if (profile.baseUrl.length > 2048 || profile.model.length > 200 || /[\r\n\x00-\x1f]/.test(profile.model)) throw new Error('Invalid model URL or model ID.');
    const baseUrl = profile.baseUrl.trim() ? normalizeCompatibleUrl(profile.baseUrl, COMPATIBLE_PRESETS[id].local) : '';
    if (id !== 'custom' && !baseUrl) throw new Error('A model server URL is required.');
    profiles[id] = {
      enabled: profile.enabled,
      baseUrl,
      model: profile.model.trim(),
      supportsImages: profile.supportsImages,
      structuredOutput: profile.structuredOutput as StructuredOutputMode,
      maxOutputTokens: profile.maxOutputTokens,
      contextTokens,
      contextExplicit: profile.contextExplicit === true,
    };
  }
  return { preset: value.preset, profiles };
}
