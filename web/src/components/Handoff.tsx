import { useState } from 'react';
import { notify, setState, useStore } from '../store.ts';
import { addHandoffItem, assignProject, confirmHandoff, continueHandoff, prepareHandoff, reopenHandoff, retargetHandoff, updateHandoffItem } from '../actions.ts';
import { fmtClock, fmtT } from '../util.ts';
import { msg, plural, t } from '../i18n.ts';
import { Dialog } from './Dialog.tsx';
import { focusTime } from './Transcript.tsx';
import { ProjectSelect } from './Projects.tsx';
import type { EvidenceRef, Handoff, HandoffItem } from '../types.ts';

const ORIGIN: Record<HandoffItem['origin'], string> = { agreed: msg('Agreed in the meeting'), suggested: msg('Suggested, not agreed'), chumi: msg('Proposed by Chumi'), user: msg('Added by you') };
const KINDS: Array<[HandoffItem['kind'], string, string]> = [
  ['action', msg('Actions'), msg('Work the meeting implies. Only confirmed actions are handed to the agent.')],
  ['decision', msg('Decisions'), msg('What the group decided. Passed on as context.')],
  ['question', msg('Open questions'), msg('Unresolved points. Passed on as context, never as tasks.')],
];
const VIA: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

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

function ItemRow({ item, locked }: { item: HandoffItem; locked: boolean }) {
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
    </li>
  );
}

function AddItem({ handoff, kind }: { handoff: Handoff; kind: HandoffItem['kind'] }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  if (!open) return <button className="link-btn small" onClick={() => setOpen(true)}>+ {t('Add your own')}</button>;
  return (
    <div className="field-row">
      <input className="grow" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Describe it in one sentence')} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { void addHandoffItem(handoff.id, kind, text); setText(''); setOpen(false); } }} />
      <button className="btn small" disabled={!text.trim()} onClick={() => { void addHandoffItem(handoff.id, kind, text); setText(''); setOpen(false); }}>{t('Add')}</button>
    </div>
  );
}

/** Status line: draft, confirmed, made available, read by an agent. Delivery never means the work is done. */
function Delivery({ h }: { h: Handoff }) {
  const made = h.status === 'confirmed' && h.delivered_at && h.confirmed_at && h.delivered_at >= h.confirmed_at;
  return (
    <div className="small muted">
      {made ? (h.delivered_via === 'copy' ? t('Instructions copied at {time}.', { time: fmtClock(h.delivered_at!) }) : t('Made available to {via} at {time}.', { via: VIA[h.delivered_via ?? ''] ?? h.delivered_via ?? '', time: fmtClock(h.delivered_at!) })) : null}
      {h.last_agent_read ? ` ${t('Read by {client} at {time}.', { client: h.last_agent_read.client ?? t('an agent'), time: fmtClock(h.last_agent_read.at) })}` : ''}
      {made ? ` ${t('Chumi does not know whether the work is done; check in the agent.')}` : ''}
    </div>
  );
}

export function HandoffBox() {
  const data = useStore((s) => s.data);
  const live = useStore((s) => s.live);
  if (!data || !data.segments.length) return null;
  const h = data.handoff;
  const recording = live?.session?.id === data.session.id && live.status === 'recording';
  const pending = h?.items.filter((i) => i.review === 'pending').length ?? 0;
  const actions = h?.items.filter((i) => i.kind === 'action' && i.review === 'confirmed').length ?? 0;
  return (
    <div className="handoff-box">
      <div className="handoff-head">
        <b>{t('Handoff to your project')}</b>
        {h && <span className={`tag ${h.status === 'confirmed' ? 'tag-ok' : h.status === 'error' ? 'tag-warn' : ''}`}>{h.status === 'confirmed' ? t('Confirmed') : h.status === 'generating' ? t('Drafting…') : h.status === 'error' ? t('Failed') : t('Draft')}</span>}
      </div>
      {!h && <p className="small muted">{recording ? t('When the meeting ends, turn its decisions and actions into a reviewed handoff for Claude Code or Codex.') : t('Turn this meeting\'s decisions and actions into a reviewed handoff for Claude Code or Codex.')}</p>}
      {h?.project_mismatch && <p className="small warn-text">{t('The meeting moved to another project. Review the handoff again before using it.')}</p>}
      {h?.status === 'confirmed' && h.freshness.stale && <p className="small warn-text">{t('The meeting changed since you confirmed:')} {changes(h).join(' · ')}</p>}
      {h?.status === 'error' && <p className="small error-text">{h.error}</p>}
      {h && h.status !== 'generating' && h.status !== 'error' && (
        <p className="small">{h.status === 'confirmed' ? plural(actions, '{n} confirmed action', '{n} confirmed actions') : pending ? plural(pending, '{n} item to review', '{n} items to review') : t('All items reviewed.')}{h.project ? ` · ${h.project.name}` : ''}</p>
      )}
      {h && <Delivery h={h} />}
      <div className="btn-row">
        {!h && <button className="btn small primary" disabled={recording} onClick={() => void prepareHandoff(data.session.id)}>{t('Prepare handoff')}</button>}
        {h?.status === 'error' && <button className="btn small" onClick={() => void prepareHandoff(data.session.id)}>{t('Try again')}</button>}
        {h && h.status !== 'generating' && <button className="btn small" onClick={() => setState({ dialog: 'handoff' })}>{h.status === 'confirmed' ? t('Open handoff') : t('Review')}</button>}
      </div>
    </div>
  );
}

