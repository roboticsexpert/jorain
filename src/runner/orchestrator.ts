import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import type { Ctx } from '../core/context.ts';
import { publish, recordEvent } from '../core/events.ts';
import { getProject } from '../core/projects.ts';
import { addOwnerMessage, pendingForAgent, resolveAction, takePending, waitSatisfied } from '../core/messages.ts';
import { answerQuestion, createQuestion, getQuestion, isRecordedByTool, listQuestions } from '../core/questions.ts';
import { ASK_TOOLS, WAIT_TOOL } from '../hooks/pretooluse.ts';
import { createRun, endRun, openRuns, setRunPid } from '../core/runs.ts';
import { getTask, listTasks, setTaskFields, setWaitingFor, STARTABLE, transition, type TaskRow } from '../core/tasks.ts';
import { BrainError, conflict, type ActionStatus, type Answer, type Project, type Question, type Run, type TaskMessage } from '../core/types.ts';
import { buildArgs, spawnClaude, type ClaudeExit, type RunningClaude } from './claude.ts';
import { agentEnv } from './env.ts';
import { siblingRepos } from '../core/groups.ts';
import * as git from './git.ts';
import { builtinTools, DEFAULT_ALLOWED_TOOLS, DISALLOWED_TOOLS, initialPrompt, systemPrompt } from './prompt.ts';
import { writeSessionFiles } from './session-files.ts';
import { ensureWorkspace, syncNote, syncWithBase, workDir, type SyncResult } from './workspace.ts';

interface Active {
  run: Run;
  proc: RunningClaude;
  done: Promise<void>;
}

/** What to do once a run has been cleaned up (e.g. hand failed checks back to the same session). */
type FollowUp = (() => void) | undefined;

/** Owns the Claude sessions started by this process. The server and `brain run` each have one. */
export class Orchestrator {
  ctx: Ctx;
  active = new Map<string, Active>();
  /** Failed verifications handed back to the agent in a row, per task. */
  private fixAttempts = new Map<string, number>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  /** Number of sessions running anywhere (this process, other processes sharing the DB). */
  runningCount(): number {
    return openRuns(this.ctx).length;
  }

  /** Tasks in progress per project. */
  projectLoad(): Map<string, number> {
    const load = new Map<string, number>();
    for (const t of listTasks(this.ctx, { status: ['in_progress'] })) load.set(t.project_slug, (load.get(t.project_slug) ?? 0) + 1);
    return load;
  }

  /** Projects running as many tasks as their max_parallel allows. */
  busyProjects(): Set<string> {
    const busy = new Set<string>();
    for (const [slug, n] of this.projectLoad()) if (n >= getProject(this.ctx, slug).max_parallel) busy.add(slug);
    return busy;
  }

  private checkCapacity(project: Project): void {
    const n = this.projectLoad().get(project.slug) ?? 0;
    if (n >= project.max_parallel) {
      throw conflict(`project ${project.slug} already has ${n} task${n === 1 ? '' : 's'} in progress (max_parallel ${project.max_parallel})`);
    }
  }

  /** Starts a fresh session for a task (inbox/todo/blocked/failed). Resolves once the run is launched. */
  start(taskId: string): TaskRow {
    const task = getTask(this.ctx, taskId);
    if (!STARTABLE.includes(task.status)) throw conflict(`task ${taskId} is ${task.status}; it can be started from ${STARTABLE.join(', ')}`);
    const project = getProject(this.ctx, task.project_slug);
    this.checkCapacity(project);
    if (task.waiting_on.length)
      throw conflict(`task ${taskId} waits on ${task.waiting_on.join(', ')} (not done and merged yet); approve and merge those first, or remove them from depends_on`);
    ensureWorkspace(this.ctx, taskId);
    const note = syncNote(this.trySync(taskId, true));
    const sessionId = randomUUID();
    setTaskFields(this.ctx, task.id, { session_id: sessionId, result_summary: null, verify_status: null });
    setWaitingFor(this.ctx, task.id, null);
    this.fixAttempts.delete(taskId);
    const t = transition(this.ctx, task.id, 'in_progress', { action: 'start' });
    let prompt = initialPrompt(this.ctx, t, project, note);
    const pending = takePending(this.ctx, t.id);
    if (pending) prompt += `\n\n## New from the owner\n\n${pending}`;
    this.launch(t, project, { kind: 'start', prompt, resume: false });
    return getTask(this.ctx, task.id);
  }

