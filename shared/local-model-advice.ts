import type { LocalModelPreset } from './local-models.ts';

export const GiB = 2 ** 30;
export const ESTIMATE_CONTEXTS = [4096, 8192, 16384, 32768] as const;
export const MODEL_CATALOG_CHECKED = '2026-10-11';

export interface LocalHardware {
  platform: string;
  arch: string;
  osRelease: string;
  chip: string;
  cores: number;
  memoryBytes: number;
  homeDiskFreeBytes: number | null;
  acceleration: 'metal' | 'cpu-or-unknown';
  speechModel: string;
  systemReserveBytes: number;
  speechReserveBytes: number;
  modelBudgetBytes: number;
}

export interface ModelDownload {
  quantization: string;
  bytes: number;
  url: string;
  /** Exact Ollama tag or Hugging Face repository to search for in LM Studio. */
  identifier: string;
}
export interface SuggestedLocalModel {
  id: string;
  name: string;
  parametersB: number;
  layers: number;
  kvHeads: number;
  headDim: number;
  downloads: Record<LocalModelPreset, ModelDownload>;
}

// Download metadata: exact quantizations, verified against Ollama library tags and
// Qwen's own GGUF repositories. Architecture: Qwen/Qwen3-{size}B/config.json.
// Small official Qwen GGUFs are Q8_0; do not label them as the Ollama Q4_K_M build.
function qwen(size: string, layers: number, ollamaBytes: number, ggufBytes: number, ggufQuant = 'Q4_K_M'): SuggestedLocalModel {
  const identifier = `qwen3:${size.toLowerCase()}b-q4_K_M`;
  const repo = `Qwen/Qwen3-${size}B-GGUF`;
  return { id: `qwen3-${size}b`, name: `Qwen3 ${size}B`, parametersB: Number(size), layers, kvHeads: 8, headDim: 128,
    downloads: {
      ollama: { identifier, quantization: 'Q4_K_M', bytes: ollamaBytes, url: `https://ollama.com/library/${identifier}` },
      lmstudio: { identifier: repo, quantization: ggufQuant, bytes: ggufBytes,
        url: `https://huggingface.co/${repo}/blob/main/Qwen3-${size}B-${ggufQuant}.gguf` },
    },
  };
}
export const LOCAL_MODEL_CATALOG: SuggestedLocalModel[] = [
  qwen('0.6', 28, 523_000_000, 639_446_688, 'Q8_0'),
  qwen('1.7', 28, 1_400_000_000, 1_834_426_016, 'Q8_0'),
  qwen('4', 36, 2_600_000_000, 2_497_280_256),
  qwen('8', 36, 5_200_000_000, 5_027_783_488),
  qwen('14', 40, 9_300_000_000, 9_001_752_960),
  qwen('32', 64, 20_000_000_000, 19_762_149_024),
];

export interface MemoryEstimate { lowBytes: number; highBytes: number }

/** One text request, F16 KV cache. Runtime/compute buffers are a heuristic range, not a benchmark. */
export function estimateModelMemory(model: SuggestedLocalModel, preset: LocalModelPreset, context: number): MemoryEstimate {
  if (!(ESTIMATE_CONTEXTS as readonly number[]).includes(context)) throw new Error('Unsupported estimate context.');
  const weights = model.downloads[preset].bytes;
  const kv = 2 * model.layers * model.kvHeads * model.headDim * 2 * context;
  return { lowBytes: weights * 1.1 + kv + 0.5 * GiB, highBytes: weights * 1.3 + kv * 1.15 + GiB };
}

export type ModelFit = 'fits' | 'tight' | 'too_large' | 'unsupported' | 'unknown';
export interface ModelAssessment {
  model: SuggestedLocalModel;
  download: ModelDownload;
  memory: MemoryEstimate;
  fit: ModelFit;
  recommended: boolean;
  diskRequiredBytes: number;
  disk: 'enough' | 'low' | 'unknown';
}

export function runtimeUnsupported(hw: LocalHardware, preset: LocalModelPreset): boolean {
  // Both runtimes require macOS 14+; LM Studio also requires Apple Silicon.
  // Do not mistake ARM Linux for a Mac.
  if (hw.platform !== 'darwin') return false;
  const darwinMajor = Number.parseInt(hw.osRelease);
  return (darwinMajor > 0 && darwinMajor < 23) || (preset === 'lmstudio' && hw.arch !== 'arm64');
}

export function assessLocalModels(hw: LocalHardware, preset: LocalModelPreset, context: number): ModelAssessment[] {
  const rows: ModelAssessment[] = LOCAL_MODEL_CATALOG.map((model) => {
    const download = model.downloads[preset];
    const memory = estimateModelMemory(model, preset, context);
    const diskRequiredBytes = download.bytes * 1.15 + GiB;
    const fit: ModelFit = runtimeUnsupported(hw, preset) ? 'unsupported'
      : !Number.isFinite(hw.modelBudgetBytes) || !Number.isFinite(hw.memoryBytes) || hw.memoryBytes <= 0 ? 'unknown'
      : memory.lowBytes > hw.modelBudgetBytes ? 'too_large'
      : memory.highBytes > hw.modelBudgetBytes * 0.9 ? 'tight' : 'fits';
    return { model, download, memory, fit, recommended: false, diskRequiredBytes,
      disk: hw.homeDiskFreeBytes == null ? 'unknown' : hw.homeDiskFreeBytes < diskRequiredBytes ? 'low' : 'enough' };
  });
  // A starting point for live meetings, not a claim that the largest fitting model is fastest.
  const parameterCap = hw.acceleration === 'metal' ? 8 : 1.7;
  const start = rows.filter((row) => row.fit === 'fits' && row.disk !== 'low' && row.model.parametersB <= parameterCap).at(-1);
  if (start) start.recommended = true;
  return rows;
}
