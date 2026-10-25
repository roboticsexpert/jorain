/**
 * Brain MCP server (stdio). Each agent session gets one, with BRAIN_DIR / BRAIN_TASK_ID / BRAIN_PROJECT
 * in its env. Tools are exposed to the model as mcp__brain__<name>.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../config.ts';
import { createCtx, type Ctx } from '../core/context.ts';
import { saveNote, searchKnowledge, type Scope } from '../core/knowledge.ts';
import { createMilestone, listMilestones } from '../core/milestones.ts';
import { findProject, writeProjectDoc } from '../core/projects.ts';
import { createQuestion, listQuestions } from '../core/questions.ts';
import { newId } from '../db/client.ts';
import { createTask, findTask, listTasks, toPublicTask, updateTask } from '../core/tasks.ts';
import { BrainError } from '../core/types.ts';
import { listEvents } from '../core/events.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export function buildServer(ctx: Ctx, env: { taskId?: string; project?: string }): McpServer {
  const server = new McpServer({ name: 'brain', version: '0.1.0' });

  const resolveScopes = (scope: string | undefined): Scope[] | undefined => {
    if (scope === 'global') return ['global'];
    if (scope === 'project') return env.project ? [`project:${env.project}`] : [];
    if (scope?.startsWith('project:')) return [scope as Scope];
    return env.project ? ['global', `project:${env.project}`] : undefined;
  };

  const questionSchema = z.object({
    question: z.string().min(1).describe('The full question, ending with a question mark.'),
    header: z.string().optional().describe('Very short label (max 12 chars), e.g. "Colour".'),
    options: z
      .array(z.object({ label: z.string().min(1), description: z.string().optional() }))
      .max(6)
      .optional()
      .describe('2-6 suggested answers. The owner can always answer in free text instead.'),
    multiSelect: z.boolean().optional(),
  });

  server.registerTool(
    'ask_human',
    {
      description:
        'Ask the owner one to four questions and wait for the answer. Use it whenever a decision belongs to the owner. Make it the only tool call in its message. The session pauses until the owner replies (possibly hours later); the answer comes back as this tool result. Leave `answers` empty: Second Brain fills it in.',
      inputSchema: {
        questions: z.array(questionSchema).min(1).max(4),
        answers: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
      },
    },
    async ({ questions, answers }) => {
      if (answers?.length) {
        return text(`The owner answered:\n${answers.map((a) => `- ${a.question}\n  → ${a.answer}`).join('\n')}`);
      }
      // Reached only when the PreToolUse hook did not pause the session (defer unavailable):
      // record the question here and have the model end its turn; the runner parks the task.
      if (!env.taskId) return fail('No task is attached to this session, so there is nobody to ask.');
      const q = createQuestion(ctx, env.taskId, newId('mcp', 10), { questions });
      return text(
        `Question ${q.id} was sent to the owner. Stop working now: end your turn with one short sentence saying you are waiting for the answer. Do not guess the answer and do not continue the task; the session will be resumed with the owner's reply.`,
      );
    },
  );

  server.registerTool(
    'search_knowledge',
    {
      description:
        "Full-text search over the owner's knowledge base (Markdown notes). scope: 'all' (global + this project, default), 'global', 'project', or 'project:<slug>'. Returns matching notes with a snippet and their path; read a note with the Read tool at BRAIN_DIR/<path> or ask for it via the snippet.",
      inputSchema: { query: z.string().min(1), scope: z.string().optional() },
    },
    async ({ query, scope }) => {
      const hits = searchKnowledge(ctx, query, scope === 'all' ? resolveScopes(undefined) : resolveScopes(scope));
      if (!hits.length) return text(`No notes match "${query}".`);
      return text(
        hits
          .map((h) => `## ${h.title}\npath: ${h.path} (${h.scope})\nfile: ${ctx.cfg.brainDir}/${h.path}\n${h.snippet}`)
          .join('\n\n'),
      );
    },
  );

  server.registerTool(
    'save_knowledge',
    {
      description:
        "Save a durable learning as a Markdown note. scope: 'project' (default, this project) or 'global' (true across everything the owner does). Same title in the same scope replaces that note.",
      inputSchema: { scope: z.enum(['global', 'project']).optional(), title: z.string().min(1), content: z.string().min(1), tags: z.array(z.string()).optional() },
    },
    async ({ scope, title, content, tags }) => {
      const s: Scope = scope === 'global' || !env.project ? 'global' : `project:${env.project}`;
      const note = saveNote(ctx, s, title, content, { tags, source: env.taskId ? `agent:${env.taskId}` : 'agent' });
      return text(`Saved ${note.path}`);
    },
  );

  const currentTask = () => (env.taskId ? findTask(ctx, env.taskId) : undefined);
  /** Runs a data action and turns validation errors into tool errors the model can read. */
  const attempt = <T>(fn: () => T, ok: (v: T) => string) => {
    try {
      return text(ok(fn()));
    } catch (err) {
      return fail(err instanceof BrainError ? err.message : (err as Error).message);
    }
  };

  server.registerTool(
    'create_task',
    {
      description:
        "Create a task in the owner's inbox (it is not started until the owner moves it to todo or starts it). project defaults to the current project. " +
        'From a work task it depends on the current task by default: it will not start until this task is approved and merged, so it builds on your work. ' +
        'Pass depends_on: [] for a task that does not need this work, or the task ids it needs. From a planner task the default is no dependencies. ' +
        'milestone: the id or exact title of one of the project\'s milestones.',
      inputSchema: {
        title: z.string().min(1),
        body: z.string().optional().describe('What to do, why, and how to tell it is done (acceptance criteria).'),
        project: z.string().optional(),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe('1 low, 2 normal (default), 3 high.'),
        milestone: z.string().optional(),
        depends_on: z.array(z.string()).optional(),
      },
    },
    async ({ title, body, project, priority, milestone, depends_on }) => {
      const slug = project ?? env.project;
      if (!slug || !findProject(ctx, slug)) return fail(`Unknown project ${slug ?? '(none)'}.`);
      const cur = currentTask();
      const deps = depends_on ?? (cur && cur.kind === 'work' ? [cur.id] : []);
      return attempt(
        () =>
          createTask(
            ctx,
            { project_slug: slug, title, body: `${body ?? ''}${env.taskId ? `\n\n_Created by the agent working on ${env.taskId}._` : ''}`, priority, milestone, status: 'inbox', depends_on: deps },
            env.taskId ? `agent:${env.taskId}` : 'agent',
          ),
        (t) => `Created task ${t.id} in ${slug} (inbox)${t.milestone_id ? `, milestone ${t.milestone_id}` : ''}${t.depends_on.length ? `, depending on ${t.depends_on.join(', ')}` : ''}.`,
      );
    },
  );

  server.registerTool(
    'update_task',
    {
      description:
        "Change a task of the current project that has not started yet (inbox or todo): its dependencies (replaces the list), milestone (id or title; null clears), priority, title or body. Use it to wire up dependencies between tasks you created, e.g. after creating them in order.",
      inputSchema: {
        id: z.string(),
        depends_on: z.array(z.string()).optional(),
        milestone: z.string().nullable().optional(),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        title: z.string().min(1).optional(),
        body: z.string().optional(),
      },
    },
    async ({ id, ...patch }) => {
      const t = findTask(ctx, id);
      if (!t || t.project_slug !== env.project) return fail(`Task ${id} is not a task of this project.`);
      if (t.status !== 'inbox' && t.status !== 'todo') return fail(`Task ${id} is ${t.status}; only inbox and todo tasks can be changed here.`);
      return attempt(
        () => updateTask(ctx, id, patch),
        (u) => `${u.id} [${u.status}] ${u.title}${u.milestone_id ? `, milestone ${u.milestone_id}` : ''}${u.depends_on.length ? `, depends on ${u.depends_on.join(', ')}` : ''}`,
      );
    },
  );

  server.registerTool(
    'project_board',
    {
      description: "The current project's milestones (with progress) and its tasks: id, status, title, milestone and dependencies. Use it to avoid duplicate tasks and to pick dependencies.",
      inputSchema: { include_done: z.boolean().optional().describe('Also list done tasks (default: the 20 most recent).') },
    },
    async ({ include_done }) => {
      if (!env.project) return fail('No project is attached to this session.');
      const milestones = listMilestones(ctx, env.project);
      const tasks = listTasks(ctx, { project: env.project });
      const done = tasks.filter((t) => t.status === 'done');
      const shown = [...tasks.filter((t) => t.status !== 'done'), ...(include_done ? done : done.slice(0, 20))];
      return text(
        JSON.stringify(
          {
            milestones: milestones.map((m) => ({ id: m.id, title: m.title, status: m.status, done: m.done, total: m.total, due: m.due, description: m.description })),
            tasks: shown.map((t) => ({ id: t.id, status: t.status, kind: t.kind, title: t.title, milestone_id: t.milestone_id, depends_on: t.depends_on })),
          },
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    'create_milestone',
    {
      description: 'Add a milestone (a deliverable that groups tasks, e.g. "Backoffice v1: customer management") to the current project. Milestones are listed in the order they are created unless position is given.',
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional().describe('What is true when this milestone is done.'),
        due: z.string().optional().describe('YYYY-MM-DD, only if the owner gave a date.'),
        position: z.number().int().optional(),
      },
    },
    async ({ title, description, due, position }) => {
      if (!env.project) return fail('No project is attached to this session.');
      return attempt(
        () => createMilestone(ctx, env.project!, { title, description, due: due ?? null, position }, env.taskId ? `agent:${env.taskId}` : 'agent'),
        (m) => `Created milestone ${m.id}: ${m.title}`,
      );
    },
  );

  server.registerTool(
    'update_project_doc',
    {
      description: "Replace the current project's PROJECT.md (goal, users, scope, constraints, current state, how to run and test). Every agent working on the project reads it, so keep it short and accurate. Pass the whole new Markdown document.",
      inputSchema: { content: z.string().min(1) },
    },
    async ({ content }) => {
      if (!env.project) return fail('No project is attached to this session.');
      return attempt(() => writeProjectDoc(ctx, env.project!, content, env.taskId ? `agent:${env.taskId}` : 'agent'), () => 'PROJECT.md updated.');
    },
  );

  server.registerTool(
    'get_task_context',
    { description: 'The current task (title, body, status, branch) plus the questions asked so far with their answers and any review notes.', inputSchema: {} },
    async () => {
      if (!env.taskId) return fail('No task is attached to this session.');
      const t = findTask(ctx, env.taskId);
      if (!t) return fail(`Task ${env.taskId} not found.`);
      const questions = listQuestions(ctx, { taskId: t.id }).reverse().map((q) => ({ questions: q.questions.map((x) => x.question), answer: q.answer }));
      const notes = listEvents(ctx, t.id).filter((e) => e.type === 'task.changes_requested').map((e) => e.payload.note);
      return text(JSON.stringify({ task: toPublicTask(t), questions, review_notes: notes }, null, 2));
    },
  );

  return server;
}

if (import.meta.main) {
  const ctx = createCtx(loadConfig());
  const server = buildServer(ctx, { taskId: process.env.BRAIN_TASK_ID, project: process.env.BRAIN_PROJECT });
  await server.connect(new StdioServerTransport());
}