  /** Continues the task's session: after an answer (no prompt) or with a review note (prompt). */
  resume(taskId: string, prompt?: string, action = 'resume'): TaskRow {
    const task = getTask(this.ctx, taskId);
    if (!task.session_id) throw conflict(`task ${taskId} has no session to resume`);
    if (task.status !== 'waiting_for_human' && task.status !== 'review') throw conflict(`task ${taskId} is ${task.status}; only waiting_for_human or review tasks resume`);
    if (this.active.has(taskId)) throw conflict(`task ${taskId} is already running`);
    const project = getProject(this.ctx, task.project_slug);
    this.checkCapacity(project);
    ensureWorkspace(this.ctx, taskId);
    // A session paused on a question only gets fast-forwards; one coming back from review may get the base merged in.
    const note = syncNote(this.trySync(taskId, prompt !== undefined));
    if (note && prompt !== undefined) prompt = `${note}\n\n${prompt}`;
    // With a prompt, pending owner input rides along; without one, the PostToolUse hook delivers it after the paused tool call.
    if (prompt !== undefined) {
      const pending = takePending(this.ctx, taskId);
      if (pending) prompt += `\n\n${pending}`;
    }
    setWaitingFor(this.ctx, taskId, null);
    this.fixAttempts.delete(taskId);
    const t = transition(this.ctx, task.id, 'in_progress', { action });
    this.launch(t, project, { kind: 'resume', prompt, resume: true });
    return getTask(this.ctx, task.id);
  }

  /**
   * Resumes a waiting task whose questions are all answered. A hook-paused question resumes with no
   * prompt (the pending tool call re-runs and the hook supplies the answer); a question the ask_human
   * tool recorded itself resumes with the answer as the prompt.
   */
  resumeAfterAnswer(taskId: string): TaskRow {
    const last = listQuestions(this.ctx, { taskId })[0];
    if (!last?.answer) throw conflict(`task ${taskId} has no answered question`);
    const prompt = isRecordedByTool(last)
      ? `The owner answered your question:\n${last.answer.map((a) => `- ${a.question}\n  → ${a.answer}`).join('\n')}\n\nContinue the task.`
      : undefined;
    return this.resume(taskId, prompt, 'answer');
  }

  /**
   * Resumes a task parked on wait_for_owner. A hook-paused wait resumes with no prompt (the tool call
   * re-runs, the hook allows it and the tool returns the owner's input); a wait the tool recorded itself
   * resumes with the input as the prompt.
   */
  resumeAfterWait(taskId: string): TaskRow {
    const task = getTask(this.ctx, taskId);
    if (!task.waiting_for) throw conflict(`task ${taskId} is not waiting for the owner`);
    if (!waitSatisfied(this.ctx, task)) throw conflict(`task ${taskId} still waits for ${task.waiting_for.action_id ?? 'a message from the owner'}`);
    const prompt = task.waiting_for.tool_use_id.startsWith('mcp_') ? 'You were waiting for the owner. Continue the task with their input below.' : undefined;
    return this.resume(taskId, prompt, 'owner_input');
  }

  /**
   * An owner message on the task's thread. Running: the PostToolUse hook hands it over at the agent's
   * next tool call (or the run continues with it if it ends first). Waiting on wait_for_owner: resumes.
   * In review: resumes the session with the message, like a review note. Otherwise it waits for the next
   * start or resume.
   */
  message(taskId: string, body: string): { message: TaskMessage; task: TaskRow } {
    const message = addOwnerMessage(this.ctx, taskId, body);
    const task = getTask(this.ctx, taskId);
    if (task.status === 'review') {
      this.resume(
        taskId,
        'The owner looked at your work and wrote to you. If they ask for changes, make them and commit them on the same branch; if they ask a question, answer it. End with a short summary.',
        'owner_message',
      );
    } else this.wakeIfWaiting(task);
    return { message, task: getTask(this.ctx, taskId) };
  }

