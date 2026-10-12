import type { LocalModelPreset } from './local-models.ts';

export type LocalDownloadStatus = 'starting' | 'downloading' | 'verifying' | 'paused' | 'attention' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type LocalDownloadError = 'connection' | 'authentication' | 'unsupported_api' | 'server' | 'invalid_response' | 'incomplete' | 'memory' | 'disk' | 'runtime' | 'interrupted' | 'unknown_start' | 'job_missing';
export interface LocalModelDownload {
  id: string;
  preset: LocalModelPreset;
  baseUrl: string;
  modelId: string;
  modelName: string;
  context: number;
  status: LocalDownloadStatus;
  received: number;
  total: number;
  /** Ollama reports each layer independently; LM Studio reports the whole download. */
  progressScope: 'file' | 'model';
  error?: LocalDownloadError;
  remoteJobId?: string;
}
export function downloadPending(state: LocalModelDownload | null): boolean {
  return !!state && ['starting', 'downloading', 'verifying', 'paused', 'attention'].includes(state.status);
}
