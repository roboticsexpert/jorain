import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createProject } from '../src/core/projects.ts';
import { listQuestions } from '../src/core/questions.ts';
import { listRuns, readRunLog } from '../src/core/runs.ts';
import { createTask, getTask, transition } from '../src/core/tasks.ts';
import { commitsBetween } from '../src/runner/git.ts';
import { Orchestrator } from '../src/runner/orchestrator.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { gitOut, tempCtx, tempRepo } from './helpers.ts';

const fake = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

function setup() {
  const ctx = tempCtx({ BRAIN_CLAUDE_BIN: fake, BRAIN_TICK_MS: '100000' });
  const repo = tempRepo();
  createProject(ctx, { slug: 'selftest', name: 'Self test', repo_path: repo });
  return { ctx, repo, orch: new Orchestrator(ctx) };
}

describe('orchestrator with a fake claude', { timeout: 20_000 }, () => {
  it('auto task: branch, commit, review, repo restored to main', async () => {
    const { ctx, repo, orch } = setup();
    const t = createTask(ctx, { project_slug: 'selftest', title: "Add a line 'hello from brain' to README.md", status: 'todo' });
    new Scheduler(ctx, orch).tick();
    expect(getTask(ctx, t.id).status).toBe('in_progress');
    await orch.wait(t.id);
    const done = getTask(ctx, t.id);
    expect(done.status).toBe('review');
    expect(done.branch).toMatch(new RegExp(`^brain/${t.id}-add-a-line-hello-from-brain`));
    expect(done.result_summary).toBe('Added the line and committed.');
    expect(commitsBetween(repo, done.base_sha!, done.branch!).map((c) => c.message)).toEqual(['docs: hello']);
    expect(gitOut(repo, 'branch', '--show-current')).toBe('main');
    const [run] = listRuns(ctx, t.id);
    expect(run).toMatchObject({ kind: 'start', stop_reason: 'end_turn', exit_code: 0, cost_usd: 0.001 });
    expect(readRunLog(ctx, run.id).lines.length).toBeGreaterThan(2);
  });

  it('question: defer → waiting_for_human → answer → resume → review', async () => {
    const { ctx, repo, orch } = setup();
    const t = createTask(ctx, { project_slug: 'selftest', title: 'ASK me which colour, write it into colour.txt' });
    orch.start(t.id);
    await orch.wait(t.id);
    expect(getTask(ctx, t.id).status).toBe('waiting_for_human');
    const [q] = listQuestions(ctx, { taskId: t.id, open: true });
    expect(q.questions[0]).toMatchObject({ question: 'Which colour should I use?', header: 'Colour', options: [{ label: 'red', description: '' }, { label: 'blue', description: '' }] });
    expect(gitOut(repo, 'branch', '--show-current')).toBe('main');

    orch.answer(q.id, [{ question: q.questions[0].question, answer: 'blue' }]);
    expect(getTask(ctx, t.id).status).toBe('in_progress');
    await orch.wait(t.id);
    const after = getTask(ctx, t.id);
    expect(after.status).toBe('review');
    expect(after.question_count).toBe(1);
    expect(gitOut(repo, 'show', `${after.branch}:colour.txt`)).toBe('blue');
    expect(listRuns(ctx, t.id).map((r) => [r.kind, r.stop_reason])).toEqual([
      ['start', 'tool_deferred'],
      ['resume', 'end_turn'],
    ]);
  });

  it('request changes resumes the same session with the note', async () => {
    const { ctx, repo, orch } = setup();
    const t = createTask(ctx, { project_slug: 'selftest', title: 'plain change' });
    orch.start(t.id);
    await orch.wait(t.id);
    orch.requestChanges(t.id, 'one more line please');
    await orch.wait(t.id);
    const after = getTask(ctx, t.id);
    expect(after.status).toBe('review');
    expect(commitsBetween(repo, after.base_sha!, after.branch!)).toHaveLength(2);
    expect(listRuns(ctx, t.id)[1].session_id).toBe(listRuns(ctx, t.id)[0].session_id);
  });

  it('max turns ends failed with the log kept', async () => {
    const { ctx, orch } = setup();
    const t = createTask(ctx, { project_slug: 'selftest', title: 'MAXTURNS loop forever' });
    orch.start(t.id);
    await orch.wait(t.id);
    const after = getTask(ctx, t.id);
    expect(after.status).toBe('failed');
    const [run] = listRuns(ctx, t.id);
    expect(run.stop_reason).toBe('error_max_turns');
    expect(readFileSync(run.log_path, 'utf8')).toContain('error_max_turns');
  });

  it('git push is denied by the hook', async () => {
    const { ctx, orch } = setup();
    const t = createTask(ctx, { project_slug: 'selftest', title: 'PUSH it' });
    orch.start(t.id);
    await orch.wait(t.id);
    expect(getTask(ctx, t.id).result_summary).toBe('Push was blocked, as expected.');
    expect(readFileSync(listRuns(ctx, t.id)[0].log_path, 'utf8')).toContain('may not push');
  });

  it("ignores the owner's dirty tree, runs one task per project by default, and cancel parks as blocked", async () => {
    const { ctx, repo, orch } = setup();
    const a = createTask(ctx, { project_slug: 'selftest', title: 'a' });
    const b = createTask(ctx, { project_slug: 'selftest', title: 'b' });
    writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    orch.start(a.id);
    expect(getTask(ctx, a.id).worktree).toBe(path.join(ctx.cfg.worktreesDir, 'selftest', a.id));
    expect(() => orch.start(b.id)).toThrow(/already has 1 task in progress/);
    orch.cancel(a.id);
    await orch.wait(a.id);
    expect(getTask(ctx, a.id).status).toBe('blocked');
    expect(listRuns(ctx, a.id)[0].stop_reason).toBe('cancelled');
    expect(readFileSync(path.join(repo, 'dirty.txt'), 'utf8')).toBe('x');
    expect(gitOut(repo, 'branch', '--show-current')).toBe('main');
  });

  it('parks a task as blocked after too many questions', async () => {
    const { ctx, orch } = setup();
    ctx.cfg.maxQuestions = 0;
    const t = createTask(ctx, { project_slug: 'selftest', title: 'ASK forever' });
    orch.start(t.id);
    await orch.wait(t.id);
    expect(getTask(ctx, t.id).status).toBe('blocked');
  });

  it('recover() fails tasks whose run was orphaned', () => {
    const { ctx, orch } = setup();
    const t = createTask(ctx, { project_slug: 'selftest', title: 'orphan' });
    transition(ctx, t.id, 'in_progress');
    ctx.db.prepare("INSERT INTO runs (id, task_id, session_id, kind, started_at, log_path, pid) VALUES ('r_x', ?, 's', 'start', 'now', '/nope', 999999)").run(t.id);
    orch.recover();
    expect(getTask(ctx, t.id).status).toBe('failed');
    expect(listRuns(ctx, t.id)[0].stop_reason).toBe('interrupted');
  });
});
