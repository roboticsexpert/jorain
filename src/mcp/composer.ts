/**
 * MCP server (stdio) for a task composer session (docs/08-task-composer.md), with BRAIN_DIR /
 * BRAIN_COMPOSER_ID / BRAIN_PROJECT in its env. Exposed to the model as mcp__brain__<name>. The session
 * only proposes drafts; the owner creates the tasks from them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../config.ts';
import { addDraft, discardDraft, getChat, getDraft, listDrafts, setChatFields, updateDraft } from '../core/composer.ts';
import { createCtx, type Ctx } from '../core/context.ts';
import { siblings } from '../core/groups.ts';
import { searchKnowledge, type Scope } from '../core/knowledge.ts';
import { listMilestones } from '../core/milestones.ts';
import { findProject } from '../core/projects.ts';
import { listTasks } from '../core/tasks.ts';
import { BrainError } from '../core/types.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const attempt = <T>(fn: () => T, ok: (v: T) => string) => {
  try {
    return text(ok(fn()));
  } catch (err) {
    return fail(err instanceof BrainError ? err.message : (err as Error).message);
  }
};

export function buildComposerServer(ctx: Ctx, env: { chatId: string; project: string }): McpServer {
  const server = new McpServer({ name: 'brain', version: '0.1.0' });
  const group = () => findProject(ctx, env.project)?.group_slug ?? null;
  const reachable = (slug: string) => slug === env.project || siblings(ctx, env.project).some((s) => s.slug === slug);

  const draftFields = {
    body: z.string().optional().describe('Markdown: what to do and why, relevant files or context, and "## Acceptance criteria" as a checklist.'),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe('1 low, 2 normal (default), 3 high.'),
    milestone: z.string().optional().describe("Id or exact title of one of the project's milestones."),
    depends_on: z.array(z.string()).optional().describe('Ids of existing tasks (t_...) or of drafts in this chat (d_...) that must be done first.'),
  };

  server.registerTool(
    'propose_task',
    {
      description:
        'Propose one task to the owner. It shows as a draft card next to the chat; the owner edits it and decides whether to create it. Each task should fit one agent session (well under 30 minutes of work) and be understandable on its own by an agent that has not seen this chat.',
      inputSchema: { title: z.string().min(1), ...draftFields },
    },
    async (input) => attempt(() => addDraft(ctx, env.chatId, input), (d) => `Draft ${d.id} proposed: ${d.title}`),
  );

  server.registerTool(
    'revise_draft',
    {
      description: 'Change one of your open drafts when the owner asks (only the fields you pass change; depends_on replaces the list).',
      inputSchema: { draft_id: z.string(), title: z.string().optional(), ...draftFields },
    },
    async ({ draft_id, ...patch }) =>
      attempt(() => {
        if (getDraft(ctx, draft_id).chat_id !== env.chatId) throw new BrainError(404, 'not_found', `draft ${draft_id} is not in this chat`);
        return updateDraft(ctx, draft_id, patch);
      }, (d) => `Draft ${d.id} updated: ${d.title}`),
  );

  server.registerTool(
    'discard_draft',
    { description: 'Withdraw one of your open drafts (e.g. it was merged into another or the owner does not want it).', inputSchema: { draft_id: z.string() } },
    async ({ draft_id }) =>
      attempt(() => {
        if (getDraft(ctx, draft_id).chat_id !== env.chatId) throw new BrainError(404, 'not_found', `draft ${draft_id} is not in this chat`);
        return discardDraft(ctx, draft_id);
      }, (d) => `Draft ${d.id} discarded.`),
  );

  server.registerTool(
    'list_drafts',
    { description: "The drafts of this chat with their current state. The owner may have edited them, created them (they are tasks now) or discarded them.", inputSchema: {} },
    async () => {
      const list = listDrafts(ctx, env.chatId);
      return text(list.length ? JSON.stringify(list.map(({ chat_id, created_at, updated_at, ...d }) => d), null, 2) : 'No drafts yet.');
    },
  );

  server.registerTool(
    'set_chat_title',
    { description: 'Give this chat a short title (3-6 words) once its topic is clear.', inputSchema: { title: z.string().min(1).max(80) } },
    async ({ title }) => attempt(() => setChatFields(ctx, getChat(ctx, env.chatId).id, { title }), () => 'Title set.'),
  );

  server.registerTool(
    'project_board',
    {
      description: "A project's milestones (with progress) and its tasks: id, status, title, milestone and dependencies. Use it to avoid duplicates and to pick dependencies. project defaults to the current one; another project of the same group can be given.",
      inputSchema: { include_done: z.boolean().optional(), project: z.string().optional() },
    },
    async ({ include_done, project }) => {
      const slug = project ?? env.project;
      if (!reachable(slug)) return fail(`Project ${slug} is not part of this project's group.`);
      const tasks = listTasks(ctx, { project: slug });
      const done = tasks.filter((t) => t.status === 'done');
      const shown = [...tasks.filter((t) => t.status !== 'done'), ...(include_done ? done : done.slice(0, 20))];
      return text(
        JSON.stringify(
          {
            milestones: listMilestones(ctx, slug).map((m) => ({ id: m.id, title: m.title, status: m.status, done: m.done, total: m.total, due: m.due, description: m.description })),
            tasks: shown.map((t) => ({ id: t.id, status: t.status, title: t.title, milestone_id: t.milestone_id, depends_on: t.depends_on })),
          },
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    'search_knowledge',
    {
      description: "Full-text search over the owner's knowledge base (Markdown notes) for this project, its group and global notes. Read a hit with the Read tool at the file path given.",
      inputSchema: { query: z.string().min(1) },
    },
    async ({ query }) => {
      const g = group();
      const scopes: Scope[] = g ? ['global', `group:${g}`, `project:${env.project}`] : ['global', `project:${env.project}`];
      const hits = searchKnowledge(ctx, query, scopes);
      if (!hits.length) return text(`No notes match "${query}".`);
      return text(hits.map((h) => `## ${h.title}\npath: ${h.path} (${h.scope})\nfile: ${ctx.cfg.brainDir}/${h.path}\n${h.snippet}`).join('\n\n'));
    },
  );

  return server;
}

if (import.meta.main) {
  const ctx = createCtx(loadConfig());
  const server = buildComposerServer(ctx, { chatId: process.env.BRAIN_COMPOSER_ID!, project: process.env.BRAIN_PROJECT! });
  await server.connect(new StdioServerTransport());
}
