/**
 * `brain` CLI. Data commands (project/task add/list, knowledge) work directly on BRAIN_DIR.
 * Commands that start or resume a session go through the server when it is running (so the scheduler
 * and the UI see them); without a server they run the session in the foreground.
 */
import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import { config } from '../config.ts';
import { createCtx } from '../core/context.ts';
import { listEvents } from '../core/events.ts';
import { parseScope, saveNote, searchKnowledge } from '../core/knowledge.ts';
import { createMilestone, listMilestones, resolveMilestone, updateMilestone } from '../core/milestones.ts';
import { createPlanTask } from '../core/planning.ts';
import { portfolio } from '../core/portfolio.ts';
import { createProject, listProjects, updateProject } from '../core/projects.ts';
import { getQuestion, listQuestions, openQuestionForTask, resolveAnswers } from '../core/questions.ts';
import { digestLogLine as digest, listRuns, readRunLog } from '../core/runs.ts';
import { createSchedule, deleteSchedule, fireSchedule, listSchedules, updateSchedule } from '../core/schedules.ts';
import { createTask, getTask, listTasks, parseStatuses, toPublicTask, updateTask } from '../core/tasks.ts';
import { BrainError, type Priority, type Question, type Schedule, type TaskMode } from '../core/types.ts';
import * as deliver from '../runner/deliver.ts';
import { Orchestrator } from '../runner/orchestrator.ts';
import { api as serverApi, serverBase, serverUp as isServerUp } from '../server/client.ts';

const ctx = createCtx(config);
const base = serverBase(config);

const serverUp = () => isServerUp(config);
const api = (method: string, path: string, body?: unknown) => serverApi(config, method, path, body);

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

function printTask(id: string): void {
  const t = getTask(ctx, id);
  console.log(`${t.id}  [${t.status}]  ${t.title}`);
  console.log(`  project ${t.project_slug} · ${t.kind === 'plan' ? 'planner · ' : ''}${t.mode} · priority ${t.priority}${t.milestone_id ? ` · milestone ${t.milestone_id}` : ''}${t.branch ? ` · branch ${t.branch}` : ''}${t.verify_status ? ` · checks ${t.verify_status}` : ''}`);
  if (t.worktree) console.log(`  worktree ${t.worktree}`);
  if (t.depends_on.length) console.log(`  depends on ${t.depends_on.join(', ')}${t.waiting_on.length ? ` · waiting on ${t.waiting_on.join(', ')} (not done and merged yet)` : ''}`);
  const q = openQuestionForTask(ctx, id);
  if (q) printQuestion(q);
  if (t.result_summary) console.log(`\n${t.result_summary}`);
}

const splitIds = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function printDelivery(t: ReturnType<typeof getTask>): void {
  console.log(`${t.id}  [${t.status}]  ${t.title}`);
  if (t.merged_sha) console.log(`  merged into ${t.merged_into} as ${t.merged_sha.slice(0, 7)} (${t.commit_count} commit${t.commit_count === 1 ? '' : 's'} squashed)`);
  if (t.pushed_at) console.log(`  pushed ${t.merged_into}`);
  else if (t.push_error) console.log(`  push failed: ${t.push_error}\n  retry with: brain task push ${t.id}`);
  else if (t.merged_sha) console.log(`  not pushed (push with: brain task push ${t.id})`);
}

function printQuestion(q: Question): void {
  console.log(`\n? ${q.id} (task ${q.task_id}: ${q.task_title})`);
  q.questions.forEach((item, i) => {
    console.log(`  ${q.questions.length > 1 ? `${i + 1}. ` : ''}${item.question}${item.multiSelect ? ' (several allowed, comma-separated)' : ''}`);
    item.options.forEach((o, j) => console.log(`     ${j + 1}) ${o.label}${o.description ? ` — ${o.description}` : ''}`));
  });
  console.log(`  answer with: brain task answer ${q.task_id} <answer>${q.questions.length > 1 ? ' <answer2> ...' : ''}`);
}

