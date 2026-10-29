/** Keep at least two threads, including on single-core virtual machines. */
export const maxAsrThreads = (cores: number): number => Math.max(2, Math.min(16, cores));

export function threadDraftValue(draft: string, saved: number, cores: number): number {
  const value = Number(draft);
  return !draft.trim() || !Number.isFinite(value) ? saved : Math.max(2, Math.min(maxAsrThreads(cores), Math.round(value)));
}
