export const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
export const MODEL_MIRROR_URL = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main';
export interface ModelDownloadSource { baseUrl: string; fromEnvironment: boolean }

export function modelSourceName(base: string): string {
  try { const url = new URL(base); return url.hostname === 'huggingface.co' ? 'Hugging Face' : url.host; }
  catch { return base; }
}

export function isModelMirror(base: string): boolean {
  try { return new URL(base).hostname === 'hf-mirror.com'; } catch { return false; }
}

export function normalizeModelBaseUrl(value: unknown): string {
  if (value === '') return '';
  const error = 'Use an HTTP(S) model download URL without credentials, a query or a fragment.';
  if (typeof value !== 'string') throw new Error(error);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(error); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(error);
  return url.href.replace(/\/+$/, '');
}