/** Runs a session-starting action through the server, or in the foreground when no server is up. */
async function viaServerOr(local: (o: Orchestrator) => unknown, remote: () => Promise<unknown>, taskId: string): Promise<void> {
  if (await serverUp()) {
    await remote();
    console.log(`Handed to the server (${base}). Follow it with: brain task show ${taskId}`);
    return;
  }
  const orch = new Orchestrator(ctx);
  local(orch);
  console.log(`No server running; running ${taskId} in the foreground…`);
  await orch.wait(taskId);
  console.log('');
  printTask(taskId);
}

const program = new Command('brain').description('Second Brain: projects, tasks, knowledge, and Claude agents that work them.');

const project = program.command('project').description('manage projects');
project
  .command('add <slug>')
  .description('register a project')
  .requiredOption('-n, --name <name>', 'display name')
  .option('-r, --repo <path>', 'absolute path to the git repo the agent works in')
  .addOption(new Option('-m, --mode <mode>', 'default task mode').choices(['auto', 'assisted']))
  .option('--model <model>', 'claude --model for this project')
  .option('-t, --allow-tool <tool...>', 'extra --allowedTools entries, e.g. "Bash(pnpm test *)"')
  .addOption(new Option('--push <policy>', 'push the base branch after an approved task is merged').choices(['never', 'after_merge']))
  .action((slug, o) => {
    const p = createProject(ctx, { slug, name: o.name, repo_path: o.repo ?? null, default_mode: o.mode, model: o.model ?? null, allowed_tools: o.allowTool ?? [], push_policy: o.push });
    console.log(`Created project ${p.slug}${p.repo_path ? ` → ${p.repo_path}` : ''}. Notes go in ${config.brainDir}/projects/${p.slug}/`);
  });
project
  .command('set-push <slug> <policy>')
  .description('set when approved, merged tasks are pushed: never | after_merge')
  .action((slug, policy) => {
    const p = updateProject(ctx, slug, { push_policy: policy });
    console.log(`${p.slug}: push ${p.push_policy}`);
  });
project
  .command('set <slug>')
  .description('change project settings')
  .option('--verify <command>', 'checks run in the worktree before review, e.g. "pnpm -s test" ("" clears)')
  .option('--setup <command>', 'prepares a fresh worktree, e.g. "pnpm install" ("" clears)')
  .option('--parallel <n>', 'tasks of this project that may run at once (1-10)')
  .option('--auto-plan <on|off>', 'queue a planner task when the project runs out of open work')
  .action((slug, o) => {
    const p = updateProject(ctx, slug, {
      verify_command: o.verify,
      setup_command: o.setup,
      max_parallel: o.parallel !== undefined ? Number(o.parallel) : undefined,
      auto_plan: o.autoPlan !== undefined ? ['on', 'true', '1', 'yes'].includes(String(o.autoPlan)) : undefined,
    });
    console.log(`${p.slug}: verify ${p.verify_command ?? '-'} · setup ${p.setup_command ?? '-'} · parallel ${p.max_parallel} · auto-plan ${p.auto_plan ? 'on' : 'off'}`);
  });
project
  .command('plan <slug> [focus...]')
  .description('queue a planner task: it updates PROJECT.md and milestones and puts the next tasks in the inbox')
  .action(async (slug: string, focus: string[]) => {
    if (await serverUp()) {
      const t = await api('POST', `/projects/${slug}/plan`, { focus: focus.join(' ') });
      console.log(`${t.id}  [${t.status}]  planner task handed to the server (${base})`);
      return;
    }
    const t = createPlanTask(ctx, slug, { focus: focus.join(' ') });
    console.log(`${t.id}  [${t.status}]  queued; start it with: brain task start ${t.id} (or start the server)`);
  });
project
  .command('list')
  .description('list projects')
  .action(() => {
    for (const p of listProjects(ctx)) console.log(`${pad(p.slug, 20)} ${pad(p.status, 9)} ${pad(p.default_mode, 9)} ${p.name}${p.repo_path ? `  (${p.repo_path})` : ''}`);
  });

