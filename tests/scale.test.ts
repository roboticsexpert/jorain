import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { listEvents } from '../src/core/events.ts';
import { createMilestone, deleteMilestone, listMilestones, updateMilestone } from '../src/core/milestones.ts';
import { createMilestoneCheck, createPlanTask, milestonesToCheck, needsPlanning } from '../src/core/planning.ts';
import { portfolio } from '../src/core/portfolio.ts';
import { createProject, getProject, readProjectDoc, updateProject } from '../src/core/projects.ts';
import { createTask, getTask, listTasks, transition } from '../src/core/tasks.ts';
import { buildServer } from '../src/mcp/server.ts';
import { approve } from '../src/runner/deliver.ts';
import { Orchestrator } from '../src/runner/orchestrator.ts';
import { initialPrompt, milestoneCheckPrompt, planPrompt } from '../src/runner/prompt.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { ensureWorkspace, syncNote, syncWithBase } from '../src/runner/workspace.ts';
import { gitOut, tempCtx, tempRepo } from './helpers.ts';

const fake = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

function setup(project: Parameters<typeof createProject>[1] extends infer P ? Partial<P> : never = {}) {
  const ctx = tempCtx({ BRAIN_CLAUDE_BIN: fake, BRAIN_TICK_MS: '100000' });
  const repo = tempRepo();
  createProject(ctx, { slug: 'p', name: 'P', repo_path: repo, ...project });
  return { ctx, repo, orch: new Orchestrator(ctx) };
}

describe('worktrees and parallel tasks', { timeout: 30_000 }, () => {
  it('runs tasks of one project side by side in their own worktrees, up to max_parallel', async () => {
    const { ctx, repo, orch } = setup({ max_parallel: 2 });
    // c has the lowest priority, so it is the one left waiting (a and b may share a created_at millisecond).
    const [a, b, c] = (['a', 'DIRTY b', 'c'] as const).map((title) => createTask(ctx, { project_slug: 'p', title, status: 'todo', priority: title === 'c' ? 1 : 2 }));
    new Scheduler(ctx, orch).tick();
    expect([a, b, c].map((t) => getTask(ctx, t.id).status)).toEqual(['in_progress', 'in_progress', 'todo']);
    const wa = getTask(ctx, a.id).worktree!;
    const wb = getTask(ctx, b.id).worktree!;
    expect(wa).not.toBe(wb);
    await orch.waitAll();
    expect(gitOut(wa, 'branch', '--show-current')).toBe(getTask(ctx, a.id).branch);
    expect(gitOut(repo, 'branch', '--show-current')).toBe('main');
    // b left notes.txt uncommitted: the runner committed it in b's worktree, not in the owner's checkout.
    expect(gitOut(repo, 'show', `${getTask(ctx, b.id).branch}:notes.txt`)).toBe('left uncommitted');
    expect(existsSync(path.join(repo, 'notes.txt'))).toBe(false);
  });

  it('approve merges and removes the worktree; the branch stays', async () => {
    const { ctx, repo, orch } = setup();
    const t = createTask(ctx, { project_slug: 'p', title: 'plain change' });
    orch.start(t.id);
    await orch.wait(t.id);
    const wt = getTask(ctx, t.id).worktree!;
    const done = approve(ctx, t.id);
    expect(done.status).toBe('done');
    expect(done.worktree).toBeNull();
    expect(existsSync(wt)).toBe(false);
    expect(gitOut(repo, 'branch', '--list', done.branch!)).toContain(done.branch!);
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toContain('hello from brain');
  });
});

