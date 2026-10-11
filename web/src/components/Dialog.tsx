import { useEffect, type ReactNode } from 'react';
import { setState } from '../store.ts';
import { t } from '../i18n.ts';

export function Dialog({ title, children, wide = false, footer }: { title: string; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setState({ dialog: null }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setState({ dialog: null }); }}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="dialog-head"><h2>{title}</h2><button className="link-btn" onClick={() => setState({ dialog: null })} aria-label={t('Close')}>✕</button></header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}