  /** The owner resolves one of the agent's actions; a task waiting for it resumes. */
  resolveAction(id: string, status: ActionStatus, note?: string | null): { message: TaskMessage; task: TaskRow } {
    const message = resolveAction(this.ctx, id, status, note);
    this.wakeIfWaiting(getTask(this.ctx, message.task_id));
    return { message, task: getTask(this.ctx, message.task_id) };
  }

  private wakeIfWaiting(task: TaskRow): void {
    if (!waitSatisfied(this.ctx, task)) return;
    try {
      this.resumeAfterWait(task.id);
    } catch (err) {
      // e.g. the project is at capacity: the scheduler retries on its next tick.
      if (!(err instanceof BrainError)) throw err;
      console.warn(`[brain] owner input stored for ${task.id}, resume deferred: ${err.message}`);
    }
  }

  requestChanges(taskId: string, note: string): TaskRow {
    const task = getTask(this.ctx, taskId);
    if (task.status !== 'review') throw conflict(`task ${taskId} is ${task.status}, not review`);
    recordEvent(this.ctx, taskId, 'task.changes_requested', { note });
    return this.resume(taskId, `The owner reviewed your work and requests changes:\n\n${note}\n\nMake the changes, commit them on the same branch, and end with a short summary.`, 'request_changes');
  }

  /**
   * Brings a task branch up to date with its base, on the owner's request (`POST /tasks/:id/sync`).
   * Not while a session is running in it.
   */
  sync(taskId: string): SyncResult {
    const task = getTask(this.ctx, taskId);
    if (task.status === 'in_progress') throw conflict(`task ${taskId} is running; sync it when the session has stopped`);
    if (task.status === 'done') throw conflict(`task ${taskId} is done`);
    if (!task.branch) throw conflict(`task ${taskId} has no branch yet; starting it creates one from the current base`);
    ensureWorkspace(this.ctx, taskId);
    return syncWithBase(this.ctx, taskId, { mergeAllowed: true });
  }

  private trySync(taskId: string, mergeAllowed: boolean): SyncResult {
    try {
      return syncWithBase(this.ctx, taskId, { mergeAllowed });
    } catch (err) {
      console.error(`[brain] could not sync ${taskId} with its base:`, (err as Error).message);
      return { status: 'skipped', base: getTask(this.ctx, taskId).base_branch ?? '', reason: (err as Error).message };
    }
  }

  /** Stores the owner's answer and resumes the session once the task has no open question left. */
  answer(questionId: string, answers: Answer[]): Question {
    const q = answerQuestion(this.ctx, questionId, answers);
    const task = getTask(this.ctx, q.task_id);
    const open = listQuestions(this.ctx, { taskId: task.id, open: true });
    if (task.status === 'waiting_for_human' && !open.length && !task.waiting_for) {
      try {
        this.resumeAfterAnswer(task.id);
      } catch (err) {
        // e.g. the project is at capacity: the scheduler retries on its next tick.
        if (!(err instanceof BrainError)) throw err;
        console.warn(`[brain] answer stored for ${task.id}, resume deferred: ${err.message}`);
      }
    }
    return getQuestion(this.ctx, questionId);
  }

  /** Kills a running session (if any) and parks the task as blocked. */
  cancel(taskId: string): TaskRow {
    const task = getTask(this.ctx, taskId);
    if (task.status === 'done') throw conflict(`task ${taskId} is done`);
    const a = this.active.get(taskId);
    if (a) a.proc.kill();
    else if (task.status === 'in_progress') {
      // Running in another process (e.g. a foreground `brain run`): its run row is closed when that process sees the exit.
      const other = openRuns(this.ctx).find((r) => r.task_id === taskId);
      if (other?.pid && other.pid !== process.pid) {
        try {
          process.kill(other.pid, 'SIGTERM');
        } catch {}
      }
    }
    this.fixAttempts.delete(taskId);
    if (task.waiting_for) setWaitingFor(this.ctx, taskId, null);
    if (task.status === 'blocked') return task;
    return transition(this.ctx, taskId, 'blocked', { action: 'cancel' });
  }

