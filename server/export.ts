import type { SessionRow, Store } from './db.ts';
import { fmtT } from './util.ts';
import { sessionTypeName } from '../shared/session-types.ts';
import { formatSeg } from './ai/context.ts';
import { handoffProjectMismatch, itemPublic } from './projects/handoff-model.ts';

const KIND_LABEL: Record<string, string> = { catchup: 'Catch-up', answer: 'Question', explain: 'Explanation', auto_explain: 'Background card (automatic)' };

/** "2026-10-21 Lab meeting": the file name, without extension, of every export of one session. */
export function exportName(s: SessionRow): string {
  const safe = s.title.replace(/[^\p{L}\p{N}\- _]+/gu, '').trim().slice(0, 60) || 'session';
  const d = new Date(s.started_at ?? s.created_at);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${date} ${safe}`;
}

export function exportSession(store: Store, id: string, format: 'md' | 'txt'): { filename: string; body: string; mime: string } {
  const s = store.getSession(id);
  if (!s) throw new Error('Session not found');
  const segs = store.segments(id);
  const timeline = store.timeline(id);
  const outs = store.outputs(id).filter((o) => o.status === 'done');
  const summary = [...outs].reverse().find((o) => o.kind === 'final_summary');
  const overview = [...outs].reverse().find((o) => o.kind === 'overview');
  const qa = outs.filter((o) => KIND_LABEL[o.kind]);
  const date = new Date(s.started_at ?? s.created_at);
  const L: string[] = [];
  L.push(`# ${s.title}`, '');
  L.push(`- Type: ${sessionTypeName(store.getSettings().sessionTypes, s.type)}`, `- Date: ${date.toLocaleString()}`, `- Duration: ${fmtT(s.duration_ms)}`, `- Audio source: ${s.audio_source ?? 'unknown'}`, `- Status: ${s.status}`, '');
  L.push('> The transcript below is raw automatic speech recognition and may contain errors. Sections marked "AI-generated" were written by the AI provider and may contain errors; check them against the transcript timestamps.', '');
  L.push('> Speaker labels are meeting-local estimates; names are supplied by the user. Automatic attribution can be wrong. Mixed and unknown lines are not assigned to a person. Audio source does not identify a speaker.', '');
  if (outs.some((o) => o.stale_reason)) L.push('> Some AI-generated sections below predate a speaker annotation change. Regenerate them before relying on their attribution.', '');
  if (summary?.content) L.push('## Summary (AI-generated)', '', summary.content.trim(), '');
  else L.push('## Summary (AI-generated)', '', '_No summary was generated for this session._', '');
  const handoff = store.handoffForSession(id);
  const rows = handoff ? store.handoffItems(handoff.id) : [];
  if (handoff && (handoff.status === 'confirmed' || handoff.status === 'draft' || rows.some((i) => i.review !== 'rejected'))) {
    const reviewed = handoff.status === 'confirmed';
    const items = rows.filter((i) => reviewed ? i.review === 'confirmed' : i.review !== 'rejected').map((i) => itemPublic(i));
    L.push(reviewed ? '## Handoff (reviewed)' : '## Handoff (draft, unreviewed)', '');
    if (reviewed) {
      L.push(`Confirmed by the user${handoff.confirmed_at != null ? ` on ${new Date(handoff.confirmed_at).toLocaleString()}` : ''}.`, '');
      if (handoff.confirmed_revision != null && handoff.confirmed_revision !== s.revision) L.push('> The meeting has changed since this handoff was confirmed. Review it against the current transcript.', '');
    } else L.push('> This handoff is not confirmed. Review the draft before treating it as agreed work.', '');
    if (handoffProjectMismatch(handoff, s.project_id, rows)) L.push('> This handoff contains items from a different project. Review it for the meeting’s current project before using it.', '');
    const origins = { agreed: 'agreed in the meeting', suggested: 'suggested in the meeting, not agreed', chumi: 'proposed by Chumi, not stated in the meeting', user: 'added by the user' };
    for (const [kind, label] of [['decision', 'Decisions'], ['action', 'Actions'], ['question', 'Open questions']] as const) {
      const group = items.filter((i) => i.kind === kind);
      if (!group.length) continue;
      L.push(`### ${label}`, '');
      for (const i of group) {
        L.push(`- ${i.text}`, `  - Origin: ${origins[i.origin]}`);
        if (!reviewed) L.push(`  - Review: ${i.review}`);
        if (i.owner) L.push(`  - Owner: ${i.owner}`);
        if (i.due) L.push(`  - Due: ${i.due}`);
        if (i.rationale) L.push(`  - Rationale: ${i.rationale}`);
        if (i.conditions.length) L.push(`  - Unresolved conditions: ${i.conditions.join('; ')}`);
        if (i.acceptance.length) L.push(`  - Acceptance criteria (proposed by Chumi): ${i.acceptance.join('; ')}`);
        if (i.evidence.length) L.push(`  - Evidence: ${i.evidence.map((e) => e.kind === 'transcript' ? `[${fmtT(e.from_ms)}–${fmtT(e.to_ms)}]` : `screen capture [${fmtT(e.t)}]`).join(', ')}`);
      }
      L.push('');
    }
    if (!items.length) L.push('_No handoff items to export._', '');
  }
  if (overview?.content) L.push('## Running overview (AI-generated)', '', overview.content.trim(), '');
  if (qa.length) {
    L.push('## Questions, catch-ups and explanations (AI-generated)', '');
    for (const o of qa) {
      const range = o.covered_from != null && o.covered_to != null ? ` — covers [${fmtT(o.covered_from)}–${fmtT(o.covered_to)}]` : '';
      L.push(`### ${KIND_LABEL[o.kind]}: ${o.question ?? ''}${range}`, '', (o.content ?? '').trim(), '');
    }
  }
  const frames = store.frames(id);
  if (frames.length) {
    L.push('## Screen captures', '', 'Captured from the selected window (images are stored on this computer):', '');
    for (const f of frames) L.push(`- [${fmtT(f.t)}] ${f.window_title || 'Window capture'}${f.kind === 'snapshot' ? ' (on-demand capture)' : ''}`);
    L.push('');
  }
  L.push('## Transcript (raw)', '');
  const events = timeline.filter((e) => ['pause', 'resume', 'gap', 'interrupted'].includes(e.kind));
  let ei = 0;
  for (const seg of segs) {
    while (ei < events.length && events[ei].t <= seg.t_start) {
      const e = events[ei++];
      L.push(`*— ${e.kind}${e.detail ? `: ${e.detail}` : ''} [${fmtT(e.t)}] —*`, '');
    }
    L.push(formatSeg(seg), '');
  }
  while (ei < events.length) { const e = events[ei++]; L.push(`*— ${e.kind}${e.detail ? `: ${e.detail}` : ''} [${fmtT(e.t)}] —*`, ''); }
  let body = L.join('\n');
  if (format === 'txt') {
    body = body
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/(^|\s)\*(.+?)\*(?=\s|$)/g, '$1$2')
      .replace(/^>\s?/gm, '')
      .replace(/`([^`]+)`/g, '$1');
    return { filename: `${exportName(s)}.txt`, body, mime: 'text/plain; charset=utf-8' };
  }
  return { filename: `${exportName(s)}.md`, body, mime: 'text/markdown; charset=utf-8' };
}
