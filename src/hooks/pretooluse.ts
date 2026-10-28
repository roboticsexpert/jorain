/**
 * Brain PreToolUse hook, registered by the per-run settings file.
 *
 * - mcp__brain__ask_human (and AskUserQuestion, should the CLI offer it headless): if the owner has
 *   answered this tool_use_id, `allow` with `updatedInput.answers` (the tool returns them to the model);
 *   otherwise `defer`, which makes `claude -p` exit with stop_reason "tool_deferred" so the runner can
 *   park the task as waiting_for_human.
 * - mcp__brain__wait_for_owner: `allow` once the owner has given what the agent waits for (the action is
 *   resolved, or there is new owner input), otherwise `defer` so the task parks like a question.
 * - Bash: deny git push as a second line of defence behind --disallowedTools. Agents otherwise have full
 *   permissions; the server pushes after the owner approves (push_policy).
 * - Edit / Write / NotebookEdit: deny files inside a sibling project's repo (same group). Agents read the
 *   other parts of the product but change them only through tasks in those projects.
 */
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { createCtx } from '../core/context.ts';
import { siblingRepos } from '../core/groups.ts';
import { waitReady } from '../core/messages.ts';
import { answersForTool, questionByToolUse } from '../core/questions.ts';
import { findTask } from '../core/tasks.ts';
import type { Answer } from '../core/types.ts';

/** Tools that pause the session until the owner answers. */
export const ASK_TOOLS = ['mcp__brain__ask_human', 'AskUserQuestion'];
/** Pauses the session until the owner resolves an action or writes (docs/07-task-thread.md). */
export const WAIT_TOOL = 'mcp__brain__wait_for_owner';
/** Tools that write files; denied inside read-only (sibling) repos. */
export const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

const FORBIDDEN_GIT = /(^|[\s;&|()`])git(\s+-[^\s]+(\s+[^\s-][^\s]*)?)*\s+push\b/;

export interface HookInput {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

type Decision = { permissionDecision: 'allow' | 'deny' | 'defer'; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } | null;

const inside = (file: string, dir: string) => {
  const rel = path.relative(path.resolve(dir), file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export function decide(
  input: HookInput,
  lookup: (toolUseId: string) => Answer[] | null,
  ready: (actionId: string | null) => boolean = () => false,
  readOnlyDirs: () => string[] = () => [],
): Decision {
  if (input.tool_name === WAIT_TOOL) {
    const actionId = typeof input.tool_input?.action_id === 'string' ? input.tool_input.action_id : null;
    return ready(actionId)
      ? { permissionDecision: 'allow', permissionDecisionReason: 'the owner has replied' }
      : { permissionDecision: 'defer', permissionDecisionReason: 'Waiting for the owner in Second Brain.' };
  }
  if (input.tool_name && ASK_TOOLS.includes(input.tool_name)) {
    const answers = input.tool_use_id ? lookup(input.tool_use_id) : null;
    if (answers) {
      // AskUserQuestion takes a { question: answer } map; brain's ask_human takes the list as stored.
      const value = input.tool_name === 'AskUserQuestion' ? answersForTool(answers) : answers;
      return { permissionDecision: 'allow', permissionDecisionReason: 'answered by the owner', updatedInput: { ...(input.tool_input ?? {}), answers: value } };
    }
    return { permissionDecision: 'defer', permissionDecisionReason: 'Waiting for the owner to answer in Second Brain.' };
  }
  if (input.tool_name && WRITE_TOOLS.includes(input.tool_name)) {
    const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (typeof raw !== 'string' || !raw) return null;
    const file = path.resolve(input.cwd ?? process.cwd(), raw);
    // A sibling that contains the session's own working directory is not read-only for it.
    const dir = readOnlyDirs().find((d) => inside(file, d) && !(input.cwd && inside(path.resolve(input.cwd), d)));
    if (dir) {
      return {
        permissionDecision: 'deny',
        permissionDecisionReason: `${dir} belongs to another project of this product and is read-only here. Create a task in that project with mcp__brain__create_task({ project, ... }) instead.`,
      };
    }
    return null;
  }
  if (input.tool_name === 'Bash') {
    const cmd = String(input.tool_input?.command ?? '');
    if (FORBIDDEN_GIT.test(cmd)) {
      return { permissionDecision: 'deny', permissionDecisionReason: 'Second Brain agents may not push. Commit on the task branch; Second Brain merges and pushes after the owner approves.' };
    }
  }
  return null;
}

async function main(): Promise<void> {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const input = JSON.parse(raw) as HookInput;
  let decision: Decision;
  try {
    const ctx = createCtx(loadConfig());
    const taskId = process.env.BRAIN_TASK_ID;
    decision = decide(
      input,
      (id) => {
        const q = questionByToolUse(ctx, id);
        return q?.answered_at ? q.answer : null;
      },
      (actionId) => !!taskId && waitReady(ctx, taskId, actionId),
      () => {
        const task = taskId ? findTask(ctx, taskId) : undefined;
        return task ? siblingRepos(ctx, task.project_slug) : [];
      },
    );
  } catch (err) {
    // Fail closed for questions: deferring keeps the task parked instead of letting the model guess.
    decision = input.tool_name && [...ASK_TOOLS, WAIT_TOOL].includes(input.tool_name) ? { permissionDecision: 'defer', permissionDecisionReason: `brain hook error: ${(err as Error).message}` } : null;
  }
  if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } }));
}

if (import.meta.main) await main();
