import { useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import { api } from '../api.ts';
import { saveSettings } from '../actions.ts';
import { msg, plural, t, tn } from '../i18n.ts';
import { setProjectContext, useProjectContextOn } from '../projectContext.ts';
import { IconFolder } from './icons.tsx';
import type { Output } from '../types.ts';

type Health = { ok: boolean; url: string; error?: string };
type Source = { n: number; ref: string; agent: string; title: string; updated_at: string | null; cwd: string };
type Meta = { status: 'used' | 'none_found' | 'no_project' | 'unavailable' | 'timeout' | 'error'; project: string; url: string; sources: Source[]; detail?: string };

const AGENT_LABEL: Record<string, string> = { 'Claude Code': msg('Claude Code'), Codex: msg('Codex'), 'Chumi meeting': msg('Chumi meeting') };
const START_HINT = msg("mybot isn't answering at {url}. Start it from your mybot folder with ./run_chatbot.sh, or turn Project context off. Questions still work without it.");

function useMybotHealth(active: boolean, key: unknown): Health | null {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    if (!active) { setHealth(null); return; }
    let live = true;
    void api<Health>('/api/integrations/mybot/server').then((h) => { if (live) setHealth(h); }).catch(() => {});
    return () => { live = false; };
  }, [active, key]);
  return health;
}

/** Ask box toggle: also search this project's earlier agent sessions when answering (per meeting, off by default). */
export function ProjectContextToggle() {
  const session = useStore((s) => s.data?.session);
  const project = useStore((s) => (s.data?.session.project_id ? s.projects.find((p) => p.id === s.data!.session.project_id) : undefined));
  const on = useProjectContextOn(session?.id);
  if (!session) return null;
  const active = on && !!project;
  const title = project
    ? t('Also search earlier Claude Code and Codex sessions in {folder} (through mybot) when answering. Matching excerpts are sent to your AI provider with the question. Stays on for this meeting until you turn it off.', { folder: project.workspace })
    : t('Assign this meeting to a project first, so Chumi knows which folder to look in.');
  return (
    <button className={`chip chip-toggle${active ? ' on' : ''}`} aria-pressed={active} disabled={!project} title={title} onClick={() => setProjectContext(session.id, !on)}>
      <IconFolder width={12} height={12} aria-hidden="true" /> {t('Project context')}
    </button>
  );
}

/** Under the Ask box while Project context is on but mybot is not reachable. */
export function ProjectContextNote() {
  const session = useStore((s) => s.data?.session);
  const on = useProjectContextOn(session?.id) && !!session?.project_id;
  const url = useStore((s) => s.settings?.integrations.mybot.serverUrl);
  // Checked when turned on, per meeting, and when the address changes; answer cards report later failures.
  const health = useMybotHealth(on, `${session?.id}|${url}`);
  if (!on || !health || health.ok) return null;
  return <p className="small warn-text pc-note">{t(START_HINT, { url: health.url })}</p>;
}

/** On an answer card: which earlier sessions were used, or why none were. */
export function ProjectContextSources({ o }: { o: Output }) {
  const [open, setOpen] = useState(false);
  const pc = o.data?.projectContext as Meta | undefined;
  if (o.scope !== 'project' || !pc) return null;
  if (pc.status === 'used') {
    return (
      <div className="pc-sources">
        <button className="range" aria-expanded={open} onClick={() => setOpen(!open)} title={t('Earlier agent sessions in this project that were added to the question, cited as [P1], [P2], …')}>
          <IconFolder width={11} height={11} aria-hidden="true" /> {plural(pc.sources.length, '{n} earlier agent session', '{n} earlier agent sessions')} {open ? '▴' : '▾'}
        </button>
        {open && (
          <ol>
            {pc.sources.map((s) => (
              <li key={s.ref}>
                <span className="pc-n">P{s.n}</span> <span className="pc-agent">{AGENT_LABEL[s.agent] ? t(AGENT_LABEL[s.agent]) : s.agent}</span> {s.title}
                {s.updated_at && <span className="muted"> · {s.updated_at.slice(0, 10)}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }
  const note = pc.status === 'none_found' ? t('Project context: no related earlier sessions were found in {project}.', { project: pc.project })
    : pc.status === 'unavailable' ? t(START_HINT, { url: pc.url })
      : pc.status === 'timeout' ? t('Project context was not used: mybot did not answer in time.')
        : pc.status === 'no_project' ? t('Project context was not used: this meeting is not assigned to a project.')
          : t('Project context was not used: mybot returned an error ({detail}).', { detail: pc.detail ?? '' });
  return <p className={`small pc-note ${pc.status === 'none_found' ? 'muted' : 'warn-text'}`}>{note}</p>;
}

/** Settings → Integrations: where mybot runs. */
export function MybotServerSettings() {
  const url = useStore((s) => s.settings?.integrations.mybot.serverUrl ?? '');
  const [draft, setDraft] = useState(url);
  const [health, setHealth] = useState<Health | null>(null);
  const check = () => { setHealth(null); void api<Health>('/api/integrations/mybot/server').then(setHealth).catch(() => {}); };
  useEffect(() => { setDraft(url); check(); }, [url]);
  return (
    <>
      <h3>{t('Project context in questions')}</h3>
      <p className="small">{tn('Turn on {button} in the Ask box and Chumi also searches a running mybot for earlier Claude Code and Codex sessions in the meeting\'s project folder, and adds the best matches (about 2,500 tokens) to your question. Nothing is searched while it is off.', { button: <b>{t('Project context')}</b> })}</p>
      <label className="field"><span>{t('mybot address')}</span>
        <div className="field-row" style={{ marginBottom: 0 }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} placeholder="http://127.0.0.1:8788" />
          <button className="btn small" disabled={draft.trim() === url} onClick={() => void saveSettings({ integrations: { mybot: { serverUrl: draft.trim() } } })}>{t('Save')}</button>
          <button className="btn small" onClick={check}>{t('Check')}</button>
        </div>
      </label>
      {health && <p className={`small ${health.ok ? 'ok-text' : 'warn-text'}`}>{health.ok ? t('mybot is running at {url}.', { url: health.url }) : t(START_HINT, { url: health.url })}</p>}
    </>
  );
}
