import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../core/context.ts';
import { recordEvent } from '../core/events.ts';
import { getProject, projectDir } from '../core/projects.ts';
import { getTask, listTasks, setTaskFields, type TaskRow } from '../core/tasks.ts';
import { conflict, type Project } from '../core/types.ts';
import * as git from './git.ts';

/**
 * Where a task runs. A code project gives every task its own git worktree on `brain/<task>` under
 * BRAIN_WORKTREES_DIR, so several tasks of one project can run at once and the owner's own checkout is
 * never switched, dirtied or blocking. A project without a repo runs in brain/projects/<slug>/.
 */

export function worktreeDir(ctx: Ctx, task: TaskRow): string {
  return path.join(ctx.cfg.worktreesDir, task.project_slug, task.id);
}

/** The task's working directory as it stands (no side effects). */
export function workDir(ctx: Ctx, task: TaskRow, project: Project): string {
  if (!project.repo_path) return projectDir(ctx, project.slug);
  return task.worktree && existsSync(task.worktree) ? task.worktree : worktreeDir(ctx, task);
}

/**
 * Makes sure the task has a branch and a worktree with that branch checked out, and commits anything a
 * crashed run left behind. Returns the working directory and whether the worktree is new (its
 * dependencies are not installed yet).
 */
export function ensureWorkspace(ctx: Ctx, taskId: string): { cwd: string; created: boolean } {
  let task = getTask(ctx, taskId);
  const project = getProject(ctx, task.project_slug);
  const repo = project.repo_path;
  if (!repo) return { cwd: projectDir(ctx, project.slug), created: false };
  if (!git.isRepo(repo)) throw conflict(`${repo} is not a git repository`);

  if (!task.branch || !git.branchExists(repo, task.branch)) {
    // Branch from the owner's current branch, unless that is another task's branch: then from that task's base.
    const current = git.currentBranch(repo);
    let base = current ?? 'HEAD';
    if (current?.startsWith('brain/')) base = listTasks(ctx).find((t) => t.branch === current)?.base_branch ?? base;
    let baseSha: string;
    try {
      baseSha = git.revParse(repo, base);
    } catch {
      throw conflict(`${repo} has no commit to branch from (${base})`);
    }
    const branch = task.branch ?? `brain/${task.id}-${git.branchSlug(task.title)}`;
    git.createBranchAt(repo, branch, baseSha);
    task = setTaskFields(ctx, task.id, { branch, base_branch: base === 'HEAD' ? null : base, base_sha: baseSha });
  }

  const dir = task.worktree ?? worktreeDir(ctx, task);
  let created = false;
  if (!existsSync(path.join(dir, '.git'))) {
    const elsewhere = git.worktreeOf(repo, task.branch!);
    if (elsewhere && path.resolve(elsewhere) !== path.resolve(dir)) {
      throw conflict(`${task.branch} is checked out in ${elsewhere}; switch that checkout to another branch so the task can get its own worktree`);
    }
    mkdirSync(path.dirname(dir), { recursive: true });
    git.addWorktree(repo, dir, task.branch!);
    created = true;
    recordEvent(ctx, task.id, 'task.worktree', { path: dir, branch: task.branch });
  } else if (git.currentBranch(dir) !== task.branch) {
    if (git.isDirty(dir)) git.commitAll(dir, `WIP: uncommitted changes found before switching back to ${task.branch}\n\nTask: ${task.id}\n`);
    git.checkout(dir, task.branch!);
  }
  if (task.worktree !== dir) setTaskFields(ctx, task.id, { worktree: dir });
  if (git.isDirty(dir)) {
    git.commitAll(dir, `WIP: changes left uncommitted by an earlier run\n\nTask: ${task.id}\n`);
    recordEvent(ctx, task.id, 'task.autocommit', { sha: git.headSha(dir), reason: 'leftovers_before_run' });
  }
  return { cwd: dir, created };
}

export type SyncResult =
  | { status: 'no_branch' | 'up_to_date' | 'fast_forwarded' | 'merged'; base?: string }
  | { status: 'conflict'; base: string; conflicts: string[] }
  | { status: 'skipped'; base: string; reason: string };

