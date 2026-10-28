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
import { siblings } from '../core/groups.ts';
import { findProject, writeProjectDoc } from '../core/projects.ts';
import { listMessages, postAgentMessage, takePending, waitReady } from '../core/messages.ts';
import { createQuestion, listQuestions } from '../core/questions.ts';
import { newId } from '../db/client.ts';
import { createTask, findTask, listTasks, setWaitingFor, toPublicTask, updateTask } from '../core/tasks.ts';
import { BrainError } from '../core/types.ts';
import { listEvents } from '../core/events.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export function buildServer(ctx: Ctx, env: { taskId?: string; project?: string }): McpServer {
  const server = new McpServer({ name: 'brain', version: '0.1.0' });

  const group = () => (env.project ? findProject(ctx, env.project)?.group_slug ?? null : null);
  /** Projects this session may file tasks on and read boards of: its own and its group siblings. */
  const reachable = (slug: string) => slug === env.project || (!!env.project && siblings(ctx, env.project).some((s) => s.slug === slug));

  const resolveScopes = (scope: string | undefined): Scope[] | undefined => {
    const g = group();
    if (scope === 'global') return ['global'];
    if (scope === 'project') return env.project ? [`project:${env.project}`] : [];
    if (scope === 'group') return g ? [`group:${g}`] : [];
    if (scope?.startsWith('project:') || scope?.startsWith('group:')) return [scope as Scope];
    if (!env.project) return undefined;
    return g ? ['global', `group:${g}`, `project:${env.project}`] : ['global', `project:${env.project}`];
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
    'post_update',
    {
      description:
        "Share something with the owner without stopping: drafts, options you found, numbers, a plan, a link, progress worth knowing. It shows up in the task's thread and the owner's Inbox; the owner may reply, and replies reach you as Second Brain context after a later tool call. Keep working after posting. Use ask_human only when you cannot continue without a decision.",
      inputSchema: {
        title: z.string().min(1).describe('Short headline, e.g. "Ad drafts (3)" or "Candidate channels".'),
        body: z.string().optional().describe('The material itself, in Markdown (lists and tables are fine).'),
      },
    },
    async ({ title, body }) => {
      if (!env.taskId) return fail('No task is attached to this session.');
      return attempt(() => postAgentMessage(ctx, env.taskId!, { kind: 'update', title, body }), (m) => `Posted ${m.id} to the owner. Keep working.`);
    },
  );

  server.registerTool(
    'request_action',
    {
      description:
        "Hand the owner a to-do that only they can do (pay, sign, log in, send from their own account, give access, decide offline...). It goes on the owner's list for this task; the session keeps running. Say exactly what to do and what to send back. When the owner marks it done or declined, you get their note as Second Brain context. If you cannot go on without it, call wait_for_owner with the returned id.",
      inputSchema: {
        title: z.string().min(1).describe('The to-do, imperative, e.g. "Pay @channel_admin 40 USDT".'),
        body: z.string().optional().describe('Details: why, how, and what to reply with.'),
      },
    },
    async ({ title, body }) => {
      if (!env.taskId) return fail('No task is attached to this session.');
      return attempt(() => postAgentMessage(ctx, env.taskId!, { kind: 'action', title, body }), (m) => `Action ${m.id} is on the owner's list. Continue with other work; call wait_for_owner({ action_id: "${m.id}" }) only when you are blocked on it.`);
    },
  );

  server.registerTool(
    'wait_for_owner',
    {
      description:
        'Pause until the owner resolves one of your actions (action_id) or, without action_id, until the owner writes anything. Only use it when you truly cannot do anything else first. Make it the only tool call in its message. The session pauses (possibly for hours) and the owner\'s input comes back as this tool result.',
      inputSchema: { action_id: z.string().optional(), reason: z.string().optional().describe('One sentence the owner sees: what you are waiting for.') },
    },
    async ({ action_id }) => {
      if (!env.taskId) return fail('No task is attached to this session.');
      if (waitReady(ctx, env.taskId, action_id)) {
        return text(takePending(ctx, env.taskId) ?? 'The action was already resolved or no longer exists. Continue the task.');
      }
      // Reached only when the PreToolUse hook did not pause the session: record the wait and have the model stop.
      setWaitingFor(ctx, env.taskId, { tool_use_id: newId('mcp', 10), action_id: action_id ?? null, since: new Date().toISOString() });
      return text('The owner was notified. Stop working now: end your turn with one short sentence saying what you are waiting for. The session will be resumed with the owner\'s input.');
    },
  );

  server.registerTool(
    'search_knowledge',
    {
      description:
        "Full-text search over the owner's knowledge base (Markdown notes). scope: 'all' (global + this project's group + this project, default), 'global', 'group', 'project', or 'project:<slug>'. Returns matching notes with a snippet and their path; read a note with the Read tool at BRAIN_DIR/<path> or ask for it via the snippet.",
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
        "Save a durable learning as a Markdown note. scope: 'project' (default, this project), 'group' (true for every part of this product, e.g. the API contract between backend and frontend; only when the project is in a group) or 'global' (true across everything the owner does). Same title in the same scope replaces that note.",
      inputSchema: { scope: z.enum(['global', 'group', 'project']).optional(), title: z.string().min(1), content: z.string().min(1), tags: z.array(z.string()).optional() },
    },
    async ({ scope, title, content, tags }) => {
      const g = group();
      if (scope === 'group' && !g) return fail('This project is not in a group; use scope project or global.');
      const s: Scope = scope === 'global' || !env.project ? 'global' : scope === 'group' ? `group:${g}` : `project:${env.project}`;
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
        "Create a task in the owner's inbox (it is not started until the owner moves it to todo or starts it). project defaults to the current project; it may also be another project of the same group (product), e.g. the backend when you work on the frontend. " +
        'From a work task, a task in the same project depends on the current task by default: it will not start until this task is approved and merged, so it builds on your work (a task in another project of the group has no default dependency). ' +
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
      if (env.project && !reachable(slug)) return fail(`Project ${slug} is not part of this project's group; you can create tasks only in ${[env.project, ...siblings(ctx, env.project).map((x) => x.slug)].join(', ')}.`);
      const cur = currentTask();
      // A task in another part of the product usually is what this task needs, not a follow-up of it.
      const deps = depends_on ?? (cur && cur.kind === 'work' && slug === env.project ? [cur.id] : []);
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
      description:
        "A project's milestones (with progress) and its tasks: id, status, title, milestone and dependencies. Use it to avoid duplicate tasks and to pick dependencies. project defaults to the current one; another project of the same group can be given.",
      inputSchema: { include_done: z.boolean().optional().describe('Also list done tasks (default: the 20 most recent).'), project: z.string().optional() },
    },
    async ({ include_done, project }) => {
      if (!env.project) return fail('No project is attached to this session.');
      const slug = project ?? env.project;
      if (!reachable(slug)) return fail(`Project ${slug} is not part of this project's group.`);
      const milestones = listMilestones(ctx, slug);
      const tasks = listTasks(ctx, { project: slug });
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
    { description: "The current task (title, body, status, branch) plus the questions asked so far with their answers, review notes, and the task's thread (your updates and actions, the owner's messages).", inputSchema: {} },
    async () => {
      if (!env.taskId) return fail('No task is attached to this session.');
      const t = findTask(ctx, env.taskId);
      if (!t) return fail(`Task ${env.taskId} not found.`);
      const questions = listQuestions(ctx, { taskId: t.id }).reverse().map((q) => ({ questions: q.questions.map((x) => x.question), answer: q.answer }));
      const notes = listEvents(ctx, t.id).filter((e) => e.type === 'task.changes_requested').map((e) => e.payload.note);
      const thread = listMessages(ctx, t.id).map((m) => ({ id: m.id, from: m.author, kind: m.kind, title: m.title || undefined, body: m.body || undefined, status: m.status ?? undefined, note: m.note ?? undefined, at: m.created_at }));
      return text(JSON.stringify({ task: toPublicTask(t), questions, review_notes: notes, thread }, null, 2));
    },
  );

  return server;
}

if (import.meta.main) {
  const ctx = createCtx(loadConfig());
  const server = buildServer(ctx, { taskId: process.env.BRAIN_TASK_ID, project: process.env.BRAIN_PROJECT });
  await server.connect(new StdioServerTransport());
}
