import type { Ctx } from './context.ts';
import { listMilestones } from './milestones.ts';
import { listProjects } from './projects.ts';
import type { Milestone, Project, TaskStatus } from './types.ts';

export interface ProjectSummary {
  project: Project;
  /** Work-task counts by status (planner tasks excluded). */
  counts: Partial<Record<TaskStatus, number>>;
  open_questions: number;
  in_review: number;
  /** Open milestones in order, with progress. */
  milestones: Milestone[];
  cost_usd: { total: number; last_7_days: number };
  runs: { total: number; last_7_days: number };
  last_activity: string | null;
  /** Whether a planner task is queued or running. */
  planning: boolean;
}

export interface Portfolio {
  projects: ProjectSummary[];
  totals: { cost_usd: number; cost_last_7_days: number; open_questions: number; in_review: number; running: number };
}

/** One row per project for the overview page: progress, what waits on the owner, and what it costs. */
export function portfolio(ctx: Ctx, at = new Date()): Portfolio {
  const since = new Date(at.getTime() - 7 * 86_400_000).toISOString();
  const projects = listProjects(ctx).filter((p) => p.status === 'active');
  const counts = ctx.db.prepare(`SELECT status, COUNT(*) AS n FROM tasks WHERE project_slug = ? AND kind = 'work' GROUP BY status`);
  const questions = ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM questions q JOIN tasks t ON t.id = q.task_id WHERE t.project_slug = ? AND q.answered_at IS NULL`,
  );
  const cost = ctx.db.prepare(
    `SELECT COALESCE(SUM(r.cost_usd), 0) AS total, COALESCE(SUM(CASE WHEN r.started_at >= ? THEN r.cost_usd END), 0) AS recent,
            COUNT(*) AS runs, COALESCE(SUM(CASE WHEN r.started_at >= ? THEN 1 END), 0) AS recent_runs
       FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.project_slug = ?`,
  );
  const activity = ctx.db.prepare(`SELECT MAX(updated_at) AS at FROM tasks WHERE project_slug = ?`);
  const planning = ctx.db.prepare(`SELECT 1 FROM tasks WHERE project_slug = ? AND kind = 'plan' AND status IN ('todo','in_progress','waiting_for_human')`);

  const rows: ProjectSummary[] = projects.map((p) => {
    const c: ProjectSummary['counts'] = {};
    for (const r of counts.all(p.slug) as { status: TaskStatus; n: number }[]) c[r.status] = r.n;
    const k = cost.get(since, since, p.slug) as { total: number; recent: number; runs: number; recent_runs: number };
    return {
      project: p,
      counts: c,
      open_questions: (questions.get(p.slug) as { n: number }).n,
      in_review: c.review ?? 0,
      milestones: listMilestones(ctx, p.slug, { includeDone: false }),
      cost_usd: { total: round(k.total), last_7_days: round(k.recent) },
      runs: { total: k.runs, last_7_days: k.recent_runs },
      last_activity: (activity.get(p.slug) as { at: string | null }).at,
      planning: Boolean(planning.get(p.slug)),
    };
  });
  return {
    projects: rows,
    totals: {
      cost_usd: round(rows.reduce((s, r) => s + r.cost_usd.total, 0)),
      cost_last_7_days: round(rows.reduce((s, r) => s + r.cost_usd.last_7_days, 0)),
      open_questions: rows.reduce((s, r) => s + r.open_questions, 0),
      in_review: rows.reduce((s, r) => s + r.in_review, 0),
      running: rows.reduce((s, r) => s + (r.counts.in_progress ?? 0), 0),
    },
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
