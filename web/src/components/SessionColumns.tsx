import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { clampSplit, DEFAULT_SPLIT, DIVIDER_WIDTH, loadSplit, saveSplit } from '../columnSplit.ts';
import { t } from '../i18n.ts';

/**
 * The session view's two columns with a divider between them. Drag the divider (or focus it and use the arrow keys)
 * to change the split; double-click it to go back to 5:7. The columns come in as props so dragging re-renders
 * only this component, not the transcript and assistant.
 */
export function SessionColumns({ left, right }: { left: ReactNode; right: ReactNode }) {
  const [split, setSplit] = useState(loadSplit);
  // fr factors summing to 100: below 1 in total, the grid would leave part of the row empty.
  const style = { '--split-left': `${split * 100}fr`, '--split-right': `${(1 - split) * 100}fr` } as CSSProperties;
  return (
    <main className="main" style={style}>
      {left}
      <ColumnDivider split={split} onChange={setSplit} />
      {right}
    </main>
  );
}

/** Where the columns start and how much width they share, measured from .main (the divider's parent). */
function measure(divider: HTMLElement): { start: number; total: number } {
  const main = divider.parentElement!;
  const box = main.getBoundingClientRect(), cs = getComputedStyle(main);
  const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
  return { start: box.left + padL, total: box.width - padL - padR - DIVIDER_WIDTH };
}

function ColumnDivider({ split, onChange }: { split: number; onChange: (split: number) => void }) {
  const drag = useRef<{ start: number; total: number; grab: number; split: number; moved: boolean } | null>(null);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    // grab: where on the divider the pointer went down, so the divider doesn't jump to centre under it
    drag.current = { ...measure(el), grab: e.clientX - el.getBoundingClientRect().left, split, moved: false };
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('col-resizing');
    e.preventDefault(); // no text selection while dragging
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.split = clampSplit((e.clientX - d.grab - d.start) / d.total, d.total);
    d.moved = true;
    onChange(d.split);
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove('col-resizing');
    if (d.moved) saveSplit(d.split); // a plain click (or the two halves of a double-click) saves nothing
  };
  const reset = () => { onChange(DEFAULT_SPLIT); saveSplit(null); };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? -0.02 : e.key === 'ArrowRight' ? 0.02 : 0;
    if (!step) return;
    e.preventDefault();
    const next = clampSplit(split + step, measure(e.currentTarget).total);
    onChange(next);
    saveSplit(next);
  };

  return (
    <div
      className="col-divider" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={t('Resize columns')} aria-valuenow={Math.round(split * 100)} aria-valuemin={0} aria-valuemax={100}
      title={t('Drag to resize · double-click to reset')}
      onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onDoubleClick={reset} onKeyDown={key}
    />
  );
}
