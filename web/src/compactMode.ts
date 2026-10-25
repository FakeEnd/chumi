/**
 * Compact view: the session view shows only its two columns (summary and transcript, assistant), without the header
 * and toolbar. Toggled with ⌘⇧. (Ctrl+Shift+. on Windows) or the toolbar button; remembered in this browser only.
 */
const KEY = 'chumi.compact';

export function loadCompact(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function saveCompact(on: boolean): void {
  try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* storage unavailable: not remembered */ }
}

/** The KeyboardEvent fields the shortcut looks at (the type is spelled out because the tests run without the DOM). */
export interface Keys { code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; repeat: boolean; isComposing: boolean }

/** ⌘⇧. or Ctrl+Shift+. — matched by physical key, so it works whatever Shift+. types on the keyboard layout. */
export function isCompactShortcut(e: Keys): boolean {
  return e.code === 'Period' && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey && !e.repeat && !e.isComposing;
}

/** platform: the server's process.platform (the browser runs on the same computer). */
export const compactShortcutLabel = (platform: string): string => (platform === 'darwin' ? '⌘⇧.' : 'Ctrl+Shift+.');

/** Inside Chumi.app the top bar is also the window's title bar (see shell.ts). */
export const inMacShell = (): boolean =>
  (globalThis as { document?: { documentElement: { dataset: Record<string, string | undefined> } } }).document?.documentElement.dataset.shell === 'mac';