const task = program.command('task').description('manage tasks');
task
  .command('add <project> <title>')
  .description('add a task (to the inbox unless --todo)')
  .option('-b, --body <text>', 'markdown description ("-" reads stdin)')
  .addOption(new Option('-m, --mode <mode>', 'auto or assisted (default: project default)').choices(['auto', 'assisted']))
  .addOption(new Option('-p, --priority <n>', '1 low, 2 normal, 3 high').choices(['1', '2', '3']))
  .option('--todo', 'put it straight into todo (auto tasks then get picked up by the scheduler)')
  .option('--after <ids>', 'comma-separated task ids it needs: it is not started until each is approved and merged')
  .option('-M, --milestone <idOrTitle>', 'milestone of the project')
  .action((slug, title, o) => {
    const body = o.body === '-' ? readFileSync(0, 'utf8') : o.body;
    const t = createTask(ctx, {
      project_slug: slug,
      title,
      body,
      mode: o.mode as TaskMode | undefined,
      priority: o.priority ? (Number(o.priority) as Priority) : undefined,
      status: o.todo ? 'todo' : 'inbox',
      depends_on: o.after ? splitIds(o.after) : undefined,
      milestone: o.milestone,
    });
    console.log(`${t.id}  [${t.status}]  ${t.title}${t.depends_on.length ? `  (after ${t.depends_on.join(', ')})` : ''}`);
  });
task
  .command('deps <id> [ids...]')
  .description('set the tasks <id> waits for (replaces the list; no ids clears it)')
  .action((id: string, ids: string[]) => {
    updateTask(ctx, id, { depends_on: ids.flatMap(splitIds) });
    printTask(id);
  });
task
  .command('list')
  .description('list tasks, newest first')
  .option('-P, --project <slug>')
  .option('-s, --status <list>', 'comma-separated statuses')
  .action((o) => {
    for (const t of listTasks(ctx, { project: o.project, status: parseStatuses(o.status) })) {
      console.log(`${t.id}  ${pad(t.status, 17)} ${pad(t.project_slug, 14)} ${t.mode === 'assisted' ? '(assisted) ' : ''}${t.title}${t.waiting_on.length ? `  (waiting on ${t.waiting_on.join(', ')})` : ''}`);
    }
  });
task
  .command('show <id>')
  .description('task details, open question, last summary and recent events')
  .option('--json', 'print as JSON')
  .action((id, o) => {
    if (o.json) {
      console.log(JSON.stringify({ task: toPublicTask(getTask(ctx, id)), questions: listQuestions(ctx, { taskId: id }), runs: listRuns(ctx, id), events: listEvents(ctx, id) }, null, 2));
      return;
    }
    printTask(id);
    const runs = listRuns(ctx, id);
    if (runs.length) {
      console.log('\nRuns:');
      for (const r of runs) console.log(`  ${r.id} ${r.kind} ${r.started_at} → ${r.stop_reason ?? 'running'}${r.cost_usd != null ? ` · $${r.cost_usd.toFixed(4)}` : ''}  ${r.log_path}`);
    }
  });
task
  .command('start <id>')
  .description('start a session for a task now (any mode)')
  .action(async (id) => viaServerOr((o) => o.start(id), () => api('POST', `/tasks/${id}/start`), id));
task
  .command('answer <id> <answers...>')
  .description("answer the task's open question (task id or question id); an option number picks that option")
  .action(async (id: string, raw: string[]) => {
    const q = id.startsWith('q_') ? getQuestion(ctx, id) : openQuestionForTask(ctx, id);
    if (!q) throw new BrainError(404, 'not_found', `no open question for ${id}`);
    const answers = resolveAnswers(q, raw);
    await viaServerOr((o) => o.answer(q.id, answers), () => api('POST', `/questions/${q.id}/answer`, { answers }), q.task_id);
  });
task
  .command('approve <id>')
  .description('review → done: squash-merge the task branch into its base, then push if the project says so')
  .action(async (id) => printDelivery(await deliver.approveAndPush(ctx, id)));
task
  .command('merge <id>')
  .description('squash-merge a done task whose branch never reached its base (e.g. approved by an outdated server)')
  .action((id) => printDelivery(deliver.merge(ctx, id)));
task
  .command('push <id>')
  .description('push the branch an approved task was merged into')
  .action(async (id) => printDelivery(await deliver.push(ctx, id)));
task
  .command('request-changes <id> <note>')
  .description('review → in_progress, resuming the session with your note')
  .action(async (id, note) => viaServerOr((o) => o.requestChanges(id, note), () => api('POST', `/tasks/${id}/request-changes`, { note }), id));