/**
 * Brings the task branch up to date with its base branch, so work that landed after the branch was cut
 * (dependencies, other tasks) is there. A branch with no commits of its own is fast-forwarded; one with
 * commits gets the base merged in, unless `mergeAllowed` is false (a paused session resuming after an
 * answer: its files should not change under it), or the merge conflicts: then nothing changes and the
 * caller tells the agent to merge and resolve.
 */
export function syncWithBase(ctx: Ctx, taskId: string, opts: { mergeAllowed: boolean }): SyncResult {
  const task = getTask(ctx, taskId);
  const repo = getProject(ctx, task.project_slug).repo_path;
  if (!repo || !task.branch || !git.branchExists(repo, task.branch)) return { status: 'no_branch' };
  const base = task.base_branch;
  if (!base || !git.branchExists(repo, base)) return { status: 'up_to_date' };
  const baseTip = git.revParse(repo, base);
  if (git.isAncestor(repo, baseTip, task.branch)) return { status: 'up_to_date', base };

  const cwd = task.worktree && existsSync(task.worktree) ? task.worktree : null;
  const own = git.commitCount(repo, baseTip, task.branch);
  let result: SyncResult;
  if (own === 0) {
    if (cwd) git.fastForward(cwd, baseTip);
    else git.updateBranch(repo, task.branch, baseTip, git.revParse(repo, task.branch));
    result = { status: 'fast_forwarded', base };
  } else if (!opts.mergeAllowed) {
    return { status: 'skipped', base, reason: 'the session is paused mid-task' };
  } else if (!cwd) {
    return { status: 'skipped', base, reason: 'the task has no worktree yet' };
  } else {
    const m = git.mergeIn(cwd, base, `Merge ${base} into ${task.branch}`);
    if (!m.ok) {
      recordEvent(ctx, taskId, 'task.sync_conflict', { base, files: m.conflicts });
      return { status: 'conflict', base, conflicts: m.conflicts };
    }
    result = { status: 'merged', base };
  }
  // Commits and diffs are counted from the base as it is now, so they show only the task's own work.
  setTaskFields(ctx, taskId, { base_sha: baseTip, commit_count: git.commitCount(repo, baseTip, task.branch) });
  recordEvent(ctx, taskId, 'task.synced', { base, to: baseTip, how: result.status });
  return result;
}

/** Text for the agent's prompt when the branch could not be brought up to date by the server. */
export function syncNote(r: SyncResult): string | null {
  if (r.status !== 'conflict') return null;
  return [
    `Your branch is behind ${r.base}, and merging ${r.base} into it conflicts in: ${r.conflicts.join(', ')}.`,
    `Before anything else, run \`git merge ${r.base}\`, resolve the conflicts keeping both sides' intent, run the checks, and commit the merge.`,
  ].join(' ');
}

const removing = new Map<string, Promise<boolean>>();

/**
 * Removes the worktree of a finished task (the branch is kept). Resolves to whether one was removed.
 * One removal per task at a time: approve and the scheduler's cleanup may both ask for it.
 */
export function removeWorkspace(ctx: Ctx, taskId: string): Promise<boolean> {
  let p = removing.get(taskId);
  if (!p) {
    p = dropWorkspace(ctx, taskId).finally(() => removing.delete(taskId));
    removing.set(taskId, p);
  }
  return p;
}

async function dropWorkspace(ctx: Ctx, taskId: string): Promise<boolean> {
  const task = getTask(ctx, taskId);
  const repo = getProject(ctx, task.project_slug).repo_path;
  if (!repo || !task.worktree) return false;
  if (existsSync(task.worktree)) {
    if (git.isDirty(task.worktree)) git.commitAll(task.worktree, `WIP: changes left in the worktree when the task finished\n\nTask: ${task.id}\n`);
    await git.removeWorktree(repo, task.worktree);
  }
  setTaskFields(ctx, taskId, { worktree: null });
  recordEvent(ctx, taskId, 'task.worktree_removed', { path: task.worktree });
  return true;
}
