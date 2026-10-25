import { z } from 'zod';
import { ACTION_STATUSES, isActionResultUrl, type ActionProgress, type ProjectAgenda, type ProjectBrief, type ProjectBriefItem, type ProjectWorkItem } from '../../shared/project-work.ts';
import type { HandoffItemRow, Store } from '../db.ts';
import { handoffProjectMismatch } from './handoff-model.ts';

export class ProjectWorkError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const progressInput = z.object({
  expectedVersion: version,
  status: z.enum(ACTION_STATUSES).optional(),
  note: z.string().max(4000).optional(),
  results: z.array(z.object({ label: z.string().max(120).trim().min(1), url: z.string().max(2048).trim().refine(isActionResultUrl) }).strict()).max(8).optional(),
}).strict().refine((v) => v.status !== undefined || v.note !== undefined || v.results !== undefined);
const agendaInput = z.object({ expectedVersion: version, text: z.string().max(8000) }).strict();
const HISTORY_LIMIT = 20;

type BriefRow = HandoffItemRow & {
  session_id: string; session_title: string; session_started_at: number | null; meeting_time: number;
  confirmed_revision: number | null; current_revision: number;
};

export class ProjectWorkService {
  private store: Store;
  constructor(store: Store) { this.store = store; }

  /** Checks and writes share a SQLite transaction, including against a second local process. */
  private transaction<T>(fn: () => T, write = true): T {
    this.store.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = fn(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }

  updateProgress(itemId: string, body: unknown): { sessionId: string; projectId: string; progress: ActionProgress } {
    const parsed = progressInput.safeParse(body);
    if (!parsed.success) throw new ProjectWorkError(400, 'Invalid action progress. Check the status, note, result links and expected version.');
    return this.transaction(() => {
      const item = this.store.getHandoffItem(itemId);
      if (!item) throw new ProjectWorkError(404, 'Action item not found.');
      const handoff = this.store.getHandoff(item.handoff_id);
      const session = handoff ? this.store.getSession(handoff.session_id) : null;
      if (!handoff || !session) throw new ProjectWorkError(404, 'The meeting is no longer available.');
      if (item.kind !== 'action') throw new ProjectWorkError(400, 'Only action items have execution progress.');
      if (handoff.status !== 'confirmed' || item.review !== 'confirmed') throw new ProjectWorkError(409, 'Confirm the handoff and this action before updating its progress.');
      if (!session.project_id || !this.store.getProject(session.project_id) || handoffProjectMismatch(handoff, session.project_id, this.store.handoffItems(handoff.id))) {
        throw new ProjectWorkError(409, 'Review this handoff for the meeting’s current project before updating progress.');
      }
      const previous = this.store.actionProgress(item);
      if (parsed.data.expectedVersion !== previous.version) throw new ProjectWorkError(409, 'This action changed in another window. Reload it before saving your changes.');
      const { status = previous.status, note = previous.note, results = previous.results } = parsed.data;
      return { sessionId: session.id, projectId: session.project_id, progress: this.store.saveActionProgress(item, { status, note, results }) };
    });
  }

  updateAgenda(projectId: string, body: unknown): ProjectAgenda {
    const parsed = agendaInput.safeParse(body);
    if (!parsed.success) throw new ProjectWorkError(400, 'An agenda needs text of at most 8000 characters and its expected version.');
    return this.transaction(() => {
      if (!this.store.getProject(projectId)) throw new ProjectWorkError(404, 'Project not found.');
      if (this.store.projectAgenda(projectId).version !== parsed.data.expectedVersion) throw new ProjectWorkError(409, 'This agenda changed in another window. Reload it before saving your changes.');
      return this.store.saveProjectAgenda(projectId, parsed.data.text);
    });
  }

  brief(projectId: string): ProjectBrief {
    return this.transaction(() => {
      const project = this.store.getProject(projectId);
      if (!project) throw new ProjectWorkError(404, 'Project not found.');
      const latest = this.store.db.prepare('SELECT id, title, started_at AS startedAt FROM sessions WHERE project_id = ? ORDER BY COALESCE(started_at, created_at) DESC, id DESC LIMIT 1')
        .get(projectId) as unknown as ProjectBrief['latestMeeting'] | undefined;
      const rows = this.store.db.prepare(`SELECT i.*, s.id AS session_id, s.title AS session_title, s.started_at AS session_started_at,
        COALESCE(s.started_at, s.created_at) AS meeting_time, s.revision AS current_revision, h.confirmed_revision
        FROM handoff_items i JOIN handoffs h ON h.id = i.handoff_id JOIN sessions s ON s.id = h.session_id
        WHERE s.project_id = ? AND h.project_id = s.project_id AND i.project_id = s.project_id
          AND h.status = 'confirmed' AND i.review = 'confirmed'
          AND NOT EXISTS (SELECT 1 FROM handoff_items other WHERE other.handoff_id = h.id AND other.review != 'rejected' AND other.project_id IS NOT s.project_id)
        ORDER BY meeting_time DESC, s.id, i.position, i.id`).all(projectId) as unknown as BriefRow[];
      const item = (row: BriefRow): ProjectBriefItem => ({
        id: row.id, text: row.text, sessionId: row.session_id, sessionTitle: row.session_title, sessionStartedAt: row.session_started_at,
        handoffId: row.handoff_id, stale: row.confirmed_revision !== row.current_revision, owner: row.owner, due: row.due,
      });
      const work = rows.filter((r) => r.kind === 'action').map((row) => ({ row, value: { ...item(row), progress: this.store.actionProgress(row) } as ProjectWorkItem }));
      const rank = { blocked: 0, in_progress: 1, not_started: 2, completed: 3 };
      const actions = work.filter(({ value }) => value.progress.status !== 'completed').sort((a, b) =>
        rank[a.value.progress.status] - rank[b.value.progress.status] || a.row.meeting_time - b.row.meeting_time || a.row.position - b.row.position || a.row.id.localeCompare(b.row.id)).map(({ value }) => value);
      const completed = work.filter(({ value }) => value.progress.status === 'completed').sort((a, b) =>
        (b.value.progress.updatedAt ?? 0) - (a.value.progress.updatedAt ?? 0) || b.row.meeting_time - a.row.meeting_time || a.row.id.localeCompare(b.row.id)).map(({ value }) => value);
      const decisions = rows.filter((r) => r.kind === 'decision').map(item);
      const questions = rows.filter((r) => r.kind === 'question').map(item);
      const reviewNeeded = this.store.db.prepare(`SELECT COUNT(*) AS count FROM handoffs h JOIN sessions s ON s.id = h.session_id
        WHERE s.project_id = ? AND (h.status != 'confirmed' OR h.project_id IS NOT s.project_id OR h.confirmed_revision IS NOT s.revision
          OR EXISTS (SELECT 1 FROM handoff_items i WHERE i.handoff_id = h.id AND i.review != 'rejected' AND i.project_id IS NOT s.project_id))`).get(projectId) as { count: number };
      return {
        project: { id: project.id, name: project.name }, agenda: this.store.projectAgenda(projectId), latestMeeting: latest ?? null,
        actions, completedActions: completed.slice(0, HISTORY_LIMIT), decisions: decisions.slice(0, HISTORY_LIMIT), questions: questions.slice(0, HISTORY_LIMIT),
        reviewNeededCount: reviewNeeded.count,
        omitted: { completedActions: Math.max(0, completed.length - HISTORY_LIMIT), decisions: Math.max(0, decisions.length - HISTORY_LIMIT), questions: Math.max(0, questions.length - HISTORY_LIMIT) },
      };
    }, false);
  }
}
