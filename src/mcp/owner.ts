/**
 * Owner MCP server (stdio) for the owner's own interactive Claude sessions, in any project. Registered
 * once at user scope (`claude mcp add -s user secondbrain …`), its tools show up as
 * mcp__secondbrain__<name>. Agent sessions never load it: they run with --strict-mcp-config.
 *
 * Like the CLI, data actions work directly on BRAIN_DIR; actions that start, resume or stop a session go
 * through the running server so its scheduler and the UI own them. The current project is the one whose
 * repo (or brain/projects/<slug>/ folder) contains the session's working directory.
 */
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { APP_ROOT, loadConfig } from '../config.ts';
import { createCtx, type Ctx } from '../core/context.ts';
import { listEvents } from '../core/events.ts';
import { parseScope, readNote, saveNote, searchKnowledge, type Scope } from '../core/knowledge.ts';
import { createMilestone, listMilestones, resolveMilestone, updateMilestone } from '../core/milestones.ts';
import { createPlanTask } from '../core/planning.ts';
import { portfolio } from '../core/portfolio.ts';
import { createProject, getProject, listProjects, projectDir, readProjectDoc, updateProject, writeProjectDoc } from '../core/projects.ts';
import { getQuestion, listQuestions, openQuestionForTask, resolveAnswers } from '../core/questions.ts';
import { digestLogLine, listRuns, readRunLog } from '../core/runs.ts';
import { createSchedule, deleteSchedule, fireSchedule, listSchedules, updateSchedule } from '../core/schedules.ts';
import { createTask, getTask, listTasks, toPublicTask, updateTask } from '../core/tasks.ts';
import { BrainError, TASK_STATUSES, type Project, type Question, type Schedule } from '../core/types.ts';
import * as deliver from '../runner/deliver.ts';
import * as git from '../runner/git.ts';
import { api, serverBase, serverUp } from '../server/client.ts';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

const inside = (dir: string, cwd: string) => cwd === dir || cwd.startsWith(dir + path.sep);

/** The project whose repo or project folder holds `cwd` (deepest match wins). */
export function projectForCwd(ctx: Ctx, cwd: string): Project | undefined {
  const dir = path.resolve(cwd);
  let best: { p: Project; len: number } | undefined;
  for (const p of listProjects(ctx)) {
    for (const root of [p.repo_path, projectDir(ctx, p.slug)]) {
      if (root && inside(path.resolve(root), dir) && (!best || root.length > best.len)) best = { p, len: root.length };
    }
  }
  return best?.p;
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const localTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: TZ }) : '—');

function formatSchedule(s: Schedule): string {
  const when = s.kind === 'once' ? `once at ${localTime(s.run_at)}` : `cron "${s.cron}"`;
  return `${s.id}  ${s.enabled ? 'on ' : 'off'}  ${s.project_slug}  ${when}  next ${localTime(s.next_run_at)}  runs ${s.run_count}${s.last_task_id ? ` (last ${s.last_task_id})` : ''}  ${s.mode}  ${s.title}`;
}

function formatQuestion(q: Question): string {
  const lines = [`${q.id} · task ${q.task_id} (${q.project_slug}): ${q.task_title}`];
  q.questions.forEach((item, i) => {
    lines.push(`  ${q.questions.length > 1 ? `${i + 1}. ` : ''}${item.question}${item.multiSelect ? ' (several allowed)' : ''}`);
    item.options.forEach((o, j) => lines.push(`     ${j + 1}) ${o.label}${o.description ? ` — ${o.description}` : ''}`));
  });
  return lines.join('\n');
}

