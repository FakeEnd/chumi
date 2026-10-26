import { useEffect, useRef, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { addHandoffItem, assignProject, confirmHandoff, continueHandoff, prepareHandoff, refreshSession, reopenHandoff, retargetHandoff, updateHandoffItem } from '../actions.ts';
import { api } from '../api.ts';
import { fmtClock, fmtT } from '../util.ts';
import { msg, plural, t } from '../i18n.ts';
import { Dialog } from './Dialog.tsx';
import { focusTime } from './Transcript.tsx';
import { ProjectSelect } from './Projects.tsx';
import { onEnter } from '../keys.ts';
import type { EvidenceRef, Handoff, HandoffItem } from '../types.ts';
import { AGENT_NAMES, type AgentId } from '../../../shared/agents.ts';
import { ActionProgress } from './ActionProgress.tsx';
import { loadHandoffDestination, saveHandoffDestination, type HandoffDestination } from '../handoffDestination.ts';

const ORIGIN: Record<HandoffItem['origin'], string> = { agreed: msg('Agreed in the meeting'), suggested: msg('Suggested, not agreed'), chumi: msg('Proposed by Chumi'), user: msg('Added by you') };
const KINDS: Array<[HandoffItem['kind'], string, string]> = [
  ['action', msg('Actions'), msg('Work the meeting implies. Only confirmed actions are handed to the agent.')],
  ['decision', msg('Decisions'), msg('What the group decided. Passed on as context.')],
  ['question', msg('Open questions'), msg('Unresolved points. Passed on as context, never as tasks.')],
];
const VIA: Record<string, string> = { ...AGENT_NAMES, 'codex-app': 'Codex app' };

/** Plain-language list of what changed in the meeting since the handoff was reviewed. */
function changes(h: Handoff): string[] {
  const d = h.freshness.detail, out: string[] = [];
  if (d.meeting_deleted) return [t('The meeting was deleted.')];
  if (d.reassigned) out.push(t('The meeting was assigned to a different project.'));
  if (d.resumed) out.push(t('Recording was resumed.'));
  if (d.speaker_labels_changed) out.push(t('Speaker labels or names were changed.'));
  if (d.new_transcript_lines) out.push(plural(d.new_transcript_lines, '{n} new transcript line', '{n} new transcript lines'));
  if (d.summary_regenerated) out.push(t('The summary was regenerated.'));
  else if (d.new_outputs) out.push(plural(d.new_outputs, '{n} new AI answer or note', '{n} new AI answers or notes'));
  if (d.new_frames) out.push(plural(d.new_frames, '{n} new screen capture', '{n} new screen captures'));
  return out;
}

function Evidence({ ev }: { ev: EvidenceRef[] }) {
  if (!ev.length) return <span className="warn-text tiny">{t('No supporting passage found. Check it before confirming.')}</span>;
  return (
    <span className="evidence">
      {ev.map((e, i) => e.kind === 'transcript'
        ? <button key={i} className="ref" title={t('Show in transcript')} onClick={() => { setState({ dialog: null }); focusTime(e.from_ms, e.to_ms); }}>{e.from_ms === e.to_ms ? fmtT(e.from_ms) : `${fmtT(e.from_ms)}–${fmtT(e.to_ms)}`}</button>
        : <button key={i} className="ref" title={t('Open the screen capture')} onClick={() => setState({ dialog: 'frame', frameView: e.frame_id })}>▣ {fmtT(e.t)}</button>)}
    </span>
  );
}

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function ItemRow({ item, locked, trackProgress, refresh }: { item: HandoffItem; locked: boolean; trackProgress: boolean; refresh: () => Promise<unknown> }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ text: item.text, rationale: item.rationale ?? '', conditions: item.conditions.join('\n'), acceptance: item.acceptance.join('\n'), owner: item.owner ?? '', due: item.due ?? '' });
  const save = async () => {
    await updateHandoffItem(item.id, { text: f.text, rationale: f.rationale, ...(item.kind === 'action' ? { conditions: lines(f.conditions), acceptance: lines(f.acceptance), owner: f.owner, due: f.due } : {}) });
    setEdit(false);
  };
  const review = (r: HandoffItem['review']) => void updateHandoffItem(item.id, { review: r });
  return (
    <li className={`hitem review-${item.review}`}>
      <div className="hitem-head">
        {item.kind !== 'question' && <span className={`tag origin-${item.origin}`}>{t(ORIGIN[item.origin])}</span>}
        {item.edited && item.origin !== 'user' && <span className="tag tag-muted">{t('edited')}</span>}
        <span className="spacer" />
        {item.review === 'pending'
          ? <><button className="btn small primary" disabled={locked} onClick={() => review('confirmed')}>{t('Confirm')}</button><button className="btn small" disabled={locked} onClick={() => review('rejected')}>{t('Reject')}</button></>
          : <><span className={`tag ${item.review === 'confirmed' ? 'tag-ok' : 'tag-muted'}`}>{item.review === 'confirmed' ? t('Confirmed') : t('Rejected')}</span><button className="link-btn small" disabled={locked} onClick={() => review('pending')}>{t('Undo')}</button></>}
        {!edit && <button className="link-btn small" disabled={locked} onClick={() => setEdit(true)}>{t('Edit')}</button>}
      </div>
      {edit ? (
        <div className="hitem-edit">
          <textarea rows={2} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} aria-label={t('Description')} />
          <label className="field"><span>{t('Why (as stated in the meeting)')}</span><textarea rows={2} value={f.rationale} onChange={(e) => setF({ ...f, rationale: e.target.value })} /></label>
          {item.kind === 'action' && (
            <>
              <label className="field"><span>{t('Unresolved conditions (one per line)')}</span><textarea rows={2} value={f.conditions} onChange={(e) => setF({ ...f, conditions: e.target.value })} /></label>
              <label className="field"><span>{t('Checks that show it is done (one per line)')}</span><textarea rows={2} value={f.acceptance} onChange={(e) => setF({ ...f, acceptance: e.target.value })} /></label>
              <div className="field-row">
                <label className="field grow"><span>{t('Owner (only if stated)')}</span><input value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} /></label>
                <label className="field grow"><span>{t('Deadline (only if stated)')}</span><input value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></label>
              </div>
            </>
          )}
          <div className="btn-row"><button className="btn small primary" onClick={() => void save()}>{t('Save')}</button><button className="btn small" onClick={() => setEdit(false)}>{t('Cancel')}</button></div>
        </div>
      ) : (
        <>
          <div className="hitem-text">{item.text}</div>
          {item.rationale && <div className="small muted">{t('Why:')} {item.rationale}</div>}
          {item.kind === 'action' && item.conditions.length > 0 && <div className="small"><b>{t('Unresolved:')}</b> {item.conditions.join('; ')}</div>}
          {item.kind === 'action' && item.acceptance.length > 0 && <div className="small muted"><b>{t('Possible checks (proposed by Chumi):')}</b> {item.acceptance.join('; ')}</div>}
          {item.kind === 'action' && <div className="tiny muted">{t('Owner: {owner} · Deadline: {due}', { owner: item.owner ?? t('not stated'), due: item.due ?? t('not stated') })}</div>}
          <div className="tiny"><Evidence ev={item.evidence} /></div>
        </>
      )}
      {trackProgress && item.kind === 'action' && item.review === 'confirmed' && item.progress != null && <ActionProgress itemId={item.id} progress={item.progress} onRefresh={refresh} />}
    </li>
  );
}

