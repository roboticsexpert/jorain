import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { Commit } from '../core/types.ts';

/**
 * Thin git helpers for the project repo and the task worktrees. Synchronous, except `removeWorktree` and `push`. The squash
 * merge into the base branch and the push are only called by `deliver.ts` on the owner's approval.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function isRepo(cwd: string): boolean {
  return tryGit(cwd, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

export function isDirty(cwd: string): boolean {
  return git(cwd, ['status', '--porcelain']).trim().length > 0;
}

export function currentBranch(cwd: string): string | null {
  const b = tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim();
  return b || null;
}

export function headSha(cwd: string): string | null {
  return tryGit(cwd, ['rev-parse', 'HEAD'])?.trim() || null;
}

export function branchExists(cwd: string, branch: string): boolean {
  return tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null;
}

export function checkout(cwd: string, branch: string): void {
  git(cwd, ['checkout', '--quiet', branch]);
}

export function createBranch(cwd: string, branch: string, from: string): void {
  git(cwd, ['checkout', '--quiet', '-b', branch, from]);
}

/** Creates `branch` at `from` without checking anything out. */
export function createBranchAt(cwd: string, branch: string, from: string): void {
  git(cwd, ['branch', '--quiet', branch, from]);
}

/** Checks `branch` out in a new linked worktree at `dir`. Drops stale worktree records first. */
export function addWorktree(repo: string, dir: string, branch: string): void {
  git(repo, ['worktree', 'prune']);
  git(repo, ['worktree', 'add', '--quiet', dir, branch]);
}

/**
 * Removes a linked worktree (ignored files such as node_modules go with it). The branch stays. Async:
 * deleting a worktree full of dependencies takes seconds and must not block the server.
 */
export async function removeWorktree(repo: string, dir: string): Promise<void> {
  await promisify(execFile)('git', ['worktree', 'remove', '--force', dir], { cwd: repo });
}

/** The worktree path where `branch` is checked out, if any (the main checkout included). */
export function worktreeOf(repo: string, branch: string): string | null {
  const out = tryGit(repo, ['worktree', 'list', '--porcelain']) ?? '';
  for (const block of out.split('\n\n')) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1];
    if (dir && block.includes(`\nbranch refs/heads/${branch}`)) return dir;
  }
  return null;
}

export function isAncestor(cwd: string, ancestor: string, of: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, of], { cwd }).status === 0;
}

/**
 * Merges `ref` into the branch checked out in `cwd` (a task worktree). On a conflict the merge is
 * aborted, the tree is left as it was, and the conflicting paths are returned.
 */
export function mergeIn(cwd: string, ref: string, message: string): { ok: true } | { ok: false; conflicts: string[] } {
  const r = spawnSync('git', ['merge', '--no-edit', '--no-verify', '-m', message, ref], { cwd, encoding: 'utf8' });
  if (r.status === 0) return { ok: true };
  const conflicts = (tryGit(cwd, ['diff', '--name-only', '--diff-filter=U']) ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  tryGit(cwd, ['merge', '--abort']);
  if (!conflicts.length) throw new Error(`git merge ${ref} failed: ${(r.stderr || r.stdout).trim()}`);
  return { ok: false, conflicts };
}

export function branchSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'task'
  );
}

export function commitsBetween(cwd: string, base: string, branch: string): Commit[] {
  const out = tryGit(cwd, ['log', '--format=%H%x1f%s%x1f%an%x1f%aI%x1e', `${base}..${branch}`]);
  if (!out) return [];
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, message, author, date] = r.split('\x1f');
      return { sha, message, author, date };
    });
}

export function diffBetween(cwd: string, base: string, branch: string): string {
  return tryGit(cwd, ['diff', `${base}...${branch}`]) ?? '';
}

export function revParse(cwd: string, ref: string): string {
  return git(cwd, ['rev-parse', ref]).trim();
}

export function commitCount(cwd: string, base: string, branch: string): number {
  return Number(tryGit(cwd, ['rev-list', '--count', `${base}..${branch}`])?.trim() ?? 0) || 0;
}

/** Commits everything in the working tree (untracked files included), skipping commit hooks. */
export function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '--quiet', '--no-verify', '-m', message]);
}

/**
 * Three-way merge of two commits without touching the working tree or index (`git merge-tree`).
 * Returns the merged tree, or the conflicting paths.
 */
export function mergeTree(cwd: string, ours: string, theirs: string): { tree: string; conflicts: string[] } {
  const r = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs], { cwd, encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git merge-tree failed: ${r.stderr.trim() || r.error?.message}`);
  const [tree, ...rest] = r.stdout.split('\n').map((l) => l.trim());
  return { tree, conflicts: r.status === 1 ? [...new Set(rest.filter(Boolean))] : [] };
}

/** Writes a commit object for `tree` on top of `parent` (git config supplies the author). */
export function commitTree(cwd: string, tree: string, parent: string, message: string): string {
  return execFileSync('git', ['commit-tree', tree, '-p', parent, '-F', '-'], { cwd, encoding: 'utf8', input: message }).trim();
}

/** Moves a branch that is not checked out, only if it still points at `expected`. */
export function updateBranch(cwd: string, branch: string, to: string, expected: string): void {
  git(cwd, ['update-ref', `refs/heads/${branch}`, to, expected]);
}

/** Fast-forwards the checked-out branch (and working tree) to `sha`. */
export function fastForward(cwd: string, sha: string): void {
  git(cwd, ['merge', '--ff-only', '--quiet', sha]);
}

/** Where `branch` pushes to, from its upstream config: `{ remote, ref }`, or null when it has none. */
export function upstream(cwd: string, branch: string): { remote: string; ref: string } | null {
  const remote = tryGit(cwd, ['config', '--get', `branch.${branch}.remote`])?.trim();
  const ref = tryGit(cwd, ['config', '--get', `branch.${branch}.merge`])?.trim();
  return remote && ref && remote !== '.' ? { remote, ref } : null;
}

/** `git push <remote> <branch>:<ref>`, never prompting for credentials. */
export function push(cwd: string, remote: string, branch: string, ref: string, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['push', '--quiet', remote, `refs/heads/${branch}:${ref}`],
      { cwd, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()),
    );
  });
}
