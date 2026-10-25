import type { Ctx } from './context.ts';
import { getProject } from './projects.ts';
import { createTask, listTasks, type TaskRow } from './tasks.ts';
import { conflict } from './types.ts';

/**
 * Planner tasks (`kind = 'plan'`) are agent runs that shape a project instead of changing its code: they
 * keep PROJECT.md current, maintain milestones and queue the next tasks (into the inbox, for the owner to
 * triage). The owner starts one with "Plan next steps"; projects with auto_plan get one whenever they run
 * out of open work.
 */

/** Statuses that count as open work: the project is still moving (or waiting on the owner). */
const OPEN = ['inbox', 'todo', 'in_progress', 'waiting_for_human', 'review'] as const;

export function openPlanTask(ctx: Ctx, project: string): TaskRow | undefined {
  return listTasks(ctx, { project }).find((t) => t.kind === 'plan' && t.status !== 'done');
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