function AddItem({ handoff, kind }: { handoff: Handoff; kind: HandoffItem['kind'] }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const add = () => { if (!text.trim()) return; void addHandoffItem(handoff.id, kind, text); setText(''); setOpen(false); };
  if (!open) return <button className="link-btn small" onClick={() => setOpen(true)}>+ {t('Add your own')}</button>;
  return (
    <div className="field-row">
      <input className="grow" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Describe it in one sentence')} onKeyDown={onEnter(add)} />
      <button className="btn small" disabled={!text.trim()} onClick={add}>{t('Add')}</button>
    </div>
  );
}

/** Status line: draft, confirmed, made available, read by an agent. Delivery never means the work is done. */
function Delivery({ h }: { h: Handoff }) {
  const made = h.status === 'confirmed' && h.delivered_at && h.confirmed_at && h.delivered_at >= h.confirmed_at;
  return (
    <div className="small muted">
      {made ? (h.delivered_via === 'copy' ? t('Instructions prepared at {time}.', { time: fmtClock(h.delivered_at!) }) : h.delivered_via === 'codex-app' ? t('Codex app open requested at {time}.', { time: fmtClock(h.delivered_at!) }) : t('Made available to {via} at {time}.', { via: VIA[h.delivered_via ?? ''] ?? h.delivered_via ?? '', time: fmtClock(h.delivered_at!) })) : null}
      {h.last_agent_read ? ` ${t('Read by {client} at {time}.', { client: h.last_agent_read.client ?? t('an agent'), time: fmtClock(h.last_agent_read.at) })}` : ''}
      {made ? ` ${t('Opening or copying a handoff does not mark its actions complete. Update progress after checking the results.')}` : ''}
    </div>
  );
}

