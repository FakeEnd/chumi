import { useEffect, useRef } from 'react';
import { t } from './i18n.ts';

const drafts = new Set<() => boolean>();
export function registerDialogDraft(isDirty: () => boolean): () => void {
  drafts.add(isDirty);
  return () => { drafts.delete(isDirty); };
}
export function confirmDialogDiscard(): boolean {
  if (![...drafts].some((dirty) => dirty())) return true;
  const ask = (globalThis as { confirm?: (message: string) => boolean }).confirm;
  if (!ask?.(t('Discard unsaved changes?'))) return false;
  drafts.clear();
  return true;
}

/** Read the latest draft without registering a new guard on every keystroke. */
export function useDialogDraft(dirty: boolean) {
  const current = useRef(dirty);
  current.current = dirty;
  useEffect(() => registerDialogDraft(() => current.current), []);
}
