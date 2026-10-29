import type { Ctx } from './context.ts';
import { getMilestone, listMilestones } from './milestones.ts';
import { getProject } from './projects.ts';
import { createTask, listTasks, type TaskRow } from './tasks.ts';
import { conflict } from './types.ts';

/**
 * Planner tasks (`kind = 'plan'`) are agent runs that shape a project instead of changing its code: they
 * keep PROJECT.md current, maintain milestones and queue the next tasks (into the inbox, for the owner to
 * triage). The owner starts one with "Plan next steps"; projects with auto_plan get one whenever they run
 * out of open work.
 *
 * A planner task with a milestone is a milestone check: when every work task of an open milestone is done,
 * an agent checks whether the milestone's goal is actually met. If not, it queues tasks for what is missing;
 * if it is, it asks the owner whether to close the milestone.
 */

/** Statuses that count as open work: the project is still moving (or waiting on the owner). */
const OPEN = ['inbox', 'todo', 'in_progress', 'waiting_for_human', 'review'] as const;

/** The unfinished project planner (milestone checks are left out: they don't block one). */
export function openPlanTask(ctx: Ctx, project: string): TaskRow | undefined {
  return listTasks(ctx, { project }).find((t) => t.kind === 'plan' && !t.milestone_id && t.status !== 'done');
}

export function createPlanTask(ctx: Ctx, project: string, opts: { focus?: string; source?: string } = {}): TaskRow {
  getProject(ctx, project);
  const open = openPlanTask(ctx, project);
  if (open) throw conflict(`project ${project} already has a planner task (${open.id}, ${open.status}); finish or cancel it first`);
  return createTask(
    ctx,
    { project_slug: project, title: 'Plan next steps', body: opts.focus?.trim() ?? '', kind: 'plan', priority: 3, status: 'todo', depends_on: [] },
    opts.source ?? 'owner',
  );
}

/**
 * Whether an auto_plan project should get a planner task now: no open work, no unfinished planner task,
 * and the last planner task is older than the cooldown (so a plan that queued nothing doesn't loop).
 */
export function needsPlanning(ctx: Ctx, project: string, at = Date.now()): boolean {
  const tasks = listTasks(ctx, { project });
  if (tasks.some((t) => t.kind === 'plan' && t.status !== 'done')) return false;
  if (tasks.some((t) => (OPEN as readonly string[]).includes(t.status))) return false;
  const lastPlan = tasks.find((t) => t.kind === 'plan');
  return !lastPlan || at - Date.parse(lastPlan.created_at) >= ctx.cfg.planCooldownMs;
}

/**
 * Open milestones of a project that need a check now: they have work tasks and all of them are done, no
 * check of the milestone is unfinished, and no check ran since the newest of its tasks was created (so a
 * check that found nothing missing, or that the owner kept open, does not loop; new tasks re-arm it).
 */
export function milestonesToCheck(ctx: Ctx, project: string): string[] {
  const tasks = listTasks(ctx, { project });
  return listMilestones(ctx, project, { includeDone: false })
    .filter((m) => {
      if (!m.total || m.done < m.total) return false;
      const own = tasks.filter((t) => t.milestone_id === m.id);
      const checks = own.filter((t) => t.kind === 'plan');
      if (checks.some((t) => t.status !== 'done')) return false;
      const lastCheck = checks.reduce((a, t) => (t.created_at > a ? t.created_at : a), '');
      const lastWork = own.filter((t) => t.kind === 'work').reduce((a, t) => (t.created_at > a ? t.created_at : a), '');
      return !lastCheck || lastWork > lastCheck;
    })
    .map((m) => m.id);
}

export function createMilestoneCheck(ctx: Ctx, milestoneId: string, opts: { source?: string } = {}): TaskRow {
  const m = getMilestone(ctx, milestoneId);
  const open = listTasks(ctx, { project: m.project_slug }).find((t) => t.kind === 'plan' && t.milestone_id === m.id && t.status !== 'done');
  if (open) throw conflict(`milestone ${m.id} already has a check (${open.id}, ${open.status})`);
  return createTask(
    ctx,
    { project_slug: m.project_slug, title: `Check milestone "${m.title}"`, body: '', kind: 'plan', priority: 3, status: 'todo', milestone: m.id, depends_on: [] },
    opts.source ?? 'owner',
  );
}
