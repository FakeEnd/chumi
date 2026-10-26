/**
 * Chumi.app integration. Inside the app the page's top bar is also the window's title bar:
 * the app hides the macOS title, centres the traffic lights in the top bar, and drags the window
 * from its empty parts. The page reports where the top bar and its controls are; in a normal
 * browser there is no message handler and this does nothing.
 */
import { openSession } from './actions.ts';

type Handler = { postMessage(message: unknown): void };

const INTERACTIVE = ['button', 'input', 'select', 'textarea', 'a', 'label', '[role=button]', '[tabindex]'].map((s) => `.topbar ${s}`)
  .concat(['.dialog', '.notice', '.sel-toolbar']).join(',');

/** Page → app message for the desktop pet (Settings → Desktop pet). False outside Chumi.app. */
export function petShell(type: 'pet-reset'): boolean {
  const w = window as unknown as { chumiShell?: Handler; webkit?: { messageHandlers?: Record<string, Handler> } };
  const handler = w.chumiShell ?? w.webkit?.messageHandlers?.chumiShell;
  handler?.postMessage({ type });
  return !!handler;
}

export function startShellBridge(): void {
  const handler = (window as unknown as { webkit?: { messageHandlers?: Record<string, Handler> } }).webkit?.messageHandlers?.chumiShell;
  if (!handler && !(window as unknown as { chumiShell?: Handler }).chumiShell) return;
  // App → page: the desktop pet opens a meeting here, optionally at a transcript time.
  (window as unknown as { chumiOpen: unknown }).chumiOpen = (o: { session?: unknown; t?: unknown; t2?: unknown }) => {
    if (typeof o?.session !== 'string') return;
    const t = Number(o.t), t2 = Number(o.t2);
    void openSession(o.session, Number.isFinite(t) && o.t != null ? { t, t2: Number.isFinite(t2) && o.t2 != null ? t2 : undefined } : undefined);
  };
  if (!handler) return;
  let last = '';
  let timer = 0;
  const send = () => {
    timer = 0;
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const b = bar.getBoundingClientRect();
    const r = (x: DOMRect) => [x.left, x.top, x.width, x.height].map((n) => Math.round(n));
    const noDrag = [...document.querySelectorAll(INTERACTIVE)].map((e) => e.getBoundingClientRect())
      .filter((x) => x.width > 0 && x.top < b.bottom && x.bottom > b.top).map(r);
    const msg = JSON.stringify({ type: 'topbar', bar: r(b), noDrag });
    if (msg !== last) { last = msg; handler.postMessage(JSON.parse(msg)); }
  };
  const schedule = () => { if (!timer) timer = window.setTimeout(send, 120); };
  new ResizeObserver(schedule).observe(document.documentElement);
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled'] });
  window.addEventListener('resize', schedule);
  schedule();
}
