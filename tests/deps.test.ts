import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listEvents } from '../src/core/events.ts';
import { createProject } from '../src/core/projects.ts';
import { createTask, getTask, listTasks, nextRunnable, updateTask } from '../src/core/tasks.ts';
import { approve, merge } from '../src/runner/deliver.ts';
import { Orchestrator } from '../src/runner/orchestrator.ts';
import { staleBuild } from '../src/server/stale-build.ts';
import { gitOut, tempCtx, tempRepo } from './helpers.ts';

const fake = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

/** A repo project with task A run by the fake claude (in review) and task B in todo depending on A. */
async function chain() {
  const ctx = tempCtx({ BRAIN_CLAUDE_BIN: fake, BRAIN_TICK_MS: '100000' });
  const repo = tempRepo();
  createProject(ctx, { slug: 'p', name: 'P', repo_path: repo });
  const orch = new Orchestrator(ctx);
  const a = createTask(ctx, { project_slug: 'p', title: 'plain change' });
  orch.start(a.id);
  await orch.wait(a.id);
  const b = createTask(ctx, { project_slug: 'p', title: 'builds on A', status: 'todo', depends_on: [a.id] });
  return { ctx, repo, orch, a: a.id, b: b.id };
}

describe('task dependencies', { timeout: 20_000 }, () => {
  it('a task waits until its dependency is approved and merged', async () => {
    const { ctx, orch, a, b } = await chain();
    expect(getTask(ctx, b)).toMatchObject({ depends_on: [a], waiting_on: [a] });
    expect(nextRunnable(ctx, new Set())).toBeUndefined();
    expect(() => orch.start(b)).toThrow(/waits on/);

    approve(ctx, a);
    expect(getTask(ctx, b).waiting_on).toEqual([]);
    expect(nextRunnable(ctx, new Set())?.id).toBe(b);
  });

  it('a done task that was never merged keeps dependents waiting until it is merged', async () => {
    const { ctx, repo, a, b } = await chain();
    updateTask(ctx, a, { status: 'done' }); // closes without merging
    expect(getTask(ctx, b).waiting_on).toEqual([a]);
    expect(listTasks(ctx, { status: ['todo'] })[0].waiting_on).toEqual([a]);

    const t = merge(ctx, a);
    expect(t.merged_sha).toBe(gitOut(repo, 'rev-parse', 'main'));
    expect(t.status).toBe('done');
    expect(getTask(ctx, b).waiting_on).toEqual([]);
    expect(() => merge(ctx, a)).toThrow(/already merged/);
  });

  it('merging a done task with nothing left to merge also releases dependents', async () => {
    const { ctx, repo, a, b } = await chain();
    const branch = getTask(ctx, a).branch!;
    updateTask(ctx, a, { status: 'done' });
    gitOut(repo, 'merge', '-q', '--squash', branch);
    gitOut(repo, 'commit', '-qm', 'merged by hand');
    merge(ctx, a);
    expect(listEvents(ctx, a).find((e) => e.type === 'task.merge_skipped')?.payload).toEqual({ merge: 'already_in_base' });
    expect(getTask(ctx, b).waiting_on).toEqual([]);
  });

  it('rejects unknown tasks, itself and cycles, and writes nothing on a bad create', () => {
    const ctx = tempCtx();
    createProject(ctx, { slug: 'p', name: 'P' });
    const a = createTask(ctx, { project_slug: 'p', title: 'A' });
    const b = createTask(ctx, { project_slug: 'p', title: 'B', depends_on: [a.id] });
    expect(() => createTask(ctx, { project_slug: 'p', title: 'C', depends_on: ['t_nope'] })).toThrow(/unknown task t_nope/);
    expect(listTasks(ctx)).toHaveLength(2);
    expect(() => updateTask(ctx, a.id, { depends_on: [a.id] })).toThrow(/itself/);
    expect(() => updateTask(ctx, a.id, { depends_on: [b.id] })).toThrow(/cycle/);
    expect(updateTask(ctx, b.id, { depends_on: [] }).depends_on).toEqual([]);
  });

  it('a dependency without a repo is met once it is done', () => {
    const ctx = tempCtx();
    createProject(ctx, { slug: 'p', name: 'P' });
    const a = createTask(ctx, { project_slug: 'p', title: 'A', status: 'todo' });
    const b = createTask(ctx, { project_slug: 'p', title: 'B', status: 'todo', depends_on: [a.id] });
    expect(nextRunnable(ctx, new Set())?.id).toBe(a.id);
    ctx.db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(a.id);
    expect(getTask(ctx, b.id).waiting_on).toEqual([]);
  });
});

describe('stale build guard', () => {
  it('flags a dist entry older than a source file, and ignores runs from src/', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'brain-build-'));
    mkdirSync(path.join(root, 'src/server'), { recursive: true });
    mkdirSync(path.join(root, 'dist/server'), { recursive: true });
    const entry = path.join(root, 'dist/server/index.js');
    const source = path.join(root, 'src/server/index.ts');
    writeFileSync(entry, '');
    writeFileSync(source, '');
    utimesSync(entry, new Date(1_000_000), new Date(1_000_000));
    expect(staleBuild(pathToFileURL(entry).href)).toMatch(/src\/server\/index.ts changed after the last build/);
    utimesSync(entry, new Date(), new Date());
    utimesSync(source, new Date(1_000_000), new Date(1_000_000));
    expect(staleBuild(pathToFileURL(entry).href)).toBeNull();
    expect(staleBuild(pathToFileURL(source).href)).toBeNull();
  });
});