task
  .command('sync <id>')
  .description('bring the task branch up to date with its base (fast-forward, or merge the base in)')
  .action(async (id) => {
    const r = (await serverUp()) ? (await api('POST', `/tasks/${id}/sync`)).result : new Orchestrator(ctx).sync(id);
    console.log(r.status === 'conflict' ? `conflicts with ${r.base} in: ${r.conflicts.join(', ')} (request changes so the agent merges and resolves)` : r.status);
  });
task
  .command('milestone <id> [milestone]')
  .description('put a task in a milestone (id or title); no milestone clears it')
  .action((id, m) => {
    updateTask(ctx, id, { milestone: m ?? null });
    printTask(id);
  });
task
  .command('cancel <id>')
  .description('stop a running session and park the task as blocked')
  .action(async (id) => {
    if (await serverUp()) await api('POST', `/tasks/${id}/cancel`);
    else new Orchestrator(ctx).cancel(id);
    printTask(id);
  });
task
  .command('log <id>')
  .description('print the last run of a task (raw stream-json, or a readable digest)')
  .option('--raw', 'raw stream-json lines')
  .option('-r, --run <runId>', 'a specific run')
  .action((id, o) => {
    const runs = listRuns(ctx, id);
    const run = o.run ? runs.find((r) => r.id === o.run) : runs[runs.length - 1];
    if (!run) throw new BrainError(404, 'not_found', `no runs for ${id}`);
    const { lines } = readRunLog(ctx, run.id);
    console.log(`# run ${run.id} (${run.kind}) ${run.stop_reason ?? 'running'} · ${run.log_path}`);
    for (const l of lines) {
      if (o.raw) {
        console.log(l);
        continue;
      }
      console.log(digest(l));
    }
  });

program
  .command('questions')
  .description('open questions waiting for you')
  .action(() => {
    const qs = listQuestions(ctx, { open: true });
    if (!qs.length) console.log('No open questions.');
    qs.forEach(printQuestion);
  });

const ms = program.command('milestone').description('milestones: deliverables that group a project\'s tasks');
ms.command('add <project> <title>')
  .option('-d, --description <text>', 'what is true when it is done')
  .option('--due <date>', 'YYYY-MM-DD')
  .action((slug, title, o) => {
    const m = createMilestone(ctx, slug, { title, description: o.description, due: o.due ?? null });
    console.log(`${m.id}  ${m.title}`);
  });
ms.command('list <project>')
  .option('-a, --all', 'include done milestones')
  .action((slug, o) => {
    for (const m of listMilestones(ctx, slug, { includeDone: Boolean(o.all) }))
      console.log(`${m.id}  [${m.status}]  ${pad(`${m.done}/${m.total}`, 7)} ${m.title}${m.due ? `  (due ${m.due})` : ''}`);
  });
ms.command('done <project> <idOrTitle>')
  .description('mark a milestone done')
  .action((slug, ref) => {
    const m = updateMilestone(ctx, resolveMilestone(ctx, slug, ref).id, { status: 'done' });
    console.log(`${m.id}  [${m.status}]  ${m.title}`);
  });

const local = (iso: string | null) => (iso ? new Date(iso).toLocaleString('sv-SE') : '—');
const printSchedule = (s: Schedule) =>
  console.log(`${s.id}  ${s.enabled ? 'on ' : 'off'}  ${pad(s.project_slug, 14)} ${pad(s.kind === 'once' ? `once ${local(s.run_at)}` : s.cron!, 22)} next ${pad(local(s.next_run_at), 19)}  ${s.title}`);

