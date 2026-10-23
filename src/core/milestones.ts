import { newId, now } from '../db/client.ts';
import type { Ctx } from './context.ts';
import { publish, recordEvent } from './events.ts';
import { getProject } from './projects.ts';
import { badRequest, notFound, type Milestone, type TaskStatus } from './types.ts';

/**
 * Milestones group a project's tasks into deliverables ("Backoffice v1", "SEO pages"). A task belongs to
 * at most one. Progress is counted from the work tasks in it; planner tasks are left out.
 */

type MilestoneRow = Omit<Milestone, 'counts' | 'total' | 'done'>;

function withCounts(ctx: Ctx, r: MilestoneRow): Milestone {
  const rows = ctx.db
    .prepare(`SELECT status, COUNT(*) AS n FROM tasks WHERE milestone_id = ? AND kind = 'work' GROUP BY status`)
    .all(r.id) as { status: TaskStatus; n: number }[];
  const counts: Milestone['counts'] = {};
  for (const x of rows) counts[x.status] = x.n;
  const total = rows.reduce((s, x) => s + x.n, 0);
  return { ...r, counts, total, done: counts.done ?? 0 };
}

export function listMilestones(ctx: Ctx, project: string, opts: { includeDone?: boolean } = {}): Milestone[] {
  getProject(ctx, project);
  const rows = ctx.db
    .prepare(`SELECT * FROM milestones WHERE project_slug = ? ${opts.includeDone === false ? "AND status = 'open'" : ''} ORDER BY position, created_at`)
    .all(project) as unknown as MilestoneRow[];
  return rows.map((r) => withCounts(ctx, r));
}

export function findMilestone(ctx: Ctx, id: string): Milestone | undefined {
  const r = ctx.db.prepare('SELECT * FROM milestones WHERE id = ?').get(id) as unknown as MilestoneRow | undefined;
  return r ? withCounts(ctx, r) : undefined;
}

export function getMilestone(ctx: Ctx, id: string): Milestone {
  const m = findMilestone(ctx, id);
  if (!m) throw notFound(`milestone ${id}`);
  return m;
}

/** Resolves a milestone given by id or by title (case-insensitive) within a project. */
export function resolveMilestone(ctx: Ctx, project: string, ref: string): Milestone {
  const byId = findMilestone(ctx, ref);
  if (byId) {
    if (byId.project_slug !== project) throw badRequest(`milestone ${ref} belongs to ${byId.project_slug}, not ${project}`);
    return byId;
  }
  const r = ctx.db.prepare('SELECT id FROM milestones WHERE project_slug = ? AND lower(title) = lower(?)').get(project, ref.trim()) as { id: string } | undefined;
  if (!r) throw badRequest(`unknown milestone "${ref}" in ${project}`);
  return getMilestone(ctx, r.id);
}

export interface MilestoneInput {
  title: string;
  description?: string;
  due?: string | null;
  position?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkFields(input: Partial<MilestoneInput & { status: string }>): void {
  if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim())) throw badRequest('title is required');
  if (input.description !== undefined && typeof input.description !== 'string') throw badRequest('description must be a string');
  if (input.due !== undefined && input.due !== null && (typeof input.due !== 'string' || !DATE.test(input.due))) throw badRequest('due must be YYYY-MM-DD or null');
  if (input.position !== undefined && !Number.isInteger(input.position)) throw badRequest('position must be an integer');
  if (input.status !== undefined && !['open', 'done'].includes(input.status)) throw badRequest('status must be open or done');
}

export function createMilestone(ctx: Ctx, project: string, input: MilestoneInput, source = 'owner'): Milestone {
  getProject(ctx, project);
  checkFields(input);
  if (!input.title?.trim()) throw badRequest('title is required');
  const dup = ctx.db.prepare('SELECT id FROM milestones WHERE project_slug = ? AND lower(title) = lower(?)').get(project, input.title.trim());
  if (dup) throw badRequest(`milestone "${input.title.trim()}" already exists in ${project}`);
  const last = ctx.db.prepare('SELECT MAX(position) AS p FROM milestones WHERE project_slug = ?').get(project) as { p: number | null };
  const id = newId('m');
  const ts = now();
  ctx.db
    .prepare('INSERT INTO milestones (id, project_slug, title, description, status, position, due, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, project, input.title.trim(), input.description ?? '', 'open', input.position ?? (last.p ?? 0) + 1, input.due ?? null, ts, ts);
  recordEvent(ctx, null, 'milestone.created', { id, project, title: input.title.trim(), source });
  return emit(ctx, id);
}

export function updateMilestone(ctx: Ctx, id: string, patch: Partial<MilestoneInput & { status: 'open' | 'done' }>): Milestone {
  getMilestone(ctx, id);
  checkFields(patch);
  const sets: string[] = [];
  const vals: any[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.title !== undefined) set('title', patch.title.trim());
  if (patch.description !== undefined) set('description', patch.description);
  if (patch.due !== undefined) set('due', patch.due);
  if (patch.position !== undefined) set('position', patch.position);
  if (patch.status !== undefined) set('status', patch.status);
  if (sets.length) {
    set('updated_at', now());
    ctx.db.prepare(`UPDATE milestones SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    recordEvent(ctx, null, 'milestone.edited', { id, ...patch });
  }
  return emit(ctx, id);
}

/** Deletes a milestone; its tasks stay, without a milestone. */
export function deleteMilestone(ctx: Ctx, id: string): void {
  const m = getMilestone(ctx, id);
  ctx.db.prepare('UPDATE tasks SET milestone_id = NULL WHERE milestone_id = ?').run(id);
  ctx.db.prepare('DELETE FROM milestones WHERE id = ?').run(id);
  recordEvent(ctx, null, 'milestone.deleted', { id, project: m.project_slug });
  publish('milestone.deleted', { id, project_slug: m.project_slug });
}

function emit(ctx: Ctx, id: string): Milestone {
  const m = getMilestone(ctx, id);
  publish('milestone.updated', m);
  return m;
}
