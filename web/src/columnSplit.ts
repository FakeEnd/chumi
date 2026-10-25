/**
 * The session view's column split: the transcript column's share of the width it shares with the assistant.
 * The divider between them drags; remembered in this browser only.
 */
const KEY = 'chumi.columnSplit';
export const DEFAULT_SPLIT = 5 / 12;
export const DIVIDER_WIDTH = 16; // px; the divider takes the place of the old column gap
export const MIN_LEFT = 340, MIN_RIGHT = 400; // the minmax() floors on .main in styles.css

/** Keep both columns at or above their minimum width; total is the width the two columns share (divider excluded). */
export function clampSplit(split: number, total: number): number {
  if (!Number.isFinite(split)) return DEFAULT_SPLIT;
  return Math.min(1 - MIN_RIGHT / total, Math.max(MIN_LEFT / total, split));
}

export function loadSplit(): number {
  try { const v = Number(localStorage.getItem(KEY)); return v > 0 && v < 1 ? v : DEFAULT_SPLIT; } catch { return DEFAULT_SPLIT; }
}

/** null forgets the saved split, so the default applies again. */
export function saveSplit(split: number | null): void {
  try { if (split === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, split.toFixed(4)); } catch { /* storage unavailable: not remembered */ }
}