const sched = program.command('schedule').description('scheduled tasks: queued once at a time, or on a cron schedule (server local time)');
sched
  .command('add <project> <title>')
  .description('schedule a task: --at for a one-off, --cron for a recurring one')
  .option('-b, --body <text>', 'markdown description ("-" reads stdin)')
  .option('--at <datetime>', 'one-off: date-time, e.g. "2026-11-01 09:00" (local) or ISO with offset')
  .option('--cron <expr>', 'recurring: "min hour day month weekday", e.g. "0 9 * * 1" or @daily')
  .addOption(new Option('-m, --mode <mode>', 'auto (default) or assisted').choices(['auto', 'assisted']))
  .addOption(new Option('-p, --priority <n>', '1 low, 2 normal, 3 high').choices(['1', '2', '3']))
  .action((slug, title, o) => {
    if (!o.at === !o.cron) throw new BrainError(400, 'bad_request', 'pass exactly one of --at or --cron');
    const body = o.body === '-' ? readFileSync(0, 'utf8') : o.body;
    printSchedule(
      createSchedule(ctx, {
        project_slug: slug,
        title,
        body,
        kind: o.at ? 'once' : 'recurring',
        run_at: o.at ? new Date(o.at).toISOString() : undefined,
        cron: o.cron,
        mode: o.mode as TaskMode | undefined,
        priority: o.priority ? (Number(o.priority) as Priority) : undefined,
      }),
    );
  });
sched
  .command('list')
  .option('-P, --project <slug>')
  .action((o) => listSchedules(ctx, { project: o.project }).forEach(printSchedule));
sched.command('on <id>').description('enable').action((id) => printSchedule(updateSchedule(ctx, id, { enabled: true })));
sched.command('off <id>').description('disable').action((id) => printSchedule(updateSchedule(ctx, id, { enabled: false })));
sched.command('rm <id>').description('delete (its tasks stay)').action((id) => {
  deleteSchedule(ctx, id);
  console.log(`Deleted ${id}`);
});
sched
  .command('run <id>')
  .description("queue the schedule's task now, without changing its next run")
  .action((id) => {
    const r = fireSchedule(ctx, id, { manual: true });
    if (r.status === 'skipped') throw new BrainError(409, 'conflict', r.reason);
    printTask(r.task.id);
  });

program
  .command('overview')
  .description('every active project: progress, what waits on you, cost')
  .action(() => {
    const p = portfolio(ctx);
    for (const r of p.projects) {
      const c = r.counts;
      console.log(`${pad(r.project.slug, 16)} todo ${c.todo ?? 0} · running ${c.in_progress ?? 0} · waiting ${c.waiting_for_human ?? 0} · review ${c.review ?? 0} · done ${c.done ?? 0} · questions ${r.open_questions} · $${r.cost_usd.last_7_days} (7d) / $${r.cost_usd.total}${r.planning ? ' · planning' : ''}`);
      for (const m of r.milestones) console.log(`  ${pad(`${m.done}/${m.total}`, 7)} ${m.title}`);
    }
    console.log(`\ntotal $${p.totals.cost_usd} · last 7 days $${p.totals.cost_last_7_days} · ${p.totals.open_questions} open question(s) · ${p.totals.in_review} in review`);
  });

const kn = program.command('knowledge').description('knowledge base');
kn.command('add <scope> <title>')
  .description('add a note; scope is "global" or "project:<slug>"; content from --content or stdin')
  .option('-c, --content <markdown>')
  .option('-t, --tag <tag...>')
  .action((scope, title, o) => {
    const content = o.content ?? readFileSync(0, 'utf8');
    const n = saveNote(ctx, parseScope(scope)!, title, content, { tags: o.tag });
    console.log(`Saved ${n.path}`);
  });
kn.command('search <query...>')
  .description('full-text search')
  .option('-s, --scope <scope>', 'global or project:<slug>')
  .action((words: string[], o) => {
    const scope = parseScope(o.scope);
    const hits = searchKnowledge(ctx, words.join(' '), scope ? [scope] : undefined);
    if (!hits.length) console.log('No matches.');
    for (const h of hits) console.log(`${h.path}  (${h.scope})  ${h.title}\n    ${h.snippet.replace(/\s+/g, ' ')}`);
  });

program
  .command('run <taskId>')
  .description('run one task in the foreground (debugging; does not need the server)')
  .action(async (id) => {
    const orch = new Orchestrator(ctx);
    const t = getTask(ctx, id);
    if (t.status === 'waiting_for_human' || t.status === 'review') orch.resume(id);
    else orch.start(id);
    await orch.wait(id);
    printTask(id);
  });

program.parseAsync().catch((err) => {
  console.error(`error: ${err instanceof BrainError ? err.message : (err as Error).stack}`);
  process.exit(1);
});