/** The handoff as one header button that shows its state; the dialog holds the items, warnings and delivery. */
export function HandoffButton() {
  const data = useStore((s) => s.data);
  const live = useStore((s) => s.live);
  if (!data || !data.segments.length) return null;
  const h = data.handoff;
  const recording = live?.session?.id === data.session.id && live.status === 'recording';
  if (!h) {
    return (
      <button className="btn small primary" disabled={recording} onClick={() => void prepareHandoff(data.session.id)}
        title={recording ? t('When the meeting ends, turn its decisions and actions into a reviewed handoff for your coding agent.') : t('Turn this meeting\'s decisions and actions into a reviewed handoff for your coding agent.')}>{t('Prepare handoff')}</button>
    );
  }
  if (h.status === 'generating') return <button className="btn small handoff-btn" disabled><span className="spinner" /> {t('Drafting…')}</button>;
  if (h.status === 'error') return <button className="btn small handoff-btn" title={h.error ?? ''} onClick={() => void prepareHandoff(data.session.id)}><span className="tag tag-warn">{t('Failed')}</span> {t('Try again')}</button>;
  const confirmed = h.status === 'confirmed';
  const pending = h.items.filter((i) => i.review === 'pending').length;
  const actions = h.items.filter((i) => i.kind === 'action' && i.review === 'confirmed').length;
  const stale = confirmed && h.freshness.stale;
  const tip = [
    `${confirmed ? plural(actions, '{n} confirmed action', '{n} confirmed actions') : pending ? plural(pending, '{n} item to review', '{n} items to review') : t('All items reviewed.')}${h.project ? ` · ${h.project.name}` : ''}`,
    h.project_mismatch ? t('The meeting moved to another project. Review the handoff again before using it.') : '',
    stale ? `${t('The meeting changed since you confirmed:')} ${changes(h).join(' · ')}` : '',
  ].filter(Boolean).join('\n');
  return (
    <button className="btn small handoff-btn" title={tip} onClick={() => setState({ dialog: 'handoff' })}>
      {confirmed ? t('Open handoff') : t('Review handoff')}
      {confirmed ? <span className="tag tag-ok">{t('Confirmed')}</span> : pending > 0 && <span className="tag">{pending}</span>}
      {(h.project_mismatch || stale) && <span className="tag tag-warn" aria-label={t('Needs review')}>!</span>}
    </button>
  );
}

