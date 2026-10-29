import { useRef, useState } from 'react';
import { useStore } from '../store.ts';
import { resumeSaved } from '../actions.ts';
import type { Session } from '../types.ts';
import { sourceLabel } from '../util.ts';
import { t } from '../i18n.ts';

export function ResumeRecording({ session, onResumed }: { session: Session; onResumed?: () => void }) {
  const live = useStore((s) => s.live);
  const fallback = useStore((s) => s.settings?.audio.source);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  if (session.status !== 'interrupted' || session.audio_source === 'mobile' || (live && live.status !== 'idle')) return null;
  const sources = ['mic', 'system', 'both'];
  const source = session.audio_source && sources.includes(session.audio_source) ? session.audio_source : fallback && sources.includes(fallback) ? fallback : 'mic';
  const resume = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { if (await resumeSaved(session.id, source)) onResumed?.(); }
    finally { pending.current = false; setBusy(false); }
  };
  return <button className="btn small" disabled={busy} title={t('Resume recording with {source}', { source: sourceLabel(source) })} onClick={() => void resume()}>{busy ? t('Starting…') : t('Resume recording')}</button>;
}
