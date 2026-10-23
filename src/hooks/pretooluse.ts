/**
 * Brain PreToolUse hook, registered by the per-run settings file.
 *
 * - mcp__brain__ask_human (and AskUserQuestion, should the CLI offer it headless): if the owner has
 *   answered this tool_use_id, `allow` with `updatedInput.answers` (the tool returns them to the model);
 *   otherwise `defer`, which makes `claude -p` exit with stop_reason "tool_deferred" so the runner can
 *   park the task as waiting_for_human.
 * - Bash: deny git push as a second line of defence behind --disallowedTools. Agents otherwise have full
 *   permissions; the server pushes after the owner approves (push_policy).
 */
import { loadConfig } from '../config.ts';
import { createCtx } from '../core/context.ts';
import { answersForTool, questionByToolUse } from '../core/questions.ts';
import type { Answer } from '../core/types.ts';

/** Tools that pause the session until the owner answers. */
export const ASK_TOOLS = ['mcp__brain__ask_human', 'AskUserQuestion'];

const FORBIDDEN_GIT = /(^|[\s;&|()`])git(\s+-[^\s]+(\s+[^\s-][^\s]*)?)*\s+push\b/;

export interface HookInput {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
}

type Decision = { permissionDecision: 'allow' | 'deny' | 'defer'; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } | null;

export function decide(input: HookInput, lookup: (toolUseId: string) => Answer[] | null): Decision {
  if (input.tool_name && ASK_TOOLS.includes(input.tool_name)) {
    const answers = input.tool_use_id ? lookup(input.tool_use_id) : null;
    if (answers) {
      // AskUserQuestion takes a { question: answer } map; brain's ask_human takes the list as stored.
      const value = input.tool_name === 'AskUserQuestion' ? answersForTool(answers) : answers;
      return { permissionDecision: 'allow', permissionDecisionReason: 'answered by the owner', updatedInput: { ...(input.tool_input ?? {}), answers: value } };
    }
    return { permissionDecision: 'defer', permissionDecisionReason: 'Waiting for the owner to answer in Second Brain.' };
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
    decision = decide(input, (id) => {
      const q = questionByToolUse(ctx, id);
      return q?.answered_at ? q.answer : null;
    });
  } catch (err) {
    // Fail closed for questions: deferring keeps the task parked instead of letting the model guess.
    decision = input.tool_name && ASK_TOOLS.includes(input.tool_name) ? { permissionDecision: 'defer', permissionDecisionReason: `brain hook error: ${(err as Error).message}` } : null;
  }
  if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } }));
}

if (import.meta.main) await main();
