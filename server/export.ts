import type { SessionRow, Store } from './db.ts';
import { fmtT } from './util.ts';
import { sessionTypeName } from '../shared/session-types.ts';
import { formatSeg } from './ai/context.ts';

const KIND_LABEL: Record<string, string> = { catchup: 'Catch-up', answer: 'Question', explain: 'Explanation', auto_explain: 'Background card (automatic)' };

/** "2026-10-21 Lab meeting": the file name, without extension, of every export of one session. */
export function exportName(s: SessionRow): string {
  const safe = s.title.replace(/[^\p{L}\p{N}\- _]+/gu, '').trim().slice(0, 60) || 'session';
  return `${new Date(s.started_at ?? s.created_at).toISOString().slice(0, 10)} ${safe}`;
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
  L.push('> The transcript below is raw automatic speech recognition (local Whisper). Sections marked "AI-generated" were written by the AI provider and may contain errors; check them against the transcript timestamps.', '');
  L.push('> Speaker labels are meeting-local estimates; names are supplied by the user. Automatic attribution can be wrong. Mixed and unknown lines are not assigned to a person. Audio source does not identify a speaker.', '');
  if (outs.some((o) => o.stale_reason)) L.push('> Some AI-generated sections below predate a speaker annotation change. Regenerate them before relying on their attribution.', '');
  if (summary?.content) L.push('## Summary (AI-generated)', '', summary.content.trim(), '');
  else L.push('## Summary (AI-generated)', '', '_No summary was generated for this session._', '');
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
    L.push('## Screen captures', '', 'Captured from the shared window when the screen changed (images are stored on this Mac):', '');
    for (const f of frames) L.push(`- [${fmtT(f.t)}] ${f.app ?? ''}${f.window_title ? ` — ${f.window_title}` : ''}${f.kind === 'snapshot' ? ' (on-demand capture)' : ''}: ${f.path}`);
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