describe('sync with base', { timeout: 30_000 }, () => {
  it('fast-forwards a branch without its own commits and merges the base into one with commits', async () => {
    const { ctx, repo, orch } = setup({ max_parallel: 3 });
    const a = createTask(ctx, { project_slug: 'p', title: 'plain change' });
    const b = createTask(ctx, { project_slug: 'p', title: 'DIRTY b' });
    const c = createTask(ctx, { project_slug: 'p', title: 'not started yet' });
    orch.start(a.id);
    orch.start(b.id);
    ensureWorkspace(ctx, c.id); // branch + worktree cut from main now, no commits
    await orch.waitAll();
    approve(ctx, a.id); // main moves on

    expect(syncWithBase(ctx, c.id, { mergeAllowed: false }).status).toBe('fast_forwarded');
    expect(gitOut(repo, 'rev-parse', getTask(ctx, c.id).branch!)).toBe(gitOut(repo, 'rev-parse', 'main'));
    expect(readFileSync(path.join(getTask(ctx, c.id).worktree!, 'README.md'), 'utf8')).toContain('hello from brain');

    expect(syncWithBase(ctx, b.id, { mergeAllowed: false }).status).toBe('skipped');
    const r = orch.sync(b.id);
    expect(r.status).toBe('merged');
    const tb = getTask(ctx, b.id);
    expect(gitOut(repo, 'show', `${tb.branch}:README.md`)).toContain('hello from brain');
    expect(tb.base_sha).toBe(gitOut(repo, 'rev-parse', 'main'));
    expect(tb.commit_count).toBe(2); // its own WIP commit + the merge
    expect(syncWithBase(ctx, b.id, { mergeAllowed: true }).status).toBe('up_to_date');
  });

  it('reports conflicts, leaves the worktree clean, and tells the agent on the next start', async () => {
    const { ctx, repo, orch } = setup({ max_parallel: 2 });
    const a = createTask(ctx, { project_slug: 'p', title: 'plain change' });
    const b = createTask(ctx, { project_slug: 'p', title: 'conflicting' });
    orch.start(a.id);
    const { cwd } = ensureWorkspace(ctx, b.id);
    writeFileSync(path.join(cwd, 'README.md'), '# something else entirely\n');
    gitOut(cwd, 'commit', '-qam', 'rewrite readme');
    await orch.wait(a.id);
    approve(ctx, a.id);

    const r = orch.sync(b.id);
    expect(r).toMatchObject({ status: 'conflict', base: 'main', conflicts: ['README.md'] });
    expect(gitOut(cwd, 'status', '--porcelain')).toBe('');
    // Starting tries again, still conflicts, and the prompt tells the agent to merge and resolve.
    const prompt = initialPrompt(ctx, getTask(ctx, b.id), getProject(ctx, 'p'), syncNote(r));
    expect(prompt).toMatch(/^> Your branch is behind main, and merging main into it conflicts in: README.md\. Before anything else, run `git merge main`/);
    orch.start(b.id);
    await orch.wait(b.id);
    expect(listEvents(ctx, b.id).filter((e) => e.type === 'task.sync_conflict')).toHaveLength(2);
  });
});

describe('verify command', { timeout: 30_000 }, () => {
  it('passing checks go to review marked passed', async () => {
    const { ctx, orch } = setup({ verify_command: 'grep -q "hello from brain" README.md' });
    const t = createTask(ctx, { project_slug: 'p', title: 'plain change' });
    orch.start(t.id);
    await orch.wait(t.id);
    expect(getTask(ctx, t.id)).toMatchObject({ status: 'review', verify_status: 'passed' });
  });

  it('failing checks go back to the agent, then to review marked failed', async () => {
    const { ctx, orch } = setup({ verify_command: 'echo "1 test failed"; exit 3' });
    ctx.cfg.maxVerifyFixes = 1;
    const t = createTask(ctx, { project_slug: 'p', title: 'plain change' });
    orch.start(t.id);
    await orch.wait(t.id);
    const after = getTask(ctx, t.id);
    expect(after).toMatchObject({ status: 'review', verify_status: 'failed' });
    expect(after.result_summary).toMatch(/checks still fail after 1 automatic fix attempt/);
    const verifies = listEvents(ctx, t.id).filter((e) => e.type === 'task.verify');
    expect(verifies.map((e) => [e.payload.ok, e.payload.exit_code, e.payload.output])).toEqual([
      [false, 3, '1 test failed'],
      [false, 3, '1 test failed'],
    ]);
    // The fix run resumed the same session with the failure output.
    expect(gitOut(after.worktree!, 'log', '--format=%s', '-2')).toBe('docs: hello\ndocs: hello');
    expect(readFileSync(path.join(after.worktree!, 'README.md'), 'utf8')).toContain('changes requested');
  });
});

