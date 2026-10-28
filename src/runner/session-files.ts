import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx } from '../core/context.ts';
import { projectMcp } from '../core/projects.ts';
import { selfEntry, shellQuote } from './entry.ts';

/**
 * Per-run temp files handed to `claude`: a merged MCP config (global + project + the brain server)
 * and a settings file registering the brain PreToolUse and PostToolUse hooks.
 */
export function writeSessionFiles(ctx: Ctx, taskId: string, projectSlug: string): { dir: string; mcpConfig: string; settings: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `brain-${taskId}-`));
  const { merged } = projectMcp(ctx, projectSlug);
  const brain = selfEntry('mcp/server');
  const mcp = {
    mcpServers: {
      ...merged.mcpServers,
      brain: {
        type: 'stdio',
        command: brain.command,
        args: brain.args,
        env: { BRAIN_DIR: ctx.cfg.brainDir, BRAIN_TASK_ID: taskId, BRAIN_PROJECT: projectSlug },
      },
    },
  };
  const command = (rel: string) => {
    const e = selfEntry(rel);
    return [e.command, ...e.args].map(shellQuote).join(' ');
  };
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'mcp__brain__ask_human|mcp__brain__wait_for_owner|AskUserQuestion|Bash', hooks: [{ type: 'command', command: command('hooks/pretooluse'), timeout: 30 }] }],
      // Every tool: delivers the owner's messages to the running session.
      PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: command('hooks/posttooluse'), timeout: 30 }] }],
    },
  };
  const mcpConfig = path.join(dir, 'mcp.json');
  const settingsFile = path.join(dir, 'settings.json');
  writeFileSync(mcpConfig, JSON.stringify(mcp, null, 2));
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  return { dir, mcpConfig, settings: settingsFile };
}