export function HandoffDialog() {
  const data = useStore((s) => s.data);
  const live = useStore((s) => s.live);
  const [busy, setBusy] = useState(false);
  const h = data?.handoff;
  if (!data || !h) return null;
  const confirmed = h.status === 'confirmed';
  const generating = h.status === 'generating';
  const pending = h.items.filter((i) => i.review === 'pending').length;
  const recording = live?.session?.id === data.session.id && live.status === 'recording';
  const go = async (agent: 'claude-code' | 'codex' | 'copy') => {
    setBusy(true);
    const r = await continueHandoff(h.id, agent);
    setBusy(false);
    if (!r) return;
    if (agent === 'copy') { await navigator.clipboard?.writeText(r.prompt).catch(() => {}); notify('info', t('Instructions copied. Paste them into Claude Code or Codex in the project folder.')); }
    else notify('info', t('Opened {agent} in Terminal in the project folder, starting from this handoff.', { agent: agent === 'codex' ? 'Codex' : 'Claude Code' }));
  };
  const footer = (
    <>
      {!confirmed && <button className="btn small" disabled={generating || recording} onClick={() => void prepareHandoff(data.session.id)} title={t('Replaces items you have not reviewed; keeps what you confirmed, rejected or edited')}>{generating ? t('Drafting…') : t('Redraft')}</button>}
      {confirmed && <button className="btn small" onClick={() => void reopenHandoff(h.id)}>{t('Edit')}</button>}
      <span className="spacer" />
      {!confirmed && <button className="btn primary" disabled={generating || pending > 0 || h.project_mismatch || !h.items.some((i) => i.review === 'confirmed')} onClick={() => void confirmHandoff(h.id)}
        title={pending ? t('Confirm or reject every item first') : ''}>{pending ? plural(pending, 'Review {n} more item', 'Review {n} more items') : t('Confirm handoff')}</button>}
      {confirmed && (
        <>
          <button className="btn small" disabled={busy} onClick={() => void go('copy')}>{t('Copy instructions')}</button>
          <button className="btn small" disabled={busy || !h.project} onClick={() => void go('codex')}>{t('Continue in Codex')}</button>
          <button className="btn primary" disabled={busy || !h.project} onClick={() => void go('claude-code')}>{t('Continue in Claude Code')}</button>
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
      {!data.session.project_id && <p className="small warn-text">{t('Choose a project to continue this work in Claude Code or Codex. You can still review the handoff without one.')}</p>}
      {h.project_mismatch && (
        <div className="warn-box small">{t('This handoff was prepared for another project. Review it for the meeting\'s current project before handing it on.')}
          <button className="btn small" onClick={() => void retargetHandoff(h.id)}>{t('Review for this project')}</button></div>
      )}
      {h.freshness.stale && changes(h).length > 0 && <div className="warn-box small">{confirmed ? t('The meeting changed since you confirmed:') : t('The meeting changed since this draft:')} {changes(h).join(' · ')}</div>}
      {h.error && <p className="error-text small">{h.error}</p>}
      {generating && <div className="pending"><span className="spinner" /> {t('Drafting from the transcript…')}</div>}
      <p className="muted small">{t('Review each item. Edit anything that is wrong, reject what should not be handed on. Owners and deadlines appear only if someone stated them.')}</p>
      {KINDS.map(([kind, label, hint]) => {
        const items = h.items.filter((i) => i.kind === kind);
        return (
          <section key={kind} className="hsection">
            <h3>{t(label)} <span className="muted small">{items.length || ''}</span></h3>
            <p className="tiny muted">{t(hint)}</p>
            {!items.length && !generating && <p className="small muted">{t('None found.')}</p>}
            <ul className="hitems">{items.map((i) => <ItemRow key={i.id} item={i} locked={generating} />)}</ul>
            <AddItem handoff={h} kind={kind} />
          </section>
        );
      })}
      <Delivery h={h} />
    </Dialog>
  );
}
