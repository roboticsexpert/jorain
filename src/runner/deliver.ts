import { now } from '../db/client.ts';
import type { Ctx } from '../core/context.ts';
import { recordEvent } from '../core/events.ts';
import { getProject } from '../core/projects.ts';
import { approveTask, getTask, setTaskFields, type TaskRow } from '../core/tasks.ts';
import { conflict } from '../core/types.ts';
import * as git from './git.ts';
import { removeWorkspace } from './workspace.ts';

/**
 * Delivery of a reviewed task: commit → merge → push. Agents only commit on their task branch; the
 * merge and the push happen here, on the owner's approval.
 *
 * Approve squash-merges `brain/<task>` into the base branch it was cut from (one commit per task),
 * without checking anything out: `git merge-tree` builds the tree, `git commit-tree` the commit, and
 * the base branch is moved with a compare-and-swap. When the owner has the base branch checked out,
 * it is fast-forwarded instead; uncommitted changes there only block it when they touch the same files.
 * A conflict leaves the task in review.
 *
 * Only the merge is synchronous. Removing the worktree and the push can take a minute (a large
 * node_modules, an unreachable remote), so they run after: see `startApproval`.
 */
export function approve(ctx: Ctx, id: string): TaskRow {
  const t = getTask(ctx, id);
  if (t.status !== 'review') throw conflict(`task ${id} is ${t.status}, not review`);
  const r = squashMerge(ctx, t);
  approveTask(ctx, id, r ?? {});
  return getTask(ctx, id);
}

/** The worktree of a done task is not needed any more (the branch stays). Failures are left to the scheduler's cleanup. */
async function dropWorktree(ctx: Ctx, id: string): Promise<void> {
  try {
    await removeWorkspace(ctx, id);
  } catch (err) {
    console.warn(`[brain] could not remove the worktree of ${id}: ${(err as Error).message}`);
  }
}

/**
 * Merges a `done` task whose branch never reached its base (approved by a server without delivery, or
 * closed with `PATCH status → done`). Same squash merge as approve; the task stays `done`.
 */
export function merge(ctx: Ctx, id: string): TaskRow {
  const t = getTask(ctx, id);
  if (t.status !== 'done') throw conflict(`task ${id} is ${t.status}; only done tasks are merged this way (approve a task in review)`);
  if (t.merged_sha) throw conflict(`task ${id} was already merged into ${t.merged_into}`);
  const r = squashMerge(ctx, t);
  if (!r) throw conflict(`task ${id} has no branch to merge`);
  if ('merge' in r) recordEvent(ctx, id, 'task.merge_skipped', r);
  void dropWorktree(ctx, id);
  return getTask(ctx, id);
}

/**
 * Squash-merges the task branch into its base. Returns null for a task without a repo or branch, or
 * what happened: `{ merged_sha }`, or `{ merge }` when there was nothing to merge. Throws 409 on a conflict.
 */
function squashMerge(ctx: Ctx, t: TaskRow): { merged_sha: string } | { merge: 'nothing_to_merge' | 'already_in_base' } | null {
  const id = t.id;
  const cwd = getProject(ctx, t.project_slug).repo_path;
  if (!cwd || !t.branch) return null;
  if (!git.branchExists(cwd, t.branch)) throw conflict(`task branch ${t.branch} no longer exists`);
  const base = t.base_branch;
  if (!base || !git.branchExists(cwd, base)) throw conflict(`task ${id} has no base branch to merge into${base ? ` (${base} is gone)` : ''}`);

  const baseTip = git.revParse(cwd, base);
  if (git.commitCount(cwd, baseTip, t.branch) === 0) return { merge: 'nothing_to_merge' };

  const checkedOut = git.currentBranch(cwd) === base;

  const { tree, conflicts } = git.mergeTree(cwd, baseTip, t.branch);
  if (conflicts.length) {
    recordEvent(ctx, id, 'task.merge_conflict', { into: base, files: conflicts });
    throw conflict(
      `${t.branch} conflicts with ${base} in: ${conflicts.join(', ')}. Use "Update from base" or request changes (the agent can merge ${base} and resolve), then approve again.`,
    );
  }
  if (tree === git.revParse(cwd, `${baseTip}^{tree}`)) return { merge: 'already_in_base' };

  const sha = git.commitTree(cwd, tree, baseTip, squashMessage(t));
  if (checkedOut) {
    // git keeps the owner's uncommitted changes and refuses only when the merge would overwrite them.
    try {
      git.fastForward(cwd, sha);
    } catch (err) {
      const why = ((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n').slice(0, 6).join('\n');
      throw conflict(`${base} is checked out in ${cwd}, and your uncommitted changes there touch files this task changes; commit or stash them, then approve again.\n${why}`);
    }
  } else git.updateBranch(cwd, base, sha, baseTip);

  setTaskFields(ctx, id, { merged_sha: sha, merged_into: base, merged_at: now(), commit_count: git.commitCount(cwd, t.base_sha ?? baseTip, t.branch) });
  recordEvent(ctx, id, 'task.merged', { sha, into: base });
  return { merged_sha: sha };
}

/**
 * Approve (the merge happens now), then remove the worktree and push the base branch when the
 * project's push_policy is `after_merge`. `task` is the approved task; `finished` resolves with it once
 * the worktree is gone and the push is over. A failed push does not undo the merge.
 */
export function startApproval(ctx: Ctx, id: string): { task: TaskRow; finished: Promise<TaskRow> } {
  const task = approve(ctx, id);
  const pushing = task.merged_sha && getProject(ctx, task.project_slug).push_policy === 'after_merge' ? push(ctx, id) : null;
  const finished = Promise.all([dropWorktree(ctx, id), pushing]).then(() => getTask(ctx, id));
  return { task, finished };
}

/** Approve and wait for the worktree removal and the push (CLI, owner MCP). */
export function approveAndPush(ctx: Ctx, id: string): Promise<TaskRow> {
  return startApproval(ctx, id).finished;
}

/**
 * Pushes the branch a task was merged into to its upstream. Any approved-and-merged task can be
 * pushed by hand, whatever the project's policy. Failures are stored on the task (`push_error`), not thrown.
 */
export async function push(ctx: Ctx, id: string): Promise<TaskRow> {
  const t = getTask(ctx, id);
  const cwd = getProject(ctx, t.project_slug).repo_path;
  if (!cwd || !t.merged_sha || !t.merged_into) throw conflict(`task ${id} has not been merged; nothing to push`);
  if (t.pushed_at) throw conflict(`task ${id} was already pushed`);
  const up = git.upstream(cwd, t.merged_into);
  try {
    if (!up) throw new Error(`${t.merged_into} has no upstream (set one with: git branch --set-upstream-to=<remote>/${t.merged_into} ${t.merged_into})`);
    await git.push(cwd, up.remote, t.merged_into, up.ref);
  } catch (err) {
    const message = (err as Error).message;
    recordEvent(ctx, id, 'task.push_failed', { branch: t.merged_into, error: message });
    return setTaskFields(ctx, id, { push_error: message });
  }
  recordEvent(ctx, id, 'task.pushed', { branch: t.merged_into, remote: up.remote });
  return setTaskFields(ctx, id, { pushed_at: now(), push_error: null });
}

function squashMessage(t: TaskRow): string {
  const summary = t.result_summary?.trim();
  return `${t.title}\n\n${summary ? `${summary}\n\n` : ''}Task: ${t.id}\nBranch: ${t.branch}\n`;
}
