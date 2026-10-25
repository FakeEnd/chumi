import { useEffect, type ReactNode } from 'react';
import { setState } from '../store.ts';
import { t } from '../i18n.ts';
import { composing } from '../keys.ts';

export function Dialog({ title, children, wide = false, footer, className = '' }: { title: string; children: ReactNode; wide?: boolean; footer?: ReactNode; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !composing(e)) setState({ dialog: null }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setState({ dialog: null }); }}>
      <div className={`dialog ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="dialog-head"><h2>{title}</h2><button className="link-btn" onClick={() => setState({ dialog: null })} aria-label={t('Close')}>✕</button></header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}
