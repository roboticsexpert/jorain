import type { Ctx } from '../core/context.ts';
import { createPlanTask, needsPlanning } from '../core/planning.ts';
import { listQuestions } from '../core/questions.ts';
import { getProject, listProjects } from '../core/projects.ts';
import { fireDue } from '../core/schedules.ts';
import { listTasks, nextRunnable } from '../core/tasks.ts';
import { BrainError } from '../core/types.ts';
import type { Orchestrator } from './orchestrator.ts';
import { removeWorkspace } from './workspace.ts';

/**
 * Every tick: queue the tasks of schedules that are due, resume tasks whose questions are all answered
 * (e.g. answered from the CLI), queue a planner
 * task for auto_plan projects that ran out of work, start the highest-priority `todo` auto tasks while
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

  /** waiting_for_human tasks with no open question left: the answer was stored but the session not resumed yet. */
  private resumeAnswered(): void {
    for (const t of listTasks(this.ctx, { status: ['waiting_for_human'] })) {
      if (this.orch.busyProjects().has(t.project_slug) || this.orch.runningCount() >= this.ctx.cfg.concurrency) continue;
      const qs = listQuestions(this.ctx, { taskId: t.id });
      if (!qs.length || qs.some((q) => !q.answered_at)) continue;
      try {
        this.orch.resumeAfterAnswer(t.id);
        console.log(`[scheduler] resumed ${t.id} after an answer`);
      } catch (err) {
        if (err instanceof BrainError) this.warn(`resume:${t.id}`, `could not resume ${t.id}: ${err.message}`);
        else throw err;
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
      try {
        removeWorkspace(this.ctx, t.id);
      } catch (err) {
        this.warn(`worktree:${t.id}`, `could not remove the worktree of ${t.id} (${getProject(this.ctx, t.project_slug).slug}): ${(err as Error).message}`);
      }
    }
  }
}