export function buildOwnerServer(ctx: Ctx, env: { cwd: string }): McpServer {
  const server = new McpServer({ name: 'secondbrain', version: '0.1.0' });
  const current = () => projectForCwd(ctx, env.cwd);

  const projectSlug = (slug: string | undefined): string => {
    const s = slug ?? current()?.slug;
    if (!s) throw new BrainError(400, 'bad_request', `no project given, and ${env.cwd} is not inside a registered project; pass project or register this repo with add_project`);
    return getProject(ctx, s).slug;
  };

  /** Wraps a handler so BrainErrors (not found, conflicts, bad input) come back as tool errors. */
  const tool = <A>(fn: (args: A) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) => async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err instanceof BrainError ? err.message : (err as Error).message);
    }
  };

  /** Session actions belong to the running server; there is no foreground fallback inside an MCP process. */
  const viaServer = async (method: string, apiPath: string, body?: unknown) => {
    if (!(await serverUp(ctx.cfg))) {
      throw new BrainError(503, 'server_down', `The Second Brain server is not running at ${serverBase(ctx.cfg)}. Start it from a normal terminal: cd ${APP_ROOT} && pnpm dev`);
    }
    return api(ctx.cfg, method, apiPath, body);
  };

  const scopeArg = z.string().optional().describe("'global', 'project' (the current or given project), 'project:<slug>', or omit for global + current project.");
  const resolveScopes = (scope: string | undefined, project?: string): Scope[] | undefined => {
    const slug = project ?? current()?.slug;
    if (scope === 'global') return ['global'];
    if (scope === 'project') return [`project:${projectSlug(slug)}`];
    if (scope) return [parseScope(scope) ?? 'global'];
    return slug ? ['global', `project:${slug}`] : undefined;
  };

  server.registerTool(
    'overview',
    {
      description:
        "Start here. The Second Brain at a glance: whether the server is running, which registered project this session's directory belongs to, open questions waiting for the owner, and tasks that are running, in review, blocked or failed.",
      inputSchema: {},
    },
    tool(async () => {
      const up = await serverUp(ctx.cfg);
      const p = current();
      const tasks = listTasks(ctx, { status: ['in_progress', 'waiting_for_human', 'review', 'blocked', 'failed'] });
      const lines = [
        `server: ${up ? `running at ${serverBase(ctx.cfg)}` : `not running (start, resume and cancel need it: cd ${APP_ROOT} && pnpm dev)`}`,
        `brain dir: ${ctx.cfg.brainDir}`,
        `current project: ${p ? `${p.slug} (${p.name})` : `none: ${env.cwd} is not inside a registered project`}`,
        `projects: ${listProjects(ctx).map((x) => x.slug).join(', ') || '(none)'}`,
        '',
        'open questions:',
        ...(listQuestions(ctx, { open: true }).map(formatQuestion).join('\n\n') || '  none').split('\n'),
        '',
        'active tasks:',
        ...(tasks.length ? tasks.map((t) => `  ${t.id}  ${t.status}  ${t.project_slug}  ${t.title}`) : ['  none']),
      ];
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'list_projects',
    { description: 'All registered projects with their repo path, default task mode, model and push policy.', inputSchema: {} },
    tool(() => json(listProjects(ctx))),
  );

  server.registerTool(
    'add_project',
    {
      description:
        "Register a project. Pass repo_path (absolute path of a git repo) for a code project; agents then work on brain/<task> branches there. Without repo_path the agent works in brain/projects/<slug>/. To register the repo this session is in, pass the session's working directory.",
      inputSchema: {
        slug: z.string().min(1).describe('Short lowercase id, e.g. "shop".'),
        name: z.string().min(1),
        repo_path: z.string().optional(),
        default_mode: z.enum(['auto', 'assisted']).optional().describe('auto: the scheduler starts todo tasks itself; assisted: they wait for start_task.'),
        model: z.string().optional(),
        push_policy: z.enum(['never', 'after_merge']).optional(),
      },
    },
    tool(({ slug, name, repo_path, default_mode, model, push_policy }) => {
      const p = createProject(ctx, { slug, name, repo_path: repo_path ?? null, default_mode, model: model ?? null, allowed_tools: [], push_policy });
      return text(`Created project ${p.slug}${p.repo_path ? ` → ${p.repo_path}` : ''}. Fill in its goal and constraints in ${projectDir(ctx, p.slug)}/PROJECT.md.`);
    }),
  );

  server.registerTool(
    'portfolio',
    { description: 'Every active project at a glance: task counts by status, open milestones with progress, open questions, tasks in review, and agent cost (total and last 7 days).', inputSchema: {} },
    tool(() => {
      const p = portfolio(ctx);
      const lines = p.projects.map((r) => {
        const c = r.counts;
        return [
          `${r.project.slug}: todo ${c.todo ?? 0} · inbox ${c.inbox ?? 0} · running ${c.in_progress ?? 0} · waiting ${c.waiting_for_human ?? 0} · review ${c.review ?? 0} · failed ${c.failed ?? 0} · done ${c.done ?? 0} · questions ${r.open_questions} · $${r.cost_usd.last_7_days} last 7 days / $${r.cost_usd.total} total${r.planning ? ' · planner running' : ''}`,
          ...r.milestones.map((m) => `  ${m.id}  ${m.done}/${m.total}  ${m.title}`),
        ].join('\n');
      });
      return text([...lines, '', `total $${p.totals.cost_usd} · last 7 days $${p.totals.cost_last_7_days}`].join('\n'));
    }),
  );

  server.registerTool(
    'project_settings',
    {
      description:
        'Change how agents work on a project: verify_command (checks run in the task worktree before review; failures go back to the agent), setup_command (prepares a fresh worktree, e.g. "pnpm install"), max_parallel (tasks running at once, each in its own worktree), auto_plan (queue a planner task when the project runs out of work), push_policy. Empty string clears a command.',
      inputSchema: {
        project: z.string().optional(),
        verify_command: z.string().optional(),
        setup_command: z.string().optional(),
        max_parallel: z.number().int().min(1).max(10).optional(),
        auto_plan: z.boolean().optional(),
        push_policy: z.enum(['never', 'after_merge']).optional(),
      },
    },
    tool(({ project, ...patch }) => json(updateProject(ctx, projectSlug(project), patch))),
  );

  server.registerTool(
    'project_doc',
    {
      description: "Read the project's PROJECT.md (goal, scope, constraints, current state), or replace it when content is given. Every agent run of the project reads it.",
      inputSchema: { project: z.string().optional(), content: z.string().optional() },
    },
    tool(({ project, content }) => {
      const slug = projectSlug(project);
      return text(content === undefined ? readProjectDoc(ctx, slug) || '(empty)' : (writeProjectDoc(ctx, slug, content), 'PROJECT.md updated.'));
    }),
  );

  server.registerTool(
    'plan_project',
    {
      description:
        'Start a planner agent for a project: it asks the owner what is unclear, updates PROJECT.md and the milestones, and queues the next tasks in the inbox. focus narrows it (e.g. "backoffice customer management"). Needs the server.',
      inputSchema: { project: z.string().optional(), focus: z.string().optional() },
    },
    tool(async ({ project, focus }) => {
      const t = await viaServer('POST', `/projects/${projectSlug(project)}/plan`, { focus });
      return text(`Planner task ${t.id} is ${t.status}. Its questions show up in list_questions; the tasks it queues land in the inbox.`);
    }),
  );

  server.registerTool(
    'milestones',
    {
      description: "List a project's milestones with progress, or add one (title given), or mark one done/open (milestone + status).",
      inputSchema: {
        project: z.string().optional(),
        title: z.string().optional().describe('Add a milestone with this title.'),
        description: z.string().optional(),
        due: z.string().optional().describe('YYYY-MM-DD'),
        milestone: z.string().optional().describe('Id or title of an existing milestone, with status.'),
        status: z.enum(['open', 'done']).optional(),
      },
    },
    tool(({ project, title, description, due, milestone, status }) => {
      const slug = projectSlug(project);
      if (title) {
        const m = createMilestone(ctx, slug, { title, description, due: due ?? null });
        return text(`Created milestone ${m.id}: ${m.title}`);
      }
      if (milestone && status) {
        const m = updateMilestone(ctx, resolveMilestone(ctx, slug, milestone).id, { status });
        return text(`${m.id} [${m.status}] ${m.title}`);
      }
      const list = listMilestones(ctx, slug);
      return text(list.length ? list.map((m) => `${m.id}  [${m.status}]  ${m.done}/${m.total}  ${m.title}${m.due ? ` (due ${m.due})` : ''}`).join('\n') : 'No milestones.');
    }),
  );

  const timing = {
    run_at: z
      .string()
      .optional()
      .describe(`once: ISO date-time with an offset, e.g. 2026-11-01T09:00:00+03:30. The server's time zone is ${TZ}.`),
    cron: z
      .string()
      .optional()
      .describe(`recurring: 5-field cron in the server's local time (${TZ}): minute hour day-of-month month day-of-week. E.g. "0 9 * * 1" Mondays 09:00, "30 8 * * *" daily 08:30, "0 */6 * * *" every 6 hours, "0 10 1 * *" the 1st of each month. Also @daily, @weekly, @monthly.`),
  };

  server.registerTool(
    'list_schedules',
    { description: `Scheduled tasks: one-off and recurring task templates, with their next run (times in ${TZ}). project omitted = all projects.`, inputSchema: { project: z.string().optional() } },
    tool(({ project }) => {
      const list = listSchedules(ctx, { project: project === 'current' ? projectSlug(undefined) : project });
      return text(list.length ? list.map(formatSchedule).join('\n') : 'No schedules.');
    }),
  );

  server.registerTool(
    'add_schedule',
    {
      description:
        "Schedule a task: kind 'once' queues it at run_at (e.g. \"on 1 Nov check whether the payment arrived\"), kind 'recurring' every time cron matches (e.g. \"every Monday check the error log\"). When due, a todo task is created in the project; auto tasks start by themselves and land in review with the agent's report. A recurring task's prompt includes the previous run's result. project defaults to this directory's project.",
      inputSchema: {
        title: z.string().min(1),
        body: z.string().optional().describe('What the agent should do or check, and what to report.'),
        project: z.string().optional(),
        kind: z.enum(['once', 'recurring']),
        ...timing,
        mode: z.enum(['auto', 'assisted']).optional().describe('auto (default) runs by itself; assisted waits for the owner to start it.'),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      },
    },
    tool(({ project, ...input }) => text(`Created ${formatSchedule(createSchedule(ctx, { project_slug: projectSlug(project), ...input }))}`)),
  );

  server.registerTool(
    'update_schedule',
    {
      description: 'Edit a schedule: title, body, timing (kind, run_at, cron), mode, priority, or turn it on/off with enabled. A new run_at re-arms a one-off that already ran.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        kind: z.enum(['once', 'recurring']).optional(),
        ...timing,
        mode: z.enum(['auto', 'assisted']).optional(),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        enabled: z.boolean().optional(),
      },
    },
    tool(({ id, ...patch }) => text(formatSchedule(updateSchedule(ctx, id, patch)))),
  );

  server.registerTool(
    'delete_schedule',
    { description: 'Delete a schedule. Tasks it already queued stay.', inputSchema: { id: z.string() } },
    tool(({ id }) => {
      deleteSchedule(ctx, id);
      return text(`Deleted ${id}.`);
    }),
  );

  server.registerTool(
    'run_schedule',
    { description: "Queue a schedule's task right now, without changing its next run. Refused while its previous task is still queued or running.", inputSchema: { id: z.string() } },
    tool(({ id }) => {
      const r = fireSchedule(ctx, id, { manual: true });
      if (r.status === 'skipped') return fail(r.reason);
      return text(`Queued ${r.task.id} [${r.task.status}] ${r.task.title}${r.task.mode === 'auto' ? '; the scheduler starts it within seconds when the server runs.' : ''}`);
    }),
  );

  server.registerTool(
    'sync_task',
    {
      description: "Bring a task's branch up to date with its base branch (fast-forward, or merge the base in). Use it when a task was cut before work it needs was merged. Needs the server.",
      inputSchema: { id: z.string() },
    },
    tool(async ({ id }) => {
      const { result } = await viaServer('POST', `/tasks/${id}/sync`);
      return text(result.status === 'conflict' ? `Conflicts with ${result.base} in: ${result.conflicts.join(', ')}. Request changes so the agent merges and resolves.` : `${id}: ${result.status}`);
    }),
  );

  server.registerTool(
    'list_tasks',
    {
      description: 'Tasks, newest first. project defaults to all projects (pass "current" for this directory\'s project).',
      inputSchema: { project: z.string().optional(), status: z.array(z.enum(TASK_STATUSES as [string, ...string[]])).optional() },
    },
    tool(({ project, status }) => {
      const tasks = listTasks(ctx, { project: project === 'current' ? projectSlug(undefined) : project, status: status as any });
      if (!tasks.length) return text('No tasks.');
      return text(tasks.map((t) => `${t.id}  ${t.status}  ${t.project_slug}  ${t.kind === 'plan' ? 'planner  ' : ''}${t.mode}  p${t.priority}${t.milestone_id ? `  ${t.milestone_id}` : ''}  ${t.title}`).join('\n'));
    }),
  );

  server.registerTool(
    'get_task',
    { description: 'One task in full: fields, summary of the last run, questions and answers, runs (with log paths), commits on its branch, and recent events.', inputSchema: { id: z.string() } },
    tool(({ id }) => {
      const t = getTask(ctx, id);
      const p = getProject(ctx, t.project_slug);
      const commits = p.repo_path && t.branch && t.base_sha ? git.commitsBetween(p.repo_path, t.base_sha, t.branch) : [];
      return json({ task: toPublicTask(t), questions: listQuestions(ctx, { taskId: id }), runs: listRuns(ctx, id), commits, events: listEvents(ctx, id).slice(-15) });
    }),
  );

  server.registerTool(
    'add_task',
    {
      description:
        "Add a task. project defaults to this directory's project. Lands in the inbox (not started) unless todo is true; an auto task in todo is picked up by the scheduler within seconds.",
      inputSchema: {
        title: z.string().min(1),
        body: z.string().optional().describe('Markdown description: what to do, acceptance criteria, pointers.'),
        project: z.string().optional(),
        mode: z.enum(['auto', 'assisted']).optional(),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe('1 low, 2 normal, 3 high'),
        todo: z.boolean().optional(),
        depends_on: z.array(z.string()).optional().describe('Task ids this one needs: it is not started until each is approved and merged.'),
        milestone: z.string().optional().describe("Id or title of one of the project's milestones."),
      },
    },
    tool(({ title, body, project, mode, priority, todo, depends_on, milestone }) => {
      const t = createTask(ctx, { project_slug: projectSlug(project), title, body, mode, priority, status: todo ? 'todo' : 'inbox', depends_on, milestone });
      return text(`Created ${t.id} [${t.status}] in ${t.project_slug} (${t.mode}): ${t.title}`);
    }),
  );

  server.registerTool(
    'update_task',
    {
      description: 'Edit a task: title, body, mode, priority, milestone (id or title; null clears), its dependencies (replaces the list), or move it between inbox, todo and blocked by hand.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        mode: z.enum(['auto', 'assisted']).optional(),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        status: z.enum(['inbox', 'todo', 'blocked']).optional(),
        depends_on: z.array(z.string()).optional(),
        milestone: z.string().nullable().optional(),
      },
    },
    tool(({ id, ...patch }) => {
      const t = updateTask(ctx, id, patch);
      return text(`${t.id} [${t.status}] ${t.title}`);
    }),
  );

  server.registerTool(
    'start_task',
    { description: 'Start an agent session for a task now, in any mode (from inbox, todo, blocked or failed). Needs the server.', inputSchema: { id: z.string() } },
    tool(async ({ id }) => {
      const t = await viaServer('POST', `/tasks/${id}/start`);
      return text(`${t.id} is ${t.status}. Follow it with get_task.`);
    }),
  );

  server.registerTool(
    'cancel_task',
    { description: 'Stop a running session and park the task as blocked. Needs the server.', inputSchema: { id: z.string() } },
    tool(async ({ id }) => {
      const t = await viaServer('POST', `/tasks/${id}/cancel`);
      return text(`${t.id} is ${t.status}.`);
    }),
  );

  server.registerTool(
    'list_questions',
    { description: 'Open questions agents are waiting on, with numbered options.', inputSchema: {} },
    tool(() => {
      const qs = listQuestions(ctx, { open: true });
      return text(qs.length ? qs.map(formatQuestion).join('\n\n') : 'No open questions.');
    }),
  );

  server.registerTool(
    'answer_question',
    {
      description:
        "Answer an agent's open question and resume its session. id is the task id or the question id. answers has one entry per sub-question: an option number (\"2\"), several for multi-select (\"1,3\"), or free text. Only send what the owner decided; never answer on their behalf. Needs the server.",
      inputSchema: { id: z.string(), answers: z.array(z.string().min(1)).min(1) },
    },
    tool(async ({ id, answers }) => {
      const q = id.startsWith('q_') ? getQuestion(ctx, id) : openQuestionForTask(ctx, id);
      if (!q) return fail(`No open question for ${id}.`);
      const resolved = resolveAnswers(q, answers);
      await viaServer('POST', `/questions/${q.id}/answer`, { answers: resolved });
      return text(`Answered ${q.id}; task ${q.task_id} is resuming.\n${resolved.map((a) => `- ${a.question}\n  → ${a.answer}`).join('\n')}`);
    }),
  );

  server.registerTool(
    'task_diff',
    { description: "The diff of a task's branch against the commit it was cut from.", inputSchema: { id: z.string(), max_chars: z.number().int().positive().optional() } },
    tool(({ id, max_chars }) => {
      const t = getTask(ctx, id);
      const p = getProject(ctx, t.project_slug);
      const diff = p.repo_path && t.branch && t.base_sha ? git.diffBetween(p.repo_path, t.base_sha, t.branch) : '';
      if (!diff) return text(`${id} has no diff (no branch or no commits yet).`);
      const max = max_chars ?? 40_000;
      return text(diff.length > max ? `${diff.slice(0, max)}\n… truncated, ${diff.length - max} more characters` : diff);
    }),
  );

  server.registerTool(
    'task_log',
    { description: "A readable digest of a task's last run (or run_id). tail limits it to the last N lines.", inputSchema: { id: z.string(), run_id: z.string().optional(), tail: z.number().int().positive().optional() } },
    tool(({ id, run_id, tail }) => {
      const runs = listRuns(ctx, id);
      const run = run_id ? runs.find((r) => r.id === run_id) : runs[runs.length - 1];
      if (!run) return fail(`No runs for ${id}.`);
      const out = readRunLog(ctx, run.id).lines.map(digestLogLine).join('\n').split('\n');
      return text(`# run ${run.id} (${run.kind}) ${run.stop_reason ?? 'running'} · ${run.log_path}\n${out.slice(-(tail ?? 200)).join('\n')}`);
    }),
  );

  server.registerTool(
    'approve_task',
    {
      description:
        "Approve a task in review: squash-merge its branch into its base branch → done, and push the base branch if the project's push policy is after_merge. Only when the owner says to approve.",
      inputSchema: { id: z.string() },
    },
    tool(async ({ id }) => {
      const t = await deliver.approveAndPush(ctx, id);
      const lines = [`${t.id} [${t.status}] ${t.title}`];
      if (t.merged_sha) lines.push(`merged into ${t.merged_into} as ${t.merged_sha.slice(0, 7)}`);
      if (t.pushed_at) lines.push(`pushed ${t.merged_into}`);
      else if (t.push_error) lines.push(`push failed: ${t.push_error}`);
      else if (t.merged_sha) lines.push('not pushed (push_task pushes it)');
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'push_task',
    { description: 'Push the base branch an approved task was merged into, to its upstream. Only when the owner says to push.', inputSchema: { id: z.string() } },
    tool(async ({ id }) => {
      const t = await deliver.push(ctx, id);
      return text(t.pushed_at ? `Pushed ${t.merged_into}.` : `Not pushed: ${t.push_error ?? 'unknown error'}`);
    }),
  );

  server.registerTool(
    'request_changes',
    { description: "Send a task in review back to its agent with the owner's note; resumes the same session. Needs the server.", inputSchema: { id: z.string(), note: z.string().min(1) } },
    tool(async ({ id, note }) => {
      const t = await viaServer('POST', `/tasks/${id}/request-changes`, { note });
      return text(`${t.id} is ${t.status}; the agent got the note.`);
    }),
  );

  server.registerTool(
    'search_knowledge',
    {
      description: "Full-text search over the owner's knowledge base (Markdown notes). Returns title, path and a snippet; read a note in full with read_note.",
      inputSchema: { query: z.string().min(1), scope: scopeArg, project: z.string().optional() },
    },
    tool(({ query, scope, project }) => {
      const hits = searchKnowledge(ctx, query, resolveScopes(scope, project), 20);
      if (!hits.length) return text(`No notes match "${query}".`);
      return text(hits.map((h) => `## ${h.title}\npath: ${h.path} (${h.scope})\n${h.snippet}`).join('\n\n'));
    }),
  );

  server.registerTool(
    'read_note',
    { description: 'Read one knowledge note by its path (as returned by search_knowledge), e.g. "knowledge/commit-style.md".', inputSchema: { path: z.string().min(1) } },
    tool(({ path: rel }) => text(readNote(ctx, rel).content)),
  );

  server.registerTool(
    'save_note',
    {
      description:
        "Save a Markdown note to the knowledge base. scope: 'global' (true across everything) or 'project' (default: the current or given project). Same title in the same scope replaces that note.",
      inputSchema: { title: z.string().min(1), content: z.string().min(1), scope: z.enum(['global', 'project']).optional(), project: z.string().optional(), tags: z.array(z.string()).optional() },
    },
    tool(({ title, content, scope, project, tags }) => {
      const s: Scope = scope === 'global' ? 'global' : `project:${projectSlug(project)}`;
      return text(`Saved ${saveNote(ctx, s, title, content, { tags, source: 'owner' }).path}`);
    }),
  );

  return server;
}

if (import.meta.main) {
  const ctx = createCtx(loadConfig());
  const server = buildOwnerServer(ctx, { cwd: process.env.BRAIN_CWD ?? process.cwd() });
  await server.connect(new StdioServerTransport());
}
