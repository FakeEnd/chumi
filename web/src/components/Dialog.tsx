import { useEffect, useRef, type ReactNode } from 'react';
import { closeDialog } from '../store.ts';
import { t } from '../i18n.ts';
import { composing } from '../keys.ts';

let opener: HTMLElement | null = null;

export function Dialog({ title, children, wide = false, footer, className = '' }: { title: string; children: ReactNode; wide?: boolean; footer?: ReactNode; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const focused = document.activeElement as HTMLElement | null;
  const previous = useRef(focused?.closest('.overlay') ? opener : focused);
  useEffect(() => {
    const dialog = root.current;
    if (!dialog) return;
    opener = previous.current;
    // Chromium can report client rects for links inside closed details.
    const controls = (area: Element | null) => area ? [...area.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]')].filter((el) => {
      if (el.tabIndex < 0 || el.matches(':disabled') || !el.getClientRects().length) return false;
      for (let details = el.closest('details:not([open])'); details; details = details.parentElement?.closest('details:not([open])') ?? null) {
        if (!details.querySelector('summary')?.contains(el)) return false;
      }
      return true;
    }) : [];
    const focus = (items: HTMLElement[]) => {
      for (const item of items) { item.focus(); if (document.activeElement === item) return; }
      dialog.focus();
    };
    const focusFirst = () => focus(controls(dialog));
    if (!dialog.contains(document.activeElement)) focusFirst();
    const onFocus = (e: FocusEvent) => {
      const target = e.target as Node;
      if (!dialog.contains(target) && !document.querySelector('.notices')?.contains(target)) focusFirst();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || composing(e)) return;
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
      if (e.key === 'Tab') {
        // Leave native Tab navigation intact inside each region, including summary toggles.
        const groups = [controls(dialog), controls(document.querySelector('.notices'))].filter((items) => items.length);
        const group = groups.findIndex((items) => items.includes(document.activeElement as HTMLElement));
        if (group < 0 || document.activeElement === (e.shiftKey ? groups[group][0] : groups[group].at(-1))) {
          e.preventDefault();
          const next = group < 0 ? (e.shiftKey ? groups.length - 1 : 0) : (group + (e.shiftKey ? -1 : 1) + groups.length) % groups.length;
          const items = groups[next] ?? [];
          focus(e.shiftKey ? items.slice().reverse() : items);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      if (previous.current?.isConnected) previous.current.focus();
    };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeDialog(); }}>
      <div ref={root} tabIndex={-1} className={`dialog ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="dialog-head"><h2>{title}</h2><button className="link-btn" onClick={() => closeDialog()} aria-label={t('Close')}>✕</button></header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}
