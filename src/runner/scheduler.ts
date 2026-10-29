import type { Ctx } from '../core/context.ts';
import { createMilestoneCheck, createPlanTask, milestonesToCheck, needsPlanning } from '../core/planning.ts';
import { waitSatisfied } from '../core/messages.ts';
import { listQuestions } from '../core/questions.ts';
import { getProject, listProjects } from '../core/projects.ts';
import { fireDue } from '../core/schedules.ts';
import { listTasks, nextRunnable } from '../core/tasks.ts';
import { BrainError } from '../core/types.ts';
import type { Orchestrator } from './orchestrator.ts';
import { removeWorkspace } from './workspace.ts';

/**
 * Every tick: queue the tasks of schedules that are due, resume tasks whose questions are all answered
 * (e.g. answered from the CLI) or whose wait_for_owner is satisfied, queue a check for milestones whose
 * tasks are all done, queue a planner task for auto_plan projects that ran out of work, start the highest-priority `todo` auto tasks while
 * global concurrency and each project's max_parallel allow, and remove worktrees of finished tasks.
 */
export class Scheduler {
  ctx: Ctx;
  orch: Orchestrator;
  timer: NodeJS.Timeout | null = null;
  private warned = new Set<string>();

  constructor(ctx: Ctx, orch: Orchestrator) {
    this.ctx = ctx;
    this.orch = orch;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.ctx.cfg.tickMs);
    this.timer.unref?.();
    setTimeout(() => this.tick(), 200).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private warn(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[scheduler] ${msg}`);
  }

  tick(): void {
    try {
      this.fireSchedules();
      this.resumeAnswered();
      this.checkMilestones();
      this.autoPlan();
      const failed = new Set<string>();
      while (this.orch.runningCount() < this.ctx.cfg.concurrency) {
        const skip = new Set([...this.orch.busyProjects(), ...failed]);
        const t = nextRunnable(this.ctx, skip);
        if (!t) break;
        try {
          this.orch.start(t.id);
          this.warned.delete(`start:${t.id}`);
          console.log(`[scheduler] started ${t.id} (${t.title})`);
        } catch (err) {
          // Don't retry this project in the same tick (e.g. a branch checked out elsewhere).
          failed.add(t.project_slug);
          this.warn(`start:${t.id}`, `could not start ${t.id}: ${(err as Error).message}`);
        }
      }
      this.cleanWorktrees();
    } catch (err) {
      console.error('[scheduler] tick failed:', err);
    }
  }

  private fireSchedules(): void {
    for (const { schedule: s, result } of fireDue(this.ctx)) {
      if (result.status === 'queued') console.log(`[scheduler] schedule ${s.id} queued ${result.task.id} (${s.title})`);
      else console.log(`[scheduler] schedule ${s.id} skipped: ${result.reason}`);
    }
  }

  /**
   * waiting_for_human tasks whose question is answered, or whose wait_for_owner has the owner's input,
   * but whose session was not resumed yet (stored from another process, or the project was at capacity).
   */
  private resumeAnswered(): void {
    for (const t of listTasks(this.ctx, { status: ['waiting_for_human'] })) {
      if (this.orch.busyProjects().has(t.project_slug) || this.orch.runningCount() >= this.ctx.cfg.concurrency) continue;
      let after: 'an answer' | 'owner input';
      if (t.waiting_for) {
        if (!waitSatisfied(this.ctx, t)) continue;
        after = 'owner input';
      } else {
        const qs = listQuestions(this.ctx, { taskId: t.id });
        if (!qs.length || qs.some((q) => !q.answered_at)) continue;
        after = 'an answer';
      }
      try {
        if (after === 'owner input') this.orch.resumeAfterWait(t.id);
        else this.orch.resumeAfterAnswer(t.id);
        console.log(`[scheduler] resumed ${t.id} after ${after}`);
      } catch (err) {
        if (err instanceof BrainError) this.warn(`resume:${t.id}`, `could not resume ${t.id}: ${err.message}`);
        else throw err;
      }
    }
  }

  /** Every active project, auto_plan or not: a finished milestone is checked against its goal. */
  private checkMilestones(): void {
    for (const p of listProjects(this.ctx)) {
      if (p.status !== 'active') continue;
      for (const id of milestonesToCheck(this.ctx, p.slug)) {
        const t = createMilestoneCheck(this.ctx, id, { source: 'milestone_done' });
        console.log(`[scheduler] ${p.slug}: all tasks of milestone ${id} are done: queued check ${t.id}`);
      }
    }
  }

  private autoPlan(): void {
    for (const p of listProjects(this.ctx)) {
      if (!p.auto_plan || p.status !== 'active' || !needsPlanning(this.ctx, p.slug)) continue;
      const t = createPlanTask(this.ctx, p.slug, { source: 'auto_plan' });
      console.log(`[scheduler] ${p.slug} ran out of open work: queued planner task ${t.id}`);
    }
  }

  /** Worktrees of done tasks are removed (their branches stay). */
  private cleanWorktrees(): void {
    for (const t of listTasks(this.ctx, { status: ['done'] })) {
      if (!t.worktree || this.orch.active.has(t.id)) continue;
      removeWorkspace(this.ctx, t.id).catch((err: Error) =>
        this.warn(`worktree:${t.id}`, `could not remove the worktree of ${t.id} (${getProject(this.ctx, t.project_slug).slug}): ${err.message}`),
      );
    }
  }
}
