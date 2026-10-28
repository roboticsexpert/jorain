/**
 * Brain PostToolUse hook, registered by the per-run settings file for every tool. Hands the owner's new
 * input on this task (messages, resolved actions) to the running session as `additionalContext`, so it
 * reaches the agent at its next step without stopping the run (docs/07-task-thread.md).
 */
import { loadConfig } from '../config.ts';
import { createCtx } from '../core/context.ts';
import { takePending } from '../core/messages.ts';

async function main(): Promise<void> {
  for await (const _ of process.stdin);
  const taskId = process.env.BRAIN_TASK_ID;
  if (!taskId) return;
  try {
    const text = takePending(createCtx(loadConfig()), taskId);
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
  } catch (err) {
    // Nothing is lost: the input stays pending and goes out with the next tool call or the next prompt.
    process.stderr.write(`brain posttooluse hook: ${(err as Error).message}\n`);
  }
}

if (import.meta.main) await main();
