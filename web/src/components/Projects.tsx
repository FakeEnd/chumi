import { useEffect, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { chooseFolder, createProject, updateProject } from '../actions.ts';
import { api } from '../api.ts';
import { fmtClock } from '../util.ts';
import { plural, t, tn } from '../i18n.ts';
import type { AgentStatus } from '../types.ts';

/** Project picker: a meeting belongs to at most one project, and only when the user says so. */
export function ProjectSelect({ value, onChange, className, ariaLabel }: { value: string | null; onChange: (id: string | null) => void; className?: string; ariaLabel?: string }) {
  const projects = useStore((s) => s.projects);
  const visible = projects.filter((p) => !p.archived_at || p.id === value);
  return (
    <select className={className} value={value ?? ''} aria-label={ariaLabel ?? t('Project')}
      onChange={(e) => { if (e.target.value === '__new') setState({ dialog: 'settings', settingsTab: 'projects' }); else onChange(e.target.value || null); }}>
      <option value="">{t('No project')}</option>
      {visible.map((p) => <option key={p.id} value={p.id}>{p.name}{p.archived_at ? ` ${t('(archived)')}` : ''}</option>)}
      <option value="__new">{t('New project…')}</option>
    </select>
  );
}

export function ProjectsTab() {
  const projects = useStore((s) => s.projects);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const pick = async (apply: (p: string) => void) => { const p = await chooseFolder(); if (p) apply(p); };
  const add = async () => { if (await createProject(name.trim(), folder.trim())) { setName(''); setFolder(''); } };
  const list = projects.filter((p) => showArchived || !p.archived_at);
  return (
    <section>
      <p className="small">{t('A project is a folder where you work with Claude Code or Codex. Assign meetings to it, confirm the work a meeting implies, and the agent working in that folder can read the handoff and its evidence through Chumi.')}</p>
      <h3>{t('New project')}</h3>
      <div className="project-form">
        <input placeholder={t('Name, e.g. Enhancer model')} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="field-row" style={{ marginBottom: 0 }}>
          <input className="grow" placeholder={t('Project folder, e.g. /Users/you/code/enhancer-model')} value={folder} onChange={(e) => setFolder(e.target.value)} />
          <button className="btn small" onClick={() => void pick(setFolder)}>{t('Choose…')}</button>
        </div>
        <button className="btn primary small" disabled={!name.trim() || !folder.trim()} onClick={() => void add()}>{t('Create project')}</button>
      </div>
      <h3>{t('Projects')}</h3>
      {!list.length && <p className="muted small">{t('No projects yet.')}</p>}
      <ul className="project-list">
        {list.map((p) => (
          <li key={p.id} className={p.archived_at ? 'archived' : ''}>
            <div className="project-main">
              <input className="project-name" value={names[p.id] ?? p.name} onChange={(e) => setNames({ ...names, [p.id]: e.target.value })}
                onBlur={() => { const n = (names[p.id] ?? p.name).trim(); if (n && n !== p.name) void updateProject(p.id, { name: n }); }} aria-label={t('Project name')} />
              <div className="small mono">{p.workspace}</div>
              {!p.workspace_exists && <div className="warn-text small">{t('This folder no longer exists. Choose its new location; the meetings stay attached.')}</div>}
              <div className="muted tiny">
                {plural(p.meeting_count, '{n} meeting', '{n} meetings')}
                {p.repo ? ` · git${p.repo.branch ? `: ${p.repo.branch}` : ''}${p.repo.remote ? ` · ${p.repo.remote.replace(/^https?:\/\/|\.git$/g, '')}` : ''}` : ''}
                {p.archived_at ? ` · ${t('archived')}` : ''}
              </div>
            </div>
            <div className="project-actions">
              <button className="btn small" onClick={() => void pick((w) => void updateProject(p.id, { workspace: w }))}>{t('Change folder…')}</button>
              <button className="btn small ghost" onClick={() => void updateProject(p.id, { archived: !p.archived_at })}>{p.archived_at ? t('Restore') : t('Archive')}</button>
            </div>
          </li>
        ))}
      </ul>
      <label className="field check small"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {t('Show archived projects')}</label>
      <p className="muted small">{t('Renaming a project or changing its folder keeps its meetings and handoffs. Meetings are never assigned automatically.')}</p>
    </section>
  );
}

interface AgentsInfo { local: { ok: boolean; detail: string }; agents: AgentStatus[]; commands: Record<string, string>; exports: { mybot: { files: number; dir: string } | null } }
const AGENT_NAME: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

export function AgentsTab() {
  const [info, setInfo] = useState<AgentsInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const load = () => void api<AgentsInfo>('/api/agents').then(setInfo).catch((e) => setError((e as Error).message));
  useEffect(load, []);
  const act = async (agent: string, action: 'connect' | 'disconnect' | 'verify') => {
    setBusy(`${agent}:${action}`); setError(null);
    try {
      const r = await api<{ status: AgentStatus; result?: { ok: boolean; detail: string } }>(`/api/agents/${agent}/${action}`, { body: {} });
      if (r.result) setResult({ ...result, [agent]: r.result });
      load();
    } catch (e) { setError((e as Error).message); }
    setBusy(null);
  };
  return (
    <section>
      <p className="small">{t('Connect Chumi to Claude Code and Codex so an agent working in a project folder can read that project\'s meetings, confirmed handoffs, original transcript passages and screen captures. Agents read only when they call Chumi\'s tools; Chumi never sends meetings anywhere on its own.')}</p>
      {error && <p className="error-text small">{error}</p>}
      {!info && !error && <p className="muted small">{t('Checking…')}</p>}
      {info && (
        <>
          <div className={`agent-row ${info.local.ok ? '' : 'bad'}`}>
            <b>{t('Chumi MCP server on this Mac')}</b>
            <span className={`pill ${info.local.ok ? 'ok' : 'warn'}`}><span className="dot" />{info.local.ok ? t('works') : t('failed')}</span>
            <span className="muted small">{t(info.local.detail)}</span>
          </div>
          {info.agents.map((a) => {
            const name = AGENT_NAME[a.agent];
            const verified = a.verifiedAt ? t('verified {time}', { time: fmtClock(a.verifiedAt) }) : t('not verified yet');
            return (
              <div key={a.agent} className="agent-card">
                <div className="agent-head"><b>{name}</b>
                  <span className={`pill ${a.cli ? 'ok' : 'muted'}`}><span className="dot" />{a.cli ? t('installed') : t('not installed')}</span>
                  {a.cli && <span className={`pill ${a.registered ? (a.outdated ? 'warn' : 'ok') : 'muted'}`}><span className="dot" />{a.registered ? (a.outdated ? t('connected to another Chumi location') : t('connected')) : t('not connected')}</span>}
                  {a.registered && a.clientHealth !== 'unknown' && <span className={`pill ${a.clientHealth === 'connected' ? 'ok' : 'warn'}`}><span className="dot" />{a.clientHealth === 'connected' ? t('{name} reports the server is running', { name }) : t('{name} could not start the server', { name })}</span>}
                </div>
                <div className="small">
                  <div>{t('Agent read check:')} <b className={a.verifiedAt ? 'ok-text' : ''}>{verified}</b>{a.lastRead ? ` · ${t('last read {time} ({tool})', { time: fmtClock(a.lastRead.at), tool: a.lastRead.tool })}` : ''}</div>
                  {a.detail && <div className="muted">{t(a.detail)}</div>}
                  {result[a.agent] && <div className={result[a.agent].ok ? 'ok-text' : 'warn-text'}>{t(result[a.agent].detail)}</div>}
                </div>
                {a.cli && (
                  <div className="btn-row">
                    <button className="btn small primary" disabled={!!busy} onClick={() => void act(a.agent, 'connect')}>{busy === `${a.agent}:connect` ? t('Connecting…') : a.registered ? t('Reconnect') : t('Connect')}</button>
                    {a.registered && <button className="btn small" disabled={!!busy} onClick={() => void act(a.agent, 'verify')} title={t('Asks the agent to call Chumi\'s check tool. Uses one small request on your plan.')}>{busy === `${a.agent}:verify` ? t('Testing…') : t('Test a real agent read')}</button>}
                    {a.registered && <button className="btn small ghost" disabled={!!busy} onClick={() => void act(a.agent, 'disconnect')}>{t('Disconnect')}</button>}
                  </div>
                )}
              </div>
            );
          })}
          <p className="muted small">{tn('Connecting adds a server named {name} to the agent\'s user settings. You can also do it yourself in Terminal:', { name: <code>chumi</code> })}</p>
          {Object.entries(info.commands).map(([k, cmd]) => <pre key={k} className="cmd small"><span className="muted">{AGENT_NAME[k]}</span>{'\n'}{cmd}</pre>)}
          <h3>{t('Other routes')}</h3>
          <p className="small">{info.exports.mybot ? t('mybot export: {n} file(s) in {dir}. Whether mybot has indexed them cannot be checked from Chumi.', { n: info.exports.mybot.files, dir: info.exports.mybot.dir }) : t('mybot export is off (Integrations).')}</p>
        </>
      )}
    </section>
  );
}
