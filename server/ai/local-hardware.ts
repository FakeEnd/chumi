import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { GiB, type LocalHardware } from '../../shared/local-model-advice.ts';

// Headroom for the selected ASR model plus audio buffers, even when ASR is currently idle.
// These are conservative planning allowances, not measurements of live processes.
export function speechMemoryReserve(model: string): number {
  if (model.startsWith('ggml-tiny')) return 0.5 * GiB;
  if (model.startsWith('ggml-base')) return 0.75 * GiB;
  if (model.startsWith('ggml-small')) return GiB;
  if (model.startsWith('ggml-medium')) return 2 * GiB;
  if (model.startsWith('ggml-large-v3-turbo')) return 2.5 * GiB;
  return 3.5 * GiB;
}

export function hardwareBudget(input: Omit<LocalHardware, 'systemReserveBytes' | 'speechReserveBytes' | 'modelBudgetBytes' | 'acceleration'>): LocalHardware {
  const memory = Number.isFinite(input.memoryBytes) && input.memoryBytes > 0 ? input.memoryBytes : 0;
  const systemReserveBytes = Math.max(3 * GiB, Math.min(8 * GiB, memory * 0.2));
  const speechReserveBytes = speechMemoryReserve(input.speechModel);
  const acceleration = input.platform === 'darwin' && input.arch === 'arm64' ? 'metal' : 'cpu-or-unknown';
  // Unified RAM must not be counted again as VRAM. Leave additional GPU/runtime headroom.
  const modelBudgetBytes = Math.max(0, Math.min(memory * 0.65, memory - systemReserveBytes - speechReserveBytes));
  return { ...input, memoryBytes: memory, systemReserveBytes, speechReserveBytes, modelBudgetBytes, acceleration };
}

export async function localHardware(speechModel: string): Promise<LocalHardware> {
  let homeDiskFreeBytes: number | null = null;
  try { const disk = await statfs(os.homedir()); homeDiskFreeBytes = disk.bavail * disk.bsize; } catch { /* Unknown is not zero. */ }
  return hardwareBudget({ platform: os.platform(), arch: os.arch(), osRelease: os.release(), chip: os.cpus()[0]?.model ?? 'Unknown',
    cores: os.cpus().length, memoryBytes: os.totalmem(), homeDiskFreeBytes, speechModel });
}