export function HandoffDialog() {
  const data = useStore((s) => s.data);
  const live = useStore((s) => s.live);
  const [busy, setBusy] = useState(false);
  const pendingDelivery = useRef(false);
  const [destination, setDestination] = useState(loadHandoffDestination);
  const [manualPrompt, setManualPrompt] = useState('');
  const [deliveryError, setDeliveryError] = useState('');
  /** What Continue did, shown next to it: a toast would be behind the dialog. */
  const [delivered, setDelivered] = useState('');
  const [others, setOthers] = useState<Array<{ agent: AgentId; name: string }>>([]);
  useEffect(() => {
    void api<{ agents: Array<{ agent: AgentId; name: string; installed: boolean }> }>('/api/agents/available')
      .then((r) => setOthers(r.agents.filter((a) => a.installed && a.agent !== 'claude-code' && a.agent !== 'codex'))).catch(() => {});
  }, []);
  const h = data?.handoff;
  if (!data || !h) return null;
  const confirmed = h.status === 'confirmed';
  const generating = h.status === 'generating';
  const pending = h.items.filter((i) => i.review === 'pending').length;
  const recording = live?.session?.id === data.session.id && live.status === 'recording';
  const selected = ['codex-app', 'codex', 'claude-code', 'copy'].includes(destination) || others.some((a) => a.agent === destination) ? destination : 'codex-app';
  const go = async (agent: HandoffDestination) => {
    if (pendingDelivery.current) return;
    pendingDelivery.current = true; setBusy(true); setManualPrompt(''); setDeliveryError(''); setDelivered('');
    try {
      const r = await continueHandoff(h.id, agent);
      if (!r) return;
      if (agent === 'copy') {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(r.prompt);
          setDelivered(t('Instructions copied. Paste them into your coding agent in the project folder.'));
        } catch {
          setManualPrompt(r.prompt);
          setDeliveryError(t('Clipboard access failed. Select and copy the instructions below.'));
        }
      } else if (!r.launched) {
        setManualPrompt(r.prompt); setDeliveryError(t('The destination could not be opened. You can copy the instructions below.'));
      } else if (agent === 'codex-app') setDelivered(t('Requested Codex app to open the handoff. Review it there, then click Send to start.'));
      else if (r.paste?.copied) setDelivered(t('Opened {agent} and copied a one-line instruction. Open the project folder there, start a new session and paste it.', { agent: AGENT_NAMES[agent as AgentId] }));
      else if (r.paste) { setManualPrompt(r.paste.text); setDelivered(t('Opened {agent}. Copy the instruction below, open the project folder there, start a new session and paste it.', { agent: AGENT_NAMES[agent as AgentId] })); }
      else setDelivered(t('Opened {agent} in Terminal in the project folder, starting from this handoff.', { agent: AGENT_NAMES[agent] }));
    } catch (e) { setDeliveryError(e instanceof Error ? e.message : t('Could not open the handoff destination.')); }
    finally { pendingDelivery.current = false; setBusy(false); }
  };
  const footer = (
    <>
      {!confirmed && <button className="btn small" disabled={generating || recording} onClick={() => void prepareHandoff(data.session.id)} title={t('Replaces items you have not reviewed; keeps what you confirmed, rejected or edited')}>{generating ? t('Drafting…') : t('Redraft')}</button>}
      {confirmed && <button className="btn small" disabled={busy} onClick={() => void reopenHandoff(h.id)}>{t('Edit')}</button>}
      {confirmed && delivered && <span className="ok-text small delivery-note" role="status">{delivered}</span>}
      <span className="spacer" />
      {!confirmed && <button className="btn primary" disabled={generating || pending > 0 || h.project_mismatch || !h.items.some((i) => i.review === 'confirmed')} onClick={() => void confirmHandoff(h.id)}
        title={pending ? t('Confirm or reject every item first') : ''}>{pending ? plural(pending, 'Review {n} more item', 'Review {n} more items') : t('Confirm handoff')}</button>}
      {confirmed && (
        <>
          <label className="handoff-destination small"><span>{t('Continue in')}</span>
            <select value={selected} disabled={busy} onChange={(e) => {
              const next = e.target.value as HandoffDestination;
              setDestination(next); saveHandoffDestination(next);
              // What the last Continue did belongs to the last destination, not this one.
              setDelivered(''); setDeliveryError(''); setManualPrompt('');
            }}>
              <option value="codex-app">{t('Codex app')}</option>
              <option value="codex">{t('Codex in Terminal')}</option>
              <option value="claude-code">{t('Claude Code in Terminal')}</option>
              {others.map((a) => <option key={a.agent} value={a.agent}>{a.name}</option>)}
              <option value="copy">{t('Copy instructions')}</option>
            </select>
          </label>
          <button className="btn primary" disabled={busy || h.project_mismatch || !h.project} onClick={() => void go(selected)}>{busy ? t('Preparing…') : selected === 'copy' ? t('Copy instructions') : t('Continue')}</button>
        </>
      )}
    </>
  );
  return (
    <Dialog title={t('Handoff: {title}', { title: data.session.title })} wide footer={footer}>
      <div className="handoff-meta small">
        <span>{t('Project:')}</span>
        <ProjectSelect value={data.session.project_id} onChange={(id) => { if (!h.items.length || confirm(t('Move this meeting to another project? Its handoff will need to be reviewed again for the new project.'))) void assignProject(data.session.id, id); }} />
        <span className={`tag ${confirmed ? 'tag-ok' : ''}`}>{confirmed ? t('Confirmed') : generating ? t('Drafting…') : t('Draft')}</span>
        {confirmed && h.confirmed_at && <span className="muted">{t('confirmed {time} at revision {rev}', { time: fmtClock(h.confirmed_at), rev: h.confirmed_revision ?? '' })}</span>}
      </div>
      {!data.session.project_id && <p className="small warn-text">{t('Choose a project to continue this work in a coding agent. You can still review the handoff without one.')}</p>}
      {h.project_mismatch && (
        <div className="warn-box small">{t('This handoff was prepared for another project. Review it for the meeting\'s current project before handing it on.')}
          <button className="btn small" disabled={generating} onClick={() => void retargetHandoff(h.id)}>{t('Review for this project')}</button></div>
      )}
      {h.freshness.stale && changes(h).length > 0 && <div className="warn-box small">{confirmed ? t('The meeting changed since you confirmed:') : t('The meeting changed since this draft:')} {changes(h).join(' · ')}</div>}
      {h.error && <p className="error-text small">{h.error}</p>}
      {confirmed && selected === 'codex-app' && <p className="small muted">{t('In Codex app, review the prepared handoff and click Send to begin.')}</p>}
      {confirmed && selected === 'deepseek-harness' && <p className="small muted">{t('DeepSeek Harness cannot be handed a folder or a message. Chumi saves the handoff, copies a one-line instruction that points to it, and opens the app; you open the project folder there and paste it into a new session.')}</p>}
      {deliveryError && <p className="error-text small" role="alert">{t(deliveryError)}</p>}
      {manualPrompt && <label className="field"><span>{t('Handoff instructions')}</span><textarea readOnly rows={8} value={manualPrompt} onFocus={(e) => e.currentTarget.select()} /></label>}
      {generating && <div className="pending"><span className="spinner" /> {t('Drafting from the transcript…')}</div>}
      <p className="muted small">{t('Review each item. Edit anything that is wrong, reject what should not be handed on. Owners and deadlines appear only if someone stated them.')}</p>
      {KINDS.map(([kind, label, hint]) => {
        const items = h.items.filter((i) => i.kind === kind);
        return (
          <section key={kind} className="hsection">
            <h3>{t(label)} <span className="muted small">{items.length || ''}</span></h3>
            <p className="tiny muted">{t(hint)}</p>
            {!items.length && !generating && <p className="small muted">{t('None found.')}</p>}
            <ul className="hitems">{items.map((i) => <ItemRow key={i.id} item={i} locked={generating} trackProgress={confirmed && !!h.project && !h.project_mismatch} refresh={() => refreshSession(data.session.id)} />)}</ul>
            <AddItem handoff={h} kind={kind} />
          </section>
        );
      })}
      <Delivery h={h} />
    </Dialog>
  );
}
