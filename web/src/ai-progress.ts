import { t } from './i18n.ts';
import type { Output } from './types.ts';

export function digestProgress(output: Pick<Output, 'status' | 'data'> | undefined): string | null {
  const progress = output?.data?.progress;
  if (output?.status !== 'streaming' || progress?.stage !== 'digests' || !Number.isInteger(progress.completed) || !Number.isInteger(progress.total) || progress.total < 1 || progress.completed < 0 || progress.completed > progress.total) return null;
  return t('Summarising earlier parts {completed}/{total}…', { completed: progress.completed, total: progress.total });
}