describe('milestones, planner and portfolio', { timeout: 30_000 }, () => {
  it('milestones count their work tasks and can be referenced by title', () => {
    const { ctx } = setup();
    const m1 = createMilestone(ctx, 'p', { title: 'Backoffice v1', description: 'Staff can manage customers' });
    const m2 = createMilestone(ctx, 'p', { title: 'SEO' });
    expect(() => createMilestone(ctx, 'p', { title: 'seo' })).toThrow(/already exists/);
    const a = createTask(ctx, { project_slug: 'p', title: 'a', milestone: 'backoffice v1' });
    createTask(ctx, { project_slug: 'p', title: 'b', milestone: m1.id });
    transition(ctx, a.id, 'blocked');
    transition(ctx, a.id, 'todo');
    expect(listMilestones(ctx, 'p').map((m) => [m.title, m.total, m.counts])).toEqual([
      ['Backoffice v1', 2, { inbox: 1, todo: 1 }],
      ['SEO', 0, {}],
    ]);
    updateMilestone(ctx, m2.id, { status: 'done' });
    expect(listMilestones(ctx, 'p', { includeDone: false }).map((m) => m.title)).toEqual(['Backoffice v1']);
    deleteMilestone(ctx, m1.id);
    expect(getTask(ctx, a.id).milestone_id).toBeNull();
    expect(() => createTask(ctx, { project_slug: 'p', title: 'x', milestone: 'nope' })).toThrow(/unknown milestone/);
  });

  it('one planner task at a time; auto_plan queues one when the project runs dry, then waits for the cooldown', () => {
    const { ctx, orch } = setup();
    const plan = createPlanTask(ctx, 'p', { focus: 'customer management' });
    expect(plan).toMatchObject({ kind: 'plan', status: 'todo', priority: 3, title: 'Plan next steps' });
    expect(() => createPlanTask(ctx, 'p')).toThrow(/already has a planner task/);
    expect(needsPlanning(ctx, 'p')).toBe(false);
    ctx.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(plan.id);
    expect(needsPlanning(ctx, 'p')).toBe(false); // cooldown
    expect(needsPlanning(ctx, 'p', Date.now() + ctx.cfg.planCooldownMs + 1)).toBe(true);
    createTask(ctx, { project_slug: 'p', title: 'open work' });
    expect(needsPlanning(ctx, 'p', Date.now() + ctx.cfg.planCooldownMs + 1)).toBe(false);

    const { ctx: c2, orch: o2 } = setup({ auto_plan: true });
    new Scheduler(c2, o2).tick();
    const queued = listTasks(c2, { project: 'p' });
    expect(queued.map((t) => [t.kind, t.status])).toEqual([['plan', 'in_progress']]);
    void orch;
    return o2.waitAll();
  });

  it("the planner prompt carries PROJECT.md, milestones and the board; planner tools write them", async () => {
    const { ctx } = setup();
    createMilestone(ctx, 'p', { title: 'v1' });
    const work = createTask(ctx, { project_slug: 'p', title: 'existing work', milestone: 'v1' });
    const plan = createPlanTask(ctx, 'p', { focus: 'ship v1' });
    const prompt = planPrompt(ctx, getTask(ctx, plan.id), getProject(ctx, 'p'));
    expect(prompt).toContain('ship v1');
    expect(prompt).toContain(`${work.id} [inbox] existing work (milestone: v1)`);
    expect(prompt).toContain('## PROJECT.md (current)');

    const server = buildServer(ctx, { taskId: plan.id, project: 'p' });
    const [x, y] = InMemoryTransport.createLinkedPair();
    await server.connect(x);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(y);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args });
      return { text: r.content.map((c: any) => c.text).join('\n') as string, isError: !!r.isError };
    };
    expect((await call('update_project_doc', { content: '# P\n\n## Goal\n\nShip v1.' })).text).toBe('PROJECT.md updated.');
    expect(readProjectDoc(ctx, 'p')).toBe('# P\n\n## Goal\n\nShip v1.\n');
    expect((await call('create_milestone', { title: 'v2' })).text).toMatch(/^Created milestone m_/);
    expect((await call('create_milestone', { title: 'V2' })).isError).toBe(true);
    const created = await call('create_task', { title: 'next step', milestone: 'v2', priority: 3 });
    expect(created.text).toMatch(/\(inbox\), milestone m_/);
    const next = listTasks(ctx, { project: 'p' }).find((t) => t.title === 'next step')!;
    expect(next.depends_on).toEqual([]); // planner tasks don't make follow-ups wait on themselves
    expect(next.priority).toBe(3);
    expect((await call('update_task', { id: next.id, depends_on: [work.id], milestone: null })).text).toBe(`${next.id} [inbox] next step, depends on ${work.id}`);
    transition(ctx, work.id, 'blocked');
    expect((await call('update_task', { id: work.id, priority: 1 })).text).toBe(`Task ${work.id} is blocked; only inbox and todo tasks can be changed here.`);
    const board = JSON.parse((await call('project_board', {})).text);
    expect(board.milestones.map((m: any) => m.title)).toEqual(['v1', 'v2']);
  });

  it('a milestone whose tasks are all done gets one check; new tasks in it re-arm the check', async () => {
    const { ctx, orch } = setup();
    const m = createMilestone(ctx, 'p', { title: 'v1', description: 'Users can sign up' });
    createMilestone(ctx, 'p', { title: 'empty' });
    const a = createTask(ctx, { project_slug: 'p', title: 'a', milestone: 'v1' });
    const b = createTask(ctx, { project_slug: 'p', title: 'b', milestone: 'v1' });
    ctx.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(a.id);
    expect(milestonesToCheck(ctx, 'p')).toEqual([]);
    ctx.db.prepare("UPDATE tasks SET status = 'done', result_summary = 'Sign-up form added' WHERE id = ?").run(b.id);
    expect(milestonesToCheck(ctx, 'p')).toEqual([m.id]);

    const plan = createPlanTask(ctx, 'p'); // a project planner does not block a milestone check, nor the other way round
    const check = createMilestoneCheck(ctx, m.id);
    expect(check).toMatchObject({ kind: 'plan', status: 'todo', milestone_id: m.id, title: 'Check milestone "v1"' });
    expect(() => createMilestoneCheck(ctx, m.id)).toThrow(/already has a check/);
    expect(milestonesToCheck(ctx, 'p')).toEqual([]);
    expect(listMilestones(ctx, 'p')[0].total).toBe(2); // checks don't count as milestone work

    const prompt = initialPrompt(ctx, getTask(ctx, check.id), getProject(ctx, 'p'));
    expect(prompt).toBe(milestoneCheckPrompt(ctx, getTask(ctx, check.id), getProject(ctx, 'p')));
    expect(prompt).toContain('# Check milestone "v1"');
    expect(prompt).toContain('Users can sign up');
    expect(prompt).toContain(`- ${b.id} [done] b\n  Result: Sign-up form added`);
    expect(prompt).toContain(`${plan.id} [todo, planner]`);

    // Done and nothing new: no second check.
    ctx.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(check.id);
    expect(milestonesToCheck(ctx, 'p')).toEqual([]);
    // The check queued a missing piece; once it is done the milestone is checked again.
    await new Promise((r) => setTimeout(r, 5));
    const c = createTask(ctx, { project_slug: 'p', title: 'missing piece', milestone: 'v1' });
    expect(milestonesToCheck(ctx, 'p')).toEqual([]);
    ctx.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(c.id);
    expect(milestonesToCheck(ctx, 'p')).toEqual([m.id]);
    // Closed milestones are not checked.
    updateMilestone(ctx, m.id, { status: 'done' });
    expect(milestonesToCheck(ctx, 'p')).toEqual([]);
    updateMilestone(ctx, m.id, { status: 'open' });

    // The scheduler queues it (and starts it), for projects without auto_plan too.
    ctx.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(plan.id);
    new Scheduler(ctx, orch).tick();
    const checks = listTasks(ctx, { project: 'p' }).filter((t) => t.kind === 'plan' && t.milestone_id === m.id);
    expect(checks.map((t) => t.status)).toEqual(['in_progress', 'done']);
    await orch.waitAll();

    // close_milestone tool
    const server = buildServer(ctx, { taskId: check.id, project: 'p' });
    const [x, y] = InMemoryTransport.createLinkedPair();
    await server.connect(x);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(y);
    const r: any = await client.callTool({ name: 'close_milestone', arguments: { milestone: 'V1' } });
    expect(r.content[0].text).toBe(`Closed milestone ${m.id}: v1`);
    expect(listMilestones(ctx, 'p')[0].status).toBe('done');
    const bad: any = await client.callTool({ name: 'close_milestone', arguments: { milestone: 'nope' } });
    expect(bad.isError).toBe(true);
  });

  it('portfolio sums work, questions and cost per project', async () => {
    const { ctx, orch } = setup();
    createProject(ctx, { slug: 'q', name: 'Q' });
    updateProject(ctx, 'q', { status: 'archived' });
    const t = createTask(ctx, { project_slug: 'p', title: 'plain change', milestone: undefined });
    orch.start(t.id);
    await orch.wait(t.id);
    const p = portfolio(ctx);
    expect(p.projects.map((r) => r.project.slug)).toEqual(['p']);
    expect(p.projects[0]).toMatchObject({ counts: { review: 1 }, in_review: 1, open_questions: 0, cost_usd: { total: 0, last_7_days: 0 }, runs: { total: 1, last_7_days: 1 } });
    expect(p.totals.in_review).toBe(1);
  });
});