  /** Waits until a task has no session running here, including follow-up runs (used by the foreground CLI). */
  async wait(taskId: string): Promise<void> {
    let a: Active | undefined;
    while ((a = this.active.get(taskId))) await a.done;
  }

  async waitAll(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()].map((a) => a.done));
  }

  private launch(task: TaskRow, project: Project, o: { kind: Run['kind']; prompt?: string; resume: boolean }): void {
    const cfg = this.ctx.cfg;
    const files = writeSessionFiles(this.ctx, task.id, project.slug);
    const run = createRun(this.ctx, task.id, task.session_id!, o.kind);
    setRunPid(this.ctx, run.id, process.pid);
    const args = buildArgs({
      prompt: o.prompt,
      sessionId: task.session_id!,
      resume: o.resume,
      mcpConfig: files.mcpConfig,
      settings: files.settings,
      settingSources: cfg.settingSources,
      tools: builtinTools(project.allowed_tools),
      allowedTools: [...new Set([...DEFAULT_ALLOWED_TOOLS, ...project.allowed_tools])],
      disallowedTools: DISALLOWED_TOOLS,
      appendSystemPrompt: systemPrompt(this.ctx, task, project),
      maxTurns: cfg.maxTurns,
      model: project.model,
      addDirs: siblingRepos(this.ctx, project),
    });
    const cwd = workDir(this.ctx, task, project);
    const proc = spawnClaude({
      bin: cfg.claudeBin,
      args,
      cwd,
      env: agentEnv(process.env, { BRAIN_DIR: cfg.brainDir, BRAIN_TASK_ID: task.id, BRAIN_PROJECT: project.slug, ...(project.repo_path ? { BRAIN_REPO: project.repo_path } : {}) }),
      logPath: run.log_path,
      timeoutMs: cfg.runTimeoutMs,
      onLine: (line, index) => publish('run.log', { run_id: run.id, index, line }),
    });
    const done = proc.done
      .then((exit) => this.finish(task.id, project, run, exit, cwd))
      .catch((err): FollowUp => {
        console.error(`[brain] finishing run ${run.id} failed:`, err);
        return undefined;
      })
      .then((next) => {
        if (this.active.get(task.id)?.run.id === run.id) this.active.delete(task.id);
        rmSync(files.dir, { recursive: true, force: true });
        try {
          next?.();
        } catch (err) {
          console.error(`[brain] follow-up run of ${task.id} could not start:`, err);
          this.fail(task.id, `Could not hand the failed checks back to the agent: ${(err as Error).message}`, { run_id: run.id });
        }
      });
    this.active.set(task.id, { run, proc, done });
  }

  private async finish(taskId: string, project: Project, run: Run, exit: ClaudeExit, cwd: string): Promise<FollowUp> {
    const o = exit.outcome;
    const stopReason = exit.killed ? 'cancelled' : exit.timedOut ? 'timeout' : o.stopReason;
    endRun(this.ctx, run.id, { exit_code: exit.exitCode, stop_reason: stopReason, usage: o.usage, cost_usd: o.costUsd });
    const info = { run_id: run.id, stop_reason: stopReason };
    this.commitLeftovers(taskId, project, run.id, cwd);
    const task = getTask(this.ctx, taskId);
    if (task.status !== 'in_progress') return;

    if (exit.killed) {
      transition(this.ctx, taskId, 'blocked', { ...info, action: 'cancel' });
    } else if (exit.timedOut) {
      this.fail(taskId, `Run timed out after ${Math.round(this.ctx.cfg.runTimeoutMs / 60000)} min.`, info);
    } else if (o.deferred && ASK_TOOLS.includes(o.deferred.name)) {
      const asked = listQuestions(this.ctx, { taskId }).length;
      if (asked >= this.ctx.cfg.maxQuestions) this.tooManyQuestions(taskId, info);
      else {
        createQuestion(this.ctx, taskId, o.deferred.id, o.deferred.input);
        transition(this.ctx, taskId, 'waiting_for_human', { ...info, via: 'hook_defer' });
      }
    } else if (o.deferred && o.deferred.name === WAIT_TOOL) {
      const input = (o.deferred.input ?? {}) as { action_id?: unknown; reason?: unknown };
      const actionId = typeof input.action_id === 'string' ? input.action_id : null;
      setWaitingFor(this.ctx, taskId, { tool_use_id: o.deferred.id, action_id: actionId, since: new Date().toISOString() });
      transition(this.ctx, taskId, 'waiting_for_human', { ...info, via: 'wait_for_owner', action_id: actionId, reason: typeof input.reason === 'string' ? input.reason : undefined });
      // The owner may have answered while the run was shutting down.
      return () => this.wakeIfWaiting(getTask(this.ctx, taskId));
    } else if (o.deferred) {
      this.fail(taskId, `The session paused on an unexpected tool (${o.deferred.name}).`, info);
    } else if (o.ok && exit.exitCode === 0) {
      const recorded = listQuestions(this.ctx, { taskId, open: true }).filter(isRecordedByTool);
      if (recorded.length) {
        if (listQuestions(this.ctx, { taskId }).length > this.ctx.cfg.maxQuestions) this.tooManyQuestions(taskId, info);
        else transition(this.ctx, taskId, 'waiting_for_human', { ...info, via: 'ask_human_tool' });
        return;
      }
      if (task.waiting_for) {
        transition(this.ctx, taskId, 'waiting_for_human', { ...info, via: 'wait_for_owner_tool', action_id: task.waiting_for.action_id });
        return () => this.wakeIfWaiting(getTask(this.ctx, taskId));
      }
      if (pendingForAgent(this.ctx, taskId).length) {
        // The owner wrote after the agent's last tool call: hand it over before the task goes to review.
        recordEvent(this.ctx, taskId, 'task.owner_input_continue', { run_id: run.id });
        return () => this.continueSession(taskId, project, takePending(this.ctx, taskId) ?? 'Continue the task.', false);
      }
      return this.verifyThenReview(taskId, project, cwd, o.resultText ?? '(no summary)', info);
    } else {
      const tail = exit.stderr.trim().split('\n').slice(-5).join('\n');
      const why = stopReason === 'error_max_turns' ? `Stopped after the maximum of ${this.ctx.cfg.maxTurns} turns.` : `Run ended with ${stopReason} (exit code ${exit.exitCode}).`;
      this.fail(taskId, [why, o.resultText, tail && `stderr: ${tail}`].filter(Boolean).join('\n\n'), info);
    }
  }

  /**
   * Runs the project's verify_command in the task's worktree. Passing → review. Failing → the output goes
   * back to the same session (up to maxVerifyFixes times in a row), then to review marked as failed.
   */
  private async verifyThenReview(taskId: string, project: Project, cwd: string, summary: string, info: Record<string, unknown>): Promise<FollowUp> {
    const task = getTask(this.ctx, taskId);
    if (project.verify_command && task.kind === 'work') {
      const v = await runVerify(project.verify_command, cwd, this.ctx.cfg.verifyTimeoutMs, project.repo_path);
      recordEvent(this.ctx, taskId, 'task.verify', { ok: v.ok, command: project.verify_command, exit_code: v.code, output: v.output });
      setTaskFields(this.ctx, taskId, { verify_status: v.ok ? 'passed' : 'failed' });
      if (getTask(this.ctx, taskId).status !== 'in_progress') return; // cancelled while the checks ran
      if (!v.ok) {
        const n = this.fixAttempts.get(taskId) ?? 0;
        if (n < this.ctx.cfg.maxVerifyFixes) {
          this.fixAttempts.set(taskId, n + 1);
          const prompt = [
            `Second Brain ran the project's checks after you finished, and they failed (exit code ${v.code}):`,
            '',
            '```',
            `$ ${project.verify_command}`,
            v.output,
            '```',
            '',
            'Fix the cause (not the checks), run the command again until it passes, commit, and end with a short summary.',
          ].join('\n');
          return () => this.continueSession(taskId, project, prompt);
        }
        summary = `${summary}\n\n⚠️ The project checks still fail after ${n} automatic fix attempt${n === 1 ? '' : 's'} (\`${project.verify_command}\`, exit code ${v.code}). See the task's verify output.`;
      }
      this.fixAttempts.delete(taskId);
    }
    setTaskFields(this.ctx, taskId, { result_summary: summary });
    transition(this.ctx, taskId, 'review', info);
  }

  /** Another run of the same session while the task stays in progress (failed checks, late owner input). */
  private continueSession(taskId: string, project: Project, prompt: string, verifyFix = true): void {
    const t = getTask(this.ctx, taskId);
    if (t.status !== 'in_progress') return;
    if (verifyFix) recordEvent(this.ctx, taskId, 'task.verify_fix', { attempt: this.fixAttempts.get(taskId) ?? 1 });
    this.launch(t, project, { kind: 'resume', prompt, resume: true });
  }

  /**
   * Commits whatever the agent left uncommitted on its branch (so nothing is lost when the worktree is
   * removed and the squash merge sees everything), then refreshes the task's commit count.
   */
  private commitLeftovers(taskId: string, project: Project, runId: string, cwd: string): void {
    const t = getTask(this.ctx, taskId);
    if (!project.repo_path || !t.branch || !t.base_sha) return;
    try {
      if (git.currentBranch(cwd) === t.branch && git.isDirty(cwd)) {
        git.commitAll(cwd, `WIP: changes the agent left uncommitted\n\nTask: ${t.id}\nRun: ${runId}\n`);
        recordEvent(this.ctx, taskId, 'task.autocommit', { run_id: runId, sha: git.headSha(cwd) });
      }
    } catch (err) {
      console.error(`[brain] could not commit leftovers of ${taskId}:`, (err as Error).message);
    }
    setTaskFields(this.ctx, taskId, { commit_count: git.commitCount(project.repo_path, t.base_sha, t.branch) });
  }

  private tooManyQuestions(taskId: string, info: Record<string, unknown>): void {
    setTaskFields(this.ctx, taskId, { result_summary: `Parked: the agent wanted to ask more than ${this.ctx.cfg.maxQuestions} questions.` });
    transition(this.ctx, taskId, 'blocked', { ...info, reason: 'too_many_questions' });
  }

  private fail(taskId: string, summary: string, info: Record<string, unknown>): void {
    setTaskFields(this.ctx, taskId, { result_summary: summary });
    transition(this.ctx, taskId, 'failed', info);
  }

  /**
   * Startup cleanup: runs whose owning process is gone are closed as `interrupted`, and their tasks
   * (still in_progress) are marked failed.
   */
  recover(): void {
    for (const r of openRuns(this.ctx)) {
      if (r.pid && r.pid !== process.pid && alive(r.pid)) continue;
      if (this.active.has(r.task_id)) continue;
      endRun(this.ctx, r.id, { exit_code: null, stop_reason: 'interrupted' });
    }
    const running = new Set(openRuns(this.ctx).map((r) => r.task_id));
    for (const t of listTasks(this.ctx, { status: ['in_progress'] })) {
      if (running.has(t.id)) continue;
      this.fail(t.id, 'The run was interrupted (the process running it stopped). Start the task again.', { reason: 'interrupted' });
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runs a project's verify command through the shell; keeps the last 6000 characters of its output. */
function runVerify(command: string, cwd: string, timeoutMs: number, repo: string | null): Promise<{ ok: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', `${command} 2>&1`],
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: agentEnv(process.env, { CI: '1', ...(repo ? { BRAIN_REPO: repo } : {}) }) },
      (err, stdout) => {
        const output = String(stdout ?? '').slice(-6000).trim();
        if (!err) return resolve({ ok: true, code: 0, output });
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        resolve({ ok: false, code: typeof e.code === 'number' ? e.code : null, output: e.killed ? `${output}\n(timed out after ${Math.round(timeoutMs / 60000)} min)` : output || e.message });
      },
    );
  });
}
