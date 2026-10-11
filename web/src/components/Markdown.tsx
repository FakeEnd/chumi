import { useMemo } from 'react';
import { renderMd } from '../util.ts';
import { focusTime } from './Transcript.tsx';

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => renderMd(text), [text]);
  return (
    <div
      className={`md ${className}`}
      onClick={(e) => {
        const b = (e.target as HTMLElement).closest('button.ref') as HTMLButtonElement | null;
        if (!b) return;
        focusTime(Number(b.dataset.t), b.dataset.t2 ? Number(b.dataset.t2) : undefined);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
