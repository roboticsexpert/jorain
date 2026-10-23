import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listEvents } from '../src/core/events.ts';
import { createProject, updateProject } from '../src/core/projects.ts';
import { createTask, getTask } from '../src/core/tasks.ts';
import { approve, approveAndPush, push } from '../src/runner/deliver.ts';
import { Orchestrator } from '../src/runner/orchestrator.ts';
import { gitOut, tempCtx, tempRepo } from './helpers.ts';

const fake = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

/** A project whose task `title` has been run by the fake claude and is waiting in review. */
async function reviewed(title = 'plain change') {
  const ctx = tempCtx({ BRAIN_CLAUDE_BIN: fake, BRAIN_TICK_MS: '100000' });
  const repo = tempRepo();
  createProject(ctx, { slug: 'p', name: 'P', repo_path: repo });
  const orch = new Orchestrator(ctx);
  const t = createTask(ctx, { project_slug: 'p', title });
  orch.start(t.id);
  await orch.wait(t.id);
  expect(getTask(ctx, t.id).status).toBe('review');
  return { ctx, repo, orch, id: t.id };
}

const types = (ctx: ReturnType<typeof tempCtx>, id: string) => listEvents(ctx, id).map((e) => e.type);

describe('delivery: commit → merge → push', { timeout: 20_000 }, () => {
  it('approve squash-merges the task branch into the checked-out base', async () => {
    const { ctx, repo, id } = await reviewed();
    expect(getTask(ctx, id).commit_count).toBe(1);
    const t = approve(ctx, id);
    expect(t.status).toBe('done');
    expect(t.merged_into).toBe('main');
    expect(gitOut(repo, 'rev-parse', 'main')).toBe(t.merged_sha);
    expect(gitOut(repo, 'log', '-1', '--format=%s', 'main')).toBe('plain change');
    expect(gitOut(repo, 'log', '-1', '--format=%P', 'main').split(' ')).toHaveLength(1); // squash, not a merge commit
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toContain('hello from brain'); // working tree followed
    expect(gitOut(repo, 'status', '--porcelain')).toBe('');
    expect(types(ctx, id)).toContain('task.merged');
  });

  it('merges without a checkout when the owner is on another branch', async () => {
    const { ctx, repo, id } = await reviewed();
    gitOut(repo, 'checkout', '-q', '-b', 'mine');
    writeFileSync(path.join(repo, 'wip.txt'), 'owner work in progress\n');
    const t = approve(ctx, id);
    expect(gitOut(repo, 'rev-parse', 'main')).toBe(t.merged_sha);
    expect(gitOut(repo, 'branch', '--show-current')).toBe('mine');
    expect(gitOut(repo, 'status', '--porcelain')).toBe('?? wip.txt');
  });

  it('a conflict keeps the task in review and records the files', async () => {
    const { ctx, repo, id } = await reviewed();
    writeFileSync(path.join(repo, 'README.md'), '# changed on main\n');
    gitOut(repo, 'commit', '-qam', 'main moved');
    expect(() => approve(ctx, id)).toThrow(/conflicts with main in: README.md/);
    expect(getTask(ctx, id).status).toBe('review');
    expect(listEvents(ctx, id).find((e) => e.type === 'task.merge_conflict')?.payload).toMatchObject({ into: 'main', files: ['README.md'] });
  });

  it('refuses to fast-forward a checked-out base whose uncommitted changes touch the same files', async () => {
    const { ctx, repo, id } = await reviewed();
    const main = gitOut(repo, 'rev-parse', 'main');
    writeFileSync(path.join(repo, 'README.md'), 'owner edit\n');
    expect(() => approve(ctx, id)).toThrow(expect.objectContaining({ status: 409, message: expect.stringMatching(/touch files this task changes/) }));
    expect(getTask(ctx, id)).toMatchObject({ status: 'review', merged_sha: null });
    expect(gitOut(repo, 'rev-parse', 'main')).toBe(main);
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('owner edit\n');
  });

  it('fast-forwards past unrelated uncommitted changes and keeps them', async () => {
    const { ctx, repo, id } = await reviewed();
    writeFileSync(path.join(repo, 'owner-wip.txt'), 'mine\n');
    writeFileSync(path.join(repo, 'other.md'), 'x\n');
    gitOut(repo, 'add', 'other.md');
    const t = approve(ctx, id);
    expect(gitOut(repo, 'rev-parse', 'main')).toBe(t.merged_sha);
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toContain('hello from brain');
    expect(gitOut(repo, 'status', '--porcelain')).toBe('A  other.md\n?? owner-wip.txt');
  });

  it('push policy after_merge pushes the base branch to its upstream', async () => {
    const { ctx, repo, id } = await reviewed();
    const remote = mkdtempSync(path.join(os.tmpdir(), 'brain-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    gitOut(repo, 'remote', 'add', 'origin', remote);
    gitOut(repo, 'push', '-q', '-u', 'origin', 'main');
    updateProject(ctx, 'p', { push_policy: 'after_merge' });
    const t = await approveAndPush(ctx, id);
    expect(t.pushed_at).not.toBeNull();
    expect(t.push_error).toBeNull();
    expect(execFileSync('git', ['rev-parse', 'main'], { cwd: remote, encoding: 'utf8' }).trim()).toBe(t.merged_sha);
    await expect(push(ctx, id)).rejects.toThrow(/already pushed/);
  });

  it('a failed push leaves the task done and merged, with the error stored', async () => {
    const { ctx, id } = await reviewed();
    updateProject(ctx, 'p', { push_policy: 'after_merge' });
    const t = await approveAndPush(ctx, id);
    expect(t.status).toBe('done');
    expect(t.merged_sha).not.toBeNull();
    expect(t.pushed_at).toBeNull();
    expect(t.push_error).toMatch(/no upstream/);
    expect(types(ctx, id)).toContain('task.push_failed');
  });

  it('policy never does not push; push before merge is refused', async () => {
    const { ctx, id } = await reviewed();
    await expect(push(ctx, id)).rejects.toThrow(/not been merged/);
    const t = await approveAndPush(ctx, id);
    expect(t.merged_sha).not.toBeNull();
    expect(t.pushed_at).toBeNull();
    expect(t.push_error).toBeNull();
  });

  it('changes the agent left uncommitted are committed on its branch', async () => {
    const { ctx, repo, id } = await reviewed('DIRTY leave notes');
    const t = getTask(ctx, id);
    expect(t.commit_count).toBe(1);
    expect(gitOut(repo, 'log', '-1', '--format=%s', t.branch!)).toBe('WIP: changes the agent left uncommitted');
    expect(gitOut(repo, 'branch', '--show-current')).toBe('main');
    expect(gitOut(repo, 'status', '--porcelain')).toBe('');
    expect(types(ctx, id)).toContain('task.autocommit');
  });
});
