import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChatMessage, getChat, setChatFields } from '../core/composer.ts';
import type { Ctx } from '../core/context.ts';
import { siblingRepos } from '../core/groups.ts';
import { getProject, projectDir } from '../core/projects.ts';
import { badRequest, conflict, type ComposerChat, type ComposerMessage } from '../core/types.ts';
import { buildArgs, spawnClaude, type RunningClaude } from './claude.ts';
import { selfEntry } from './entry.ts';
import { agentEnv } from './env.ts';
import { composerPrompt } from './prompt.ts';

/** Read-only: the composer looks at the code and the web, it never changes anything. */
export const COMPOSER_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
const MAX_TURNS = 40;
const TIMEOUT_MS = 10 * 60_000;

/**
 * Runs task composer chats (docs/08-task-composer.md): each owner message is one `claude -p` turn that
 * resumes the chat's session. The session's only side effects are drafts, through the composer MCP server.
 */
export class Composer {
  ctx: Ctx;
  active = new Map<string, RunningClaude>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    // Turns of a previous server process died with it.
    for (const c of ctx.db.prepare("SELECT id FROM composer_chats WHERE status = 'thinking'").all() as { id: string }[]) {
      setChatFields(ctx, c.id, { status: 'idle' });
      addChatMessage(ctx, c.id, 'error', 'The server restarted while this reply was being written. Send your message again.');
    }
  }

  /** Records the owner's message and starts the reply in the background. */
  send(chatId: string, body: string): { chat: ComposerChat; message: ComposerMessage } {
    const text = body?.trim();
    if (!text) throw badRequest('body is required');
    const chat = getChat(this.ctx, chatId);
    if (chat.status === 'thinking' || this.active.has(chatId)) throw conflict('the composer is still answering the previous message');
    const message = addChatMessage(this.ctx, chatId, 'owner', text);
    const resume = !!chat.session_id;
    const sessionId = chat.session_id ?? randomUUID();
    const updated = setChatFields(this.ctx, chatId, { status: 'thinking', session_id: sessionId, title: chat.title || text.slice(0, 60) });
    try {
      this.launch(updated, text, resume);
    } catch (err) {
      setChatFields(this.ctx, chatId, { status: 'idle' });
      addChatMessage(this.ctx, chatId, 'error', `Could not start the composer: ${(err as Error).message}`);
    }
    return { chat: getChat(this.ctx, chatId), message };
  }

  /** Resolves once the chat's current turn (if any) has been recorded. */
  async wait(chatId: string): Promise<void> {
    while (this.active.has(chatId)) await new Promise((r) => setTimeout(r, 20));
  }

  stop(chatId: string): void {
    this.active.get(chatId)?.kill();
  }

  private launch(chat: ComposerChat, prompt: string, resume: boolean): void {
    const cfg = this.ctx.cfg;
    const project = getProject(this.ctx, chat.project_slug);
    const dir = mkdtempSync(path.join(os.tmpdir(), `brain-${chat.id}-`));
    const mcp = selfEntry('mcp/composer');
    const mcpConfig = path.join(dir, 'mcp.json');
    const settings = path.join(dir, 'settings.json');
    writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { brain: { type: 'stdio', command: mcp.command, args: mcp.args, env: { BRAIN_DIR: cfg.brainDir, BRAIN_COMPOSER_ID: chat.id, BRAIN_PROJECT: project.slug } } } }),
    );
    writeFileSync(settings, '{}');
    const logDir = path.join(cfg.brainDir, 'runs', 'composer');
    mkdirSync(logDir, { recursive: true });
    const args = buildArgs({
      prompt,
      sessionId: chat.session_id!,
      resume,
      mcpConfig,
      settings,
      settingSources: cfg.settingSources,
      tools: COMPOSER_TOOLS,
      allowedTools: ['mcp__brain', 'mcp__brain__*'],
      disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
      appendSystemPrompt: composerPrompt(this.ctx, project),
      maxTurns: MAX_TURNS,
      model: project.model,
      addDirs: siblingRepos(this.ctx, project),
    });
    const proc = spawnClaude({
      bin: cfg.claudeBin,
      args,
      cwd: project.repo_path ?? projectDir(this.ctx, project.slug),
      env: agentEnv(process.env, { BRAIN_DIR: cfg.brainDir, BRAIN_COMPOSER_ID: chat.id, BRAIN_PROJECT: project.slug }),
      logPath: path.join(logDir, `${chat.id}.jsonl`),
      timeoutMs: TIMEOUT_MS,
    });
    this.active.set(chat.id, proc);
    proc.done
      .then((exit) => {
        const o = exit.outcome;
        if (o.ok && o.resultText) addChatMessage(this.ctx, chat.id, 'assistant', o.resultText);
        else if (exit.killed) addChatMessage(this.ctx, chat.id, 'error', 'Stopped.');
        else {
          const why = exit.timedOut ? 'it took longer than 10 minutes' : o.stopReason === 'error_max_turns' ? 'it ran out of turns' : exit.stderr.trim().split('\n').pop() || o.stopReason;
          addChatMessage(this.ctx, chat.id, 'error', `The composer did not finish (${why}).${o.resultText ? `\n\n${o.resultText}` : ''}`);
        }
        // A resumed session that failed before writing anything keeps the old id; a fresh one that never started is dropped.
        const keep = o.sessionId ?? (resume ? chat.session_id : null);
        setChatFields(this.ctx, chat.id, { status: 'idle', session_id: keep, add_cost: o.costUsd ?? 0 });
      })
      .catch((err) => console.error(`[composer] finishing ${chat.id} failed:`, err))
      .finally(() => {
        this.active.delete(chat.id);
        rmSync(dir, { recursive: true, force: true });
      });
  }
}
