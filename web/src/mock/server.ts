// In-browser fake backend for VITE_MOCK=1. Implements every endpoint of docs/05-api-contract.md
// over the in-memory seed in ./data.ts, plus a fake SSE stream driven by timers.
import type { RawResponse, SseHandler } from '../api/client';
import type { Answer, Group, Milestone, Note, NoteScope, Portfolio, Project, ProjectSummary, Question, Run, Schedule, SseEvents, SseType, Status, Task, TaskMessage, TaskStatus } from '../api/types';
import { parseFrontmatter, slugify } from '../lib/frontmatter';
import * as db from './data';

const LATENCY_MS = 120;
const CONCURRENCY = 2;

// ---------- helpers ----------

const json = (status: number, data: unknown): RawResponse => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(data),
});
const err = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(x: T): T => structuredClone(x);

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new HttpError(status, code, message);
};

function findTask(id: string): Task {
  return db.tasks.find((t) => t.id === id) ?? fail(404, 'not_found', `Task ${id} not found`);
}
function findProject(slug: string): Project {
  return db.projects.find((p) => p.slug === slug) ?? fail(404, 'not_found', `Project ${slug} not found`);
}

function findGroup(slug: string): Group {
  return db.groups.find((g) => g.slug === slug) ?? fail(404, 'not_found', `Group ${slug} not found`);
}
/** Like the backend: a group_slug in a project body must name an existing group. */
function groupSlugOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return findGroupOr400(String(v)).slug;
}
function findGroupOr400(slug: string): Group {
  return db.groups.find((g) => g.slug === slug) ?? fail(400, 'invalid', `Unknown group ${slug}`);
}
/** Recompute every group's member list from projects.group_slug and emit what changed. */
function syncGroups(changedProject?: Project) {
  for (const g of db.groups) {
    const members = db.projects.filter((p) => p.group_slug === g.slug).map((p) => p.slug);
    if (members.join() === g.projects.join()) continue;
    g.projects = members;
    g.updated_at = nowIso();
    emit('group.updated', clone(g));
  }
  if (changedProject) emit('project.updated', clone(changedProject));
}

function findSchedule(id: string): Schedule {
  return db.schedules.find((s) => s.id === id) ?? fail(404, 'not_found', `schedule ${id} not found`);
}

/** The mock does not evaluate cron: a recurring schedule's next run is an hour away. */
const mockNext = (s: Schedule) => (!s.enabled ? null : s.kind === 'once' ? (s.run_count > 0 ? null : s.run_at) : new Date(Date.now() + 3_600_000).toISOString());

function findMilestone(id: string): Milestone {
  return db.milestones.find((m) => m.id === id) ?? fail(404, 'not_found', `Milestone ${id} not found`);
}

/** A milestone with its counts filled in from the work tasks that belong to it. */
function milestoneView(m: Milestone): Milestone {
  const counts: Milestone['counts'] = {};
  let total = 0;
  for (const t of db.tasks) {
    if (t.milestone_id !== m.id || t.kind !== 'work') continue;
    counts[t.status] = (counts[t.status] ?? 0) + 1;
    total++;
  }
  return { ...clone(m), counts, total, done: counts.done ?? 0 };
}

/** Accepts a milestone id or title (case-insensitive) of the project, like the server. */
function resolveMilestone(slug: string, ref: unknown): string | null {
  if (ref === null || ref === undefined || ref === '') return null;
  const r = String(ref);
  const m = db.milestones.find((x) => x.project_slug === slug && (x.id === r || x.title.toLowerCase() === r.toLowerCase()));
  return m ? m.id : fail(400, 'invalid', `Unknown milestone ${r} in ${slug}`);
}

const DAY_MS = 86_400_000;

function portfolio(): Portfolio {
  const weekAgo = Date.now() - 7 * DAY_MS;
  const projects: ProjectSummary[] = db.projects
    .filter((p) => p.status === 'active')
    .map((p) => {
      const ts = db.tasks.filter((t) => t.project_slug === p.slug);
      const ids = new Set(ts.map((t) => t.id));
      const counts: ProjectSummary['counts'] = {};
      for (const t of ts) if (t.kind === 'work') counts[t.status] = (counts[t.status] ?? 0) + 1;
      const runs = db.runs.filter((r) => ids.has(r.task_id));
      const recent = runs.filter((r) => new Date(r.started_at).getTime() >= weekAgo);
      const sum = (rs: Run[]) => Math.round(rs.reduce((n, r) => n + (r.cost_usd ?? 0), 0) * 100) / 100;
      const last = ts.map((t) => t.updated_at).sort().pop() ?? null;
      return {
        project: clone(p),
        counts,
        open_questions: db.questions.filter((q) => q.project_slug === p.slug && !q.answer).length,
        in_review: ts.filter((t) => t.status === 'review').length,
        milestones: db.milestones
          .filter((m) => m.project_slug === p.slug && m.status === 'open')
          .sort((a, b) => a.position - b.position)
          .map(milestoneView),
        cost_usd: { total: sum(runs), last_7_days: sum(recent) },
        runs: { total: runs.length, last_7_days: recent.length },
        last_activity: last,
        planning: ts.some((t) => t.kind === 'plan' && !t.milestone_id && ['todo', 'in_progress', 'waiting_for_human'].includes(t.status)),
      };
    });
  const add = (f: (x: ProjectSummary) => number) => Math.round(projects.reduce((n, x) => n + f(x), 0) * 100) / 100;
  return {
    projects,
    groups: clone(db.groups),
    totals: {
      cost_usd: add((x) => x.cost_usd.total),
      cost_last_7_days: add((x) => x.cost_usd.last_7_days),
      open_questions: add((x) => x.open_questions),
      in_review: add((x) => x.in_review),
      running: db.runs.filter((r) => !r.ended_at).length,
    },
  };
}

function scopeOf(path: string): NoteScope {
  const g = /^groups\/([^/]+)\/knowledge\//.exec(path);
  if (g) return `group:${g[1]}`;
  const m = /^projects\/([^/]+)\/knowledge\//.exec(path);
  return m ? `project:${m[1]}` : 'global';
}
function noteMeta(path: string): Note {
  const fm = parseFrontmatter(db.notes[path]);
  const fallback = path.split('/').pop()!.replace(/\.md$/, '');
  return {
    path,
    scope: scopeOf(path),
    title: typeof fm.title === 'string' ? fm.title : fallback,
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
    updated: fm.updated != null ? String(fm.updated) : null,
  };
}
function validNotePath(path: string): boolean {
  if (!path.endsWith('.md') || path.includes('..')) return false;
  if (/^knowledge\/[^/].*$/.test(path)) return true;
  const g = /^groups\/([^/]+)\/knowledge\/[^/].*$/.exec(path);
  if (g) return db.groups.some((x) => x.slug === g[1]);
  const m = /^projects\/([^/]+)\/knowledge\/[^/].*$/.exec(path);
  return !!m && db.projects.some((p) => p.slug === m[1]);
}

function status(): Status {
  return {
    running: db.runs.filter((r) => r.ended_at === null).length,
    concurrency: CONCURRENCY,
    claude_version: '2.1.296 (Claude Code)',
    fts5: true,
  };
}

let eventSeq = 10_000;
function logEvent(taskId: string, type: string, payload: Record<string, unknown>) {
  db.events.unshift({ id: eventSeq++, task_id: taskId, type, payload, created_at: nowIso() });
}

const fakeSha = () => Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

/** Mock of the server's approve: squash-merge when there are commits, then push if the project says so. */
function deliver(t: Task, pushNow: boolean) {
  if (t.commit_count > 0 && !t.merged_sha) {
    const sha = fakeSha();
    logEvent(t.id, 'task.merged', { sha, into: 'main' });
    touch(t, { merged_sha: sha, merged_into: 'main', merged_at: nowIso() });
    // Tasks waiting on this one (also in other projects of a group) can start now.
    for (const d of db.tasks) if (d.waiting_on.includes(t.id)) touch(d, { waiting_on: d.waiting_on.filter((x) => x !== t.id) });
  }
  if (pushNow && t.merged_sha && !t.pushed_at) {
    logEvent(t.id, 'task.pushed', { branch: t.merged_into, remote: 'origin' });
    touch(t, { pushed_at: nowIso(), push_error: null });
  }
}

/** A message with its task's title and project filled in. */
function messageView(m: TaskMessage): TaskMessage {
  const t = db.tasks.find((x) => x.id === m.task_id);
  return { ...m, task_title: t?.title ?? '', project_slug: t?.project_slug ?? '' };
}

/** Recomputes a task's thread counters (the server does this in SQL). */
function threadCounts(t: Task): Pick<Task, 'open_actions' | 'unread_updates'> {
  const mine = db.messages.filter((m) => m.task_id === t.id);
  return {
    open_actions: mine.filter((m) => m.kind === 'action' && m.status === 'open').length,
    unread_updates: mine.filter((m) => m.author === 'agent' && m.kind === 'update' && !m.read_at).length,
  };
}
for (const t of db.tasks) Object.assign(t, threadCounts(t));

function touch(t: Task, patch: Partial<Task>) {
  const before = t.milestone_id;
  Object.assign(t, patch, threadCounts(t), { updated_at: nowIso() });
  emit('task.updated', clone(t));
  for (const id of new Set([before, t.milestone_id])) {
    const m = id && db.milestones.find((x) => x.id === id);
    if (m) emit('milestone.updated', milestoneView(m));
  }
}

// ---------- SSE simulation ----------

const listeners = new Set<SseHandler>();
let started = false;

function emit<K extends SseType>(type: K, data: SseEvents[K]) {
  for (const l of listeners) l(type, data);
}

/** Active simulated runs: run id -> interval handle. */
const live = new Map<string, ReturnType<typeof setInterval>>();

type Outcome = 'end_turn' | 'tool_deferred';

function pushLog(run: Run, line: string) {
  const log = (db.runLogs[run.id] ??= []);
  log.push(line);
  emit('run.log', { run_id: run.id, index: log.length - 1, line });
}

/** Stream the remaining script lines of a run, then finish it with the given outcome. */
function streamRun(run: Run, script: string[], outcome: Outcome) {
  let i = 0;
  const handle = setInterval(() => {
    if (i < script.length) {
      pushLog(run, script[i++]);
      return;
    }
    clearInterval(handle);
    live.delete(run.id);
    finishRun(run, outcome);
  }, 1100);
  live.set(run.id, handle);
}

function finishRun(run: Run, outcome: Outcome) {
  const t = db.tasks.find((x) => x.id === run.task_id);
  const cost = Math.round((0.1 + Math.random() * 0.5) * 100) / 100;
  const usage = { input_tokens: 8000 + Math.floor(Math.random() * 9000), output_tokens: 400 + Math.floor(Math.random() * 2000) };
  pushLog(run, JSON.stringify({ type: 'result', subtype: 'success', stop_reason: outcome, total_cost_usd: cost, usage }));
  Object.assign(run, { ended_at: nowIso(), exit_code: 0, stop_reason: outcome, cost_usd: cost, usage });
  emit('run.ended', clone(run));
  emit('status', status());
  if (!t) return;
  if (outcome === 'tool_deferred') {
    const q: Question = {
      id: db.newId('q'),
      task_id: t.id,
      task_title: t.title,
      project_slug: t.project_slug,
      tool_use_id: db.newId('toolu'),
      questions: [
        {
          question: `How should I approach "${t.title}"?`,
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'Smallest change', description: 'Minimal diff, ship fast' },
            { label: 'Proper refactor', description: 'Cleaner, takes longer' },
          ],
        },
        {
          question: 'Which checks should I run before handing it back?',
          header: 'Checks',
          multiSelect: true,
          options: [
            { label: 'Unit tests', description: '' },
            { label: 'Type check', description: '' },
            { label: 'Lint', description: '' },
          ],
        },
      ],
      answer: null,
      asked_at: nowIso(),
      answered_at: null,
    };
    db.questions.unshift(q);
    touch(t, { status: 'waiting_for_human', question_count: t.question_count + 1 });
    emit('question.created', clone(q));
  } else {
    if (t.branch) {
      (db.commits[t.id] ??= []).unshift({
        sha: Math.random().toString(16).slice(2).padEnd(40, '0').slice(0, 40),
        message: `feat: ${t.title.toLowerCase()}`,
        author: 'Claude',
        date: nowIso(),
      });
      t.commit_count = db.commits[t.id].length;
      db.diffs[t.id] ??= `diff --git a/NOTES.md b/NOTES.md\n--- a/NOTES.md\n+++ b/NOTES.md\n@@ -1,2 +1,3 @@\n # Notes\n+- ${t.title}\n`;
    }
    const verify = t.kind === 'work' && t.branch ? findProject(t.project_slug).verify_command : null;
    if (verify) logEvent(t.id, 'task.verify', { ok: true, command: verify, exit_code: 0, output: 'All checks passed.' });
    touch(t, {
      status: 'review',
      verify_status: verify ? 'passed' : t.verify_status,
      result_summary: `Finished "${t.title}". ${t.branch ? `Committed on \`${t.branch}\`.` : 'No repository changes.'} Ready for review.`,
    });
  }
}

function startRun(t: Task, kind: Run['kind'], outcome: Outcome, preface?: string) {
  const id = db.newId('r');
  if (!t.session_id) t.session_id = crypto.randomUUID();
  const run: Run = {
    id,
    task_id: t.id,
    session_id: t.session_id,
    kind,
    started_at: nowIso(),
    ended_at: null,
    exit_code: null,
    stop_reason: null,
    usage: null,
    cost_usd: null,
    log_path: `brain/runs/${t.id}/${id}.jsonl`,
  };
  db.runs.push(run);
  db.runLogs[id] = [];
  emit('run.started', clone(run));
  emit('status', status());
  const script = db.sampleLog(t.title, 'running');
  if (preface) script.splice(1, 0, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: preface }] } }));
  streamRun(run, kind === 'resume' ? script.slice(0, 5) : script, outcome);
}

function killRun(taskId: string) {
  for (const run of db.runs) {
    if (run.task_id !== taskId || run.ended_at) continue;
    const h = live.get(run.id);
    if (h) clearInterval(h);
    live.delete(run.id);
    Object.assign(run, { ended_at: nowIso(), exit_code: 143, stop_reason: 'cancelled' });
    emit('run.ended', clone(run));
  }
  emit('status', status());
}

/** Mirrors the server: `updated` becomes today unless the writer changed it (or the note is new and has one). */
function stampUpdated(content: string, before: string | null): string {
  const today = nowIso().slice(0, 10);
  const incoming = parseFrontmatter(content).updated;
  if (incoming != null && (before === null || String(incoming) !== String(parseFrontmatter(before).updated))) return content;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return `---\nupdated: ${today}\n---\n\n${content}`;
  const fm = /^updated:.*$/m.test(m[1]) ? m[1].replace(/^updated:.*$/m, `updated: ${today}`) : `${m[1]}\nupdated: ${today}`;
  return content.replace(m[1], () => fm);
}

function boot() {
  if (started) return;
  started = true;
  // The seeded in-progress run keeps streaming and then lands in review.
  const prog = db.runs.find((r) => r.id === 'r_prog1')!;
  const rest = db.sampleLog('Write knowledge index rebuild on file change', 'end_turn').slice(4, -1);
  streamRun(prog, rest, 'end_turn');
  // A fake scheduler: every 25 s pick the best todo task and start it.
  setInterval(() => {
    const running = db.runs.filter((r) => !r.ended_at).length;
    if (running >= CONCURRENCY) return;
    const next = db.tasks
      .filter((t) => t.status === 'todo' && !t.waiting_on.length)
      .sort((a, b) => b.priority - a.priority)[0];
    if (!next) return;
    touch(next, { status: 'in_progress', branch: next.branch ?? branchFor(next) });
    startRun(next, 'start', Math.random() < 0.5 ? 'tool_deferred' : 'end_turn');
  }, 25_000);
  setInterval(() => emit('status', status()), 15_000);
}

function newTask(proj: Project, title: string, status: TaskStatus): Task {
  return {
    id: db.newId('t'),
    project_slug: proj.slug,
    title,
    body: '',
    status,
    priority: 2,
    branch: null,
    session_id: null,
    result_summary: null,
    question_count: 0,
    commit_count: 0,
    merged_sha: null,
    merged_into: null,
    merged_at: null,
    pushed_at: null,
    push_error: null,
    depends_on: [],
    waiting_on: [],
    milestone_id: null,
    kind: 'work',
    worktree: null,
    verify_status: null,
    schedule_id: null,
    waiting_for: null,
    open_actions: 0,
    unread_updates: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

const branchFor = (t: Task) =>
  db.projects.find((p) => p.slug === t.project_slug)?.repo_path ? `brain/${t.id}-${slugify(t.title).slice(0, 30)}` : null;

export function mockSubscribe(handler: SseHandler): () => void {
  listeners.add(handler);
  boot();
  setTimeout(() => handler('status', status()), 50);
  return () => listeners.delete(handler);
}

/** Replace a group's members exactly; projects moved in or out get project.updated, other groups group.updated. */
function setMembers(g: Group, slugs: string[]) {
  for (const sl of slugs) findProject(sl);
  for (const proj of db.projects) {
    const want = slugs.includes(proj.slug) ? g.slug : proj.group_slug === g.slug ? null : proj.group_slug;
    if (want === proj.group_slug) continue;
    proj.group_slug = want;
    proj.updated_at = nowIso();
    emit('project.updated', clone(proj));
  }
  g.projects = db.projects.filter((x) => x.group_slug === g.slug).map((x) => x.slug);
  for (const other of db.groups) {
    if (other === g) continue;
    const members = db.projects.filter((x) => x.group_slug === other.slug).map((x) => x.slug);
    if (members.join() === other.projects.join()) continue;
    other.projects = members;
    other.updated_at = nowIso();
    emit('group.updated', clone(other));
  }
}

// ---------- router ----------

type Body = Record<string, unknown>;

const MANUAL: TaskStatus[] = ['inbox', 'todo', 'blocked'];
const PRIORITIES = [1, 2, 3];

function route(method: string, url: URL, body: Body): RawResponse {
  const p = url.pathname;
  let m: RegExpExecArray | null;

  if (method === 'GET' && p === '/api/status') return json(200, status());

  // Projects
  if (p === '/api/projects') {
    if (method === 'GET') return json(200, db.projects);
    if (method === 'POST') {
      const slug = String(body.slug ?? '');
      if (!/^[a-z0-9-]+$/.test(slug)) fail(400, 'invalid', 'slug must match [a-z0-9-]+');
      if (!body.name) fail(400, 'invalid', 'name is required');
      if (db.projects.some((x) => x.slug === slug)) fail(409, 'conflict', `Project ${slug} already exists`);
      const proj: Project = {
        slug,
        name: String(body.name),
        repo_path: (body.repo_path as string) || null,
        model: (body.model as string) || null,
        allowed_tools: (body.allowed_tools as string[]) ?? [],
        push_policy: (body.push_policy as Project['push_policy']) ?? 'never',
        verify_command: (body.verify_command as string) || null,
        setup_command: (body.setup_command as string) || null,
        max_parallel: Number(body.max_parallel ?? 1),
        auto_plan: body.auto_plan === true,
        status: 'active',
        group_slug: groupSlugOf(body.group_slug),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.projects.push(proj);
      syncGroups(proj);
      db.mcp[slug] = { project: {} };
      db.docs[slug] = `# ${proj.name}\n`;
      db.notes[`projects/${slug}/knowledge/index.md`] ??= `---\ntitle: ${proj.name}\ntags: []\nupdated: ${nowIso().slice(0, 10)}\n---\n\n# ${proj.name}\n`;
      return json(201, proj);
    }
  }
  if ((m = /^\/api\/projects\/([^/]+)\/mcp$/.exec(p)) && method === 'GET') {
    const proj = findProject(decodeURIComponent(m[1]));
    const project = db.mcp[proj.slug]?.project ?? {};
    const merged = {
      mcpServers: {
        ...((db.globalMcp.mcpServers as object) ?? {}),
        ...((project.mcpServers as object) ?? {}),
        brain: { command: 'node', args: ['dist/mcp/server.js'], env: { BRAIN_TASK_ID: '<task id>', BRAIN_DIR: '/Users/owner/Projects/SecondBrain/brain' } },
      },
    };
    return json(200, { global: db.globalMcp, project, merged });
  }
  if ((m = /^\/api\/projects\/([^/]+)\/doc$/.exec(p))) {
    const proj = findProject(decodeURIComponent(m[1]));
    if (method === 'GET') return json(200, { content: db.docs[proj.slug] ?? '' });
    if (method === 'PUT') {
      db.docs[proj.slug] = String(body.content ?? '');
      proj.updated_at = nowIso();
      emit('project.updated', clone(proj));
      return json(200, { content: db.docs[proj.slug] });
    }
  }
  if ((m = /^\/api\/projects\/([^/]+)\/plan$/.exec(p)) && method === 'POST') {
    const proj = findProject(decodeURIComponent(m[1]));
    const open = db.tasks.find((t) => t.project_slug === proj.slug && t.kind === 'plan' && !t.milestone_id && t.status !== 'done');
    if (open) fail(409, 'conflict', `${proj.name} already has a planner task (${open.id}, ${open.status})`);
    const focus = String(body.focus ?? '').trim();
    const t: Task = {
      ...newTask(proj, `Plan next steps for ${proj.name}`, 'todo'),
      body: `Review PROJECT.md, the milestones and the board, ask what is unclear, then queue the next tasks.${focus ? `\n\nFocus: ${focus}` : ''}`,
      priority: 3,
      kind: 'plan',
    };
    db.tasks.unshift(t);
    logEvent(t.id, 'task.created', { source: 'owner', status: 'todo' });
    emit('task.updated', clone(t));
    const running = db.runs.filter((r) => !r.ended_at).length;
    if (running < CONCURRENCY) {
      touch(t, { status: 'in_progress' });
      startRun(t, 'start', 'tool_deferred');
    }
    return json(201, t);
  }
  if (p === '/api/schedules/preview') {
    const cron = String(url.searchParams.get('cron') ?? '').trim();
    if (cron.split(/\s+/).length !== 5 && !cron.startsWith('@')) fail(400, 'bad_request', 'cron must have 5 fields (minute hour day-of-month month day-of-week)');
    // The mock does not evaluate cron; it shows hourly placeholders.
    return json(200, { next: [1, 2, 3].map((h) => new Date(Date.now() + h * 3_600_000).toISOString()) });
  }
  if (p === '/api/schedules') {
    if (method === 'GET') {
      const project = url.searchParams.get('project');
      return json(200, db.schedules.filter((x) => !project || x.project_slug === project));
    }
    if (method === 'POST') {
      const proj = findProject(String(body.project_slug ?? ''));
      const title = String(body.title ?? '').trim();
      if (!title) fail(400, 'bad_request', 'title is required');
      const kind = body.kind === 'once' ? 'once' : 'recurring';
      if (kind === 'once' && !body.run_at) fail(400, 'bad_request', 'run_at is required');
      if (kind === 'recurring' && !body.cron) fail(400, 'bad_request', 'cron is required');
      const sc: Schedule = {
        id: db.newId('s'),
        project_slug: proj.slug,
        title,
        body: String(body.body ?? ''),
        priority: (Number(body.priority) || 2) as Schedule['priority'],
        kind,
        run_at: kind === 'once' ? new Date(String(body.run_at)).toISOString() : null,
        cron: kind === 'recurring' ? String(body.cron) : null,
        enabled: body.enabled !== false,
        next_run_at: null,
        last_run_at: null,
        last_task_id: null,
        run_count: 0,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      sc.next_run_at = mockNext(sc);
      db.schedules.push(sc);
      emit('schedule.updated', clone(sc));
      return json(201, sc);
    }
  }
  if ((m = /^\/api\/schedules\/([^/]+)\/run$/.exec(p)) && method === 'POST') {
    const sc = findSchedule(m[1]);
    const proj = findProject(sc.project_slug);
    const t = newTask(proj, sc.title, 'todo');
    Object.assign(t, { body: sc.body, priority: sc.priority, schedule_id: sc.id });
    db.tasks.unshift(t);
    Object.assign(sc, { last_task_id: t.id, last_run_at: nowIso(), run_count: sc.run_count + 1, updated_at: nowIso() });
    logEvent(t.id, 'task.created', { source: `schedule:${sc.id}`, status: 'todo' });
    emit('task.updated', clone(t));
    emit('schedule.updated', clone(sc));
    return json(201, t);
  }
  if ((m = /^\/api\/schedules\/([^/]+)$/.exec(p))) {
    const sc = findSchedule(m[1]);
    if (method === 'GET') return json(200, sc);
    if (method === 'PATCH') {
      for (const k of ['title', 'body', 'priority', 'kind', 'run_at', 'cron', 'enabled'] as const) if (k in body) (sc as any)[k] = body[k];
      if (sc.kind === 'once') sc.cron = null;
      else sc.run_at = null;
      if (sc.run_at) sc.run_at = new Date(sc.run_at).toISOString();
      sc.next_run_at = mockNext(sc);
      sc.updated_at = nowIso();
      emit('schedule.updated', clone(sc));
      return json(200, sc);
    }
    if (method === 'DELETE') {
      db.schedules.splice(db.schedules.indexOf(sc), 1);
      for (const t of db.tasks) if (t.schedule_id === sc.id) t.schedule_id = null;
      emit('schedule.deleted', { id: sc.id, project_slug: sc.project_slug });
      return { status: 204, contentType: '', body: '' };
    }
  }
  if ((m = /^\/api\/projects\/([^/]+)\/milestones$/.exec(p))) {
    const proj = findProject(decodeURIComponent(m[1]));
    const mine = db.milestones.filter((x) => x.project_slug === proj.slug);
    if (method === 'GET') return json(200, mine.sort((a, b) => a.position - b.position).map(milestoneView));
    if (method === 'POST') {
      const title = String(body.title ?? '').trim();
      if (!title) fail(400, 'invalid', 'title is required');
      if (mine.some((x) => x.title.toLowerCase() === title.toLowerCase())) fail(400, 'invalid', `Milestone "${title}" already exists`);
      const ms: Milestone = {
        id: db.newId('m'),
        project_slug: proj.slug,
        title,
        description: String(body.description ?? ''),
        status: 'open',
        position: Number(body.position ?? Math.max(0, ...mine.map((x) => x.position)) + 1),
        due: (body.due as string) || null,
        counts: {},
        total: 0,
        done: 0,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.milestones.push(ms);
      emit('milestone.updated', milestoneView(ms));
      return json(201, milestoneView(ms));
    }
  }
  if ((m = /^\/api\/milestones\/([^/]+)$/.exec(p))) {
    const ms = findMilestone(m[1]);
    if (method === 'GET') return json(200, milestoneView(ms));
    if (method === 'PATCH') {
      if ('title' in body) {
        const title = String(body.title ?? '').trim();
        if (!title) fail(400, 'invalid', 'title cannot be empty');
        const dup = db.milestones.some((x) => x.project_slug === ms.project_slug && x.id !== ms.id && x.title.toLowerCase() === title.toLowerCase());
        if (dup) fail(400, 'invalid', `Milestone "${title}" already exists`);
        ms.title = title;
      }
      if ('description' in body) ms.description = String(body.description ?? '');
      if ('due' in body) ms.due = (body.due as string) || null;
      if ('position' in body) ms.position = Number(body.position);
      if ('status' in body) ms.status = body.status === 'done' ? 'done' : 'open';
      ms.updated_at = nowIso();
      emit('milestone.updated', milestoneView(ms));
      return json(200, milestoneView(ms));
    }
    if (method === 'DELETE') {
      db.milestones.splice(db.milestones.indexOf(ms), 1);
      for (const t of db.tasks) if (t.milestone_id === ms.id) touch(t, { milestone_id: null });
      emit('milestone.deleted', { id: ms.id, project_slug: ms.project_slug });
      return { status: 204, contentType: '', body: '' };
    }
  }
  if (p === '/api/portfolio' && method === 'GET') return json(200, portfolio());
  if ((m = /^\/api\/projects\/([^/]+)$/.exec(p))) {
    const proj = findProject(decodeURIComponent(m[1]));
    if (method === 'GET') return json(200, proj);
    if (method === 'PATCH') {
      if ('max_parallel' in body) {
        const n = Number(body.max_parallel);
        if (!Number.isInteger(n) || n < 1 || n > 10) fail(400, 'invalid', 'max_parallel must be 1-10');
      }
      for (const k of ['name', 'repo_path', 'model', 'allowed_tools', 'push_policy', 'max_parallel', 'auto_plan', 'status'] as const) {
        if (k in body) (proj as unknown as Body)[k] = body[k];
      }
      for (const k of ['verify_command', 'setup_command'] as const) {
        if (k in body) proj[k] = (body[k] as string) || null;
      }
      if ('group_slug' in body) proj.group_slug = groupSlugOf(body.group_slug);
      proj.updated_at = nowIso();
      syncGroups(proj);
      return json(200, proj);
    }
  }

  // Groups
  if (p === '/api/groups') {
    if (method === 'GET') return json(200, db.groups);
    if (method === 'POST') {
      const slug = String(body.slug ?? '');
      if (!/^[a-z0-9-]+$/.test(slug)) fail(400, 'invalid', 'slug must match [a-z0-9-]+');
      if (!body.name) fail(400, 'invalid', 'name is required');
      if (db.groups.some((x) => x.slug === slug)) fail(409, 'conflict', `Group ${slug} already exists`);
      const g: Group = { slug, name: String(body.name), projects: [], created_at: nowIso(), updated_at: nowIso() };
      db.groups.push(g);
      db.groupDocs[slug] = `# ${g.name}\n`;
      setMembers(g, (body.projects as string[] | undefined) ?? []);
      emit('group.updated', clone(g));
      return json(201, g);
    }
  }
  if ((m = /^\/api\/groups\/([^/]+)\/doc$/.exec(p))) {
    const g = findGroup(decodeURIComponent(m[1]));
    if (method === 'GET') return json(200, { content: db.groupDocs[g.slug] ?? '' });
    if (method === 'PUT') {
      db.groupDocs[g.slug] = String(body.content ?? '');
      g.updated_at = nowIso();
      emit('group.updated', clone(g));
      return json(200, { content: db.groupDocs[g.slug] });
    }
  }
  if ((m = /^\/api\/groups\/([^/]+)$/.exec(p))) {
    const g = findGroup(decodeURIComponent(m[1]));
    if (method === 'GET') return json(200, g);
    if (method === 'PATCH') {
      if ('name' in body) {
        if (!String(body.name ?? '').trim()) fail(400, 'invalid', 'name is required');
        g.name = String(body.name).trim();
      }
      if ('projects' in body) setMembers(g, (body.projects as string[]) ?? []);
      g.updated_at = nowIso();
      emit('group.updated', clone(g));
      return json(200, g);
    }
    if (method === 'DELETE') {
      setMembers(g, []);
      db.groups.splice(db.groups.indexOf(g), 1);
      delete db.groupDocs[g.slug];
      emit('group.deleted', { slug: g.slug });
      return { status: 204, contentType: '', body: '' };
    }
  }

  // Tasks
  if (p === '/api/tasks') {
    if (method === 'GET') {
      const project = url.searchParams.get('project');
      const group = url.searchParams.get('group');
      const members = group ? findGroup(group).projects : null;
      const st = url.searchParams.get('status')?.split(',').filter(Boolean);
      const list = db.tasks
        .filter((t) => (!project || t.project_slug === project) && (!members || members.includes(t.project_slug)) && (!st || st.includes(t.status)))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return json(200, list);
    }
    if (method === 'POST') {
      const proj = findProject(String(body.project_slug ?? ''));
      if (!String(body.title ?? '').trim()) fail(400, 'invalid', 'title is required');
      const st = (body.status as TaskStatus) ?? 'inbox';
      if (st !== 'inbox' && st !== 'todo') fail(400, 'invalid', 'status may only be inbox or todo');
      const t: Task = {
        ...newTask(proj, String(body.title).trim(), st),
        body: String(body.body ?? ''),
        priority: (body.priority as Task['priority']) ?? 2,
        depends_on: (body.depends_on as string[] | undefined) ?? [],
        waiting_on: ((body.depends_on as string[] | undefined) ?? []).filter((d) => !db.tasks.find((x) => x.id === d)?.merged_sha),
        milestone_id: resolveMilestone(proj.slug, body.milestone),
      };
      db.tasks.unshift(t);
      touch(t, {});
      return json(201, t);
    }
  }
  if ((m = /^\/api\/tasks\/([^/]+)\/(start|approve|merge|push|request-changes|cancel|diff|sync)$/.exec(p))) {
    const t = findTask(m[1]);
    const action = m[2];
    if (action === 'diff' && method === 'GET') {
      return { status: 200, contentType: 'text/plain', body: db.diffs[t.id] ?? '' };
    }
    if (method !== 'POST') return err(405, 'method_not_allowed', 'Method not allowed');
    if (action === 'start') {
      if (!['inbox', 'todo', 'blocked', 'failed'].includes(t.status)) fail(409, 'invalid_transition', `Cannot start a task in ${t.status}`);
      const branch = t.branch ?? branchFor(t);
      touch(t, { status: 'in_progress', branch, worktree: branch ? `/Users/owner/.secondbrain/worktrees/${t.project_slug}/${t.id}` : null });
      startRun(t, 'start', t.kind === 'plan' ? 'tool_deferred' : 'end_turn');
      return json(200, t);
    }
    if (action === 'approve') {
      if (t.status !== 'review') fail(409, 'invalid_transition', `Cannot approve a task in ${t.status}`);
      deliver(t, findProject(t.project_slug).push_policy === 'after_merge');
      if (t.worktree) logEvent(t.id, 'task.worktree_removed', { path: t.worktree });
      touch(t, { status: 'done', worktree: null });
      return json(200, t);
    }
    if (action === 'merge') {
      if (t.status !== 'done' || t.merged_sha) fail(409, 'conflict', `task ${t.id} is not a done, unmerged task`);
      deliver(t, false);
      return json(200, t);
    }
    if (action === 'push') {
      if (!t.merged_sha) fail(409, 'conflict', `task ${t.id} has not been merged; nothing to push`);
      if (t.pushed_at) fail(409, 'conflict', `task ${t.id} was already pushed`);
      deliver(t, true);
      return json(200, t);
    }
    if (action === 'sync') {
      if (t.status === 'in_progress') fail(409, 'conflict', `task ${t.id} is running`);
      if (t.status === 'done') fail(409, 'conflict', `task ${t.id} is done`);
      if (!t.branch) fail(409, 'conflict', `task ${t.id} has no branch yet`);
      return json(200, { result: { status: 'up_to_date', base: 'main' }, task: t });
    }
    if (action === 'request-changes') {
      if (t.status !== 'review') fail(409, 'invalid_transition', `Cannot request changes on a task in ${t.status}`);
      const note = String(body.note ?? '').trim();
      if (!note) fail(400, 'invalid', 'note is required');
      touch(t, { status: 'in_progress' });
      startRun(t, 'resume', 'end_turn', `Changes requested: ${note}`);
      return json(200, t);
    }
    if (action === 'cancel') {
      if (t.status === 'done') fail(409, 'invalid_transition', 'Cannot cancel a finished task');
      killRun(t.id);
      touch(t, { status: 'blocked' });
      return json(200, t);
    }
  }
  if ((m = /^\/api\/tasks\/([^/]+)$/.exec(p))) {
    const t = findTask(m[1]);
    if (method === 'GET') {
      return json(200, {
        task: t,
        questions: db.questions.filter((q) => q.task_id === t.id).sort((a, b) => a.asked_at.localeCompare(b.asked_at)),
        runs: db.runs.filter((r) => r.task_id === t.id).sort((a, b) => a.started_at.localeCompare(b.started_at)),
        commits: db.commits[t.id] ?? [],
        events: db.events.filter((e) => e.task_id === t.id),
        messages: db.messages.filter((x) => x.task_id === t.id).map(messageView),
      });
    }
    if (method === 'PATCH') {
      const patch: Partial<Task> = {};
      if ('status' in body && body.status !== t.status) {
        const to = body.status as TaskStatus;
        const ok = (MANUAL.includes(t.status) && MANUAL.includes(to)) || (t.status === 'review' && to === 'done');
        if (!ok) fail(409, 'invalid_transition', `Cannot move a task from ${t.status} to ${to}`);
        patch.status = to;
      }
      if ('title' in body) {
        if (!String(body.title).trim()) fail(400, 'invalid', 'title cannot be empty');
        patch.title = String(body.title).trim();
      }
      if ('body' in body) patch.body = String(body.body);
      if ('priority' in body) {
        if (!PRIORITIES.includes(Number(body.priority))) fail(400, 'invalid', 'priority must be 1, 2 or 3');
        patch.priority = Number(body.priority) as Task['priority'];
      }
      if ('milestone' in body) patch.milestone_id = resolveMilestone(t.project_slug, body.milestone);
      if ('depends_on' in body) {
        patch.depends_on = [...new Set(body.depends_on as string[])].sort();
        patch.waiting_on = patch.depends_on.filter((d) => !db.tasks.find((x) => x.id === d)?.merged_sha);
      }
      touch(t, patch);
      return json(200, t);
    }
  }

  // Task thread
  if ((m = /^\/api\/tasks\/([^/]+)\/messages(\/read)?$/.exec(p))) {
    const t = findTask(m[1]);
    if (m[2] && method === 'POST') {
      let marked = 0;
      for (const x of db.messages) if (x.task_id === t.id && x.author === 'agent' && !x.read_at) (x.read_at = nowIso()), marked++;
      touch(t, {});
      return json(200, { marked });
    }
    if (!m[2] && method === 'GET') return json(200, db.messages.filter((x) => x.task_id === t.id).map(messageView));
    if (!m[2] && method === 'POST') {
      const text = String(body.body ?? '').trim();
      if (!text) fail(400, 'bad_request', 'body is required');
      if (t.status === 'done') fail(409, 'conflict', `task ${t.id} is done; create a new task instead`);
      const msg: TaskMessage = { id: db.newId('m'), task_id: t.id, task_title: t.title, project_slug: t.project_slug, author: 'owner', kind: 'message', title: '', body: text, status: null, note: null, created_at: nowIso(), read_at: null, delivered_at: null, resolved_at: null };
      db.messages.push(msg);
      emit('task.message', messageView(msg));
      logEvent(t.id, 'message.created', { message_id: msg.id, author: 'owner', kind: 'message' });
      if (t.status === 'in_progress') {
        // Pretend the agent picks it up at its next tool call and acknowledges it.
        setTimeout(() => {
          msg.delivered_at = nowIso();
          emit('task.message', messageView(msg));
          const ack: TaskMessage = { ...msg, id: db.newId('m'), author: 'agent', kind: 'update', title: 'Got it', body: `Adjusting the plan: “${text.slice(0, 80)}”`, delivered_at: nowIso(), created_at: nowIso() };
          db.messages.push(ack);
          emit('task.message', messageView(ack));
          touch(t, {});
        }, 3000);
      } else if (t.status === 'review' || (t.status === 'waiting_for_human' && t.waiting_for)) {
        msg.delivered_at = nowIso();
        touch(t, { status: 'in_progress', waiting_for: null });
        startRun(t, 'resume', 'end_turn', `Owner: ${text}`);
      }
      touch(t, {});
      return json(201, { message: messageView(msg), task: t });
    }
  }
  if (p === '/api/messages' && method === 'GET') {
    return json(
      200,
      db.messages
        .filter((x) => (x.kind === 'action' && x.status === 'open') || (x.author === 'agent' && x.kind === 'update' && !x.read_at))
        .map(messageView)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    );
  }
  if ((m = /^\/api\/messages\/([^/]+)\/resolve$/.exec(p)) && method === 'POST') {
    const msg = db.messages.find((x) => x.id === m![1]) ?? fail(404, 'not_found', `message ${m[1]} not found`);
    if (msg.kind !== 'action') fail(400, 'bad_request', `message ${msg.id} is not an action`);
    if (msg.status !== 'open') fail(409, 'conflict', `action ${msg.id} is already ${msg.status}`);
    const status = body.status;
    if (status !== 'done' && status !== 'declined') fail(400, 'bad_request', 'status must be done or declined');
    Object.assign(msg, { status, note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null, resolved_at: nowIso(), read_at: msg.read_at ?? nowIso(), delivered_at: null });
    emit('task.message', messageView(msg));
    logEvent(msg.task_id, 'message.updated', { message_id: msg.id });
    const t = findTask(msg.task_id);
    if (t.status === 'waiting_for_human' && t.waiting_for) {
      msg.delivered_at = nowIso();
      touch(t, { status: 'in_progress', waiting_for: null });
      startRun(t, 'resume', 'end_turn', `Action ${msg.id}: ${status}`);
    } else touch(t, {});
    return json(200, { message: messageView(msg), task: t });
  }

  // Questions
  if (p === '/api/questions' && method === 'GET') {
    const open = url.searchParams.get('open') === 'true';
    return json(
      200,
      db.questions.filter((q) => !open || q.answer === null).sort((a, b) => b.asked_at.localeCompare(a.asked_at)),
    );
  }
  if ((m = /^\/api\/questions\/([^/]+)\/answer$/.exec(p)) && method === 'POST') {
    const q = db.questions.find((x) => x.id === m![1]) ?? fail(404, 'not_found', 'Question not found');
    if (q.answer) fail(409, 'already_answered', 'This question was already answered');
    const answers = body.answers as Answer[] | undefined;
    if (!Array.isArray(answers) || answers.length === 0) fail(400, 'invalid', 'answers must be a non-empty array');
    q.answer = answers!;
    q.answered_at = nowIso();
    emit('question.answered', clone(q));
    const t = db.tasks.find((x) => x.id === q.task_id);
    if (t && t.status === 'waiting_for_human') {
      touch(t, { status: 'in_progress' });
      startRun(t, 'resume', 'end_turn', `Answers: ${answers!.map((a) => a.answer).join(' / ')}`);
    }
    return json(200, q);
  }

  // Runs
  if ((m = /^\/api\/runs\/([^/]+)\/log$/.exec(p)) && method === 'GET') {
    const run = db.runs.find((r) => r.id === m![1]) ?? fail(404, 'not_found', 'Run not found');
    const after = Number(url.searchParams.get('after') ?? 0);
    const lines = db.runLogs[run.id] ?? [];
    return json(200, { lines: lines.slice(after), next: lines.length });
  }
  if ((m = /^\/api\/runs\/([^/]+)$/.exec(p)) && method === 'GET') {
    return json(200, db.runs.find((r) => r.id === m![1]) ?? fail(404, 'not_found', 'Run not found'));
  }

  // Knowledge
  if (p === '/api/knowledge' && method === 'GET') {
    const scope = url.searchParams.get('scope');
    const list = Object.keys(db.notes)
      .map(noteMeta)
      .filter((n) => !scope || n.scope === scope)
      .sort((a, b) => a.path.localeCompare(b.path));
    return json(200, list);
  }
  if (p === '/api/knowledge/search' && method === 'GET') {
    const term = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const scope = url.searchParams.get('scope');
    if (!term) return json(200, []);
    const hits = Object.entries(db.notes)
      .filter(([path, c]) => (!scope || scopeOf(path) === scope) && (c.toLowerCase().includes(term) || path.includes(term)))
      .map(([path, c]) => {
        const i = Math.max(0, c.toLowerCase().indexOf(term));
        const snippet = (i > 30 ? '…' : '') + c.slice(Math.max(0, i - 30), i + term.length + 60).replace(/\s+/g, ' ') + '…';
        const meta = noteMeta(path);
        return { path, title: meta.title, scope: meta.scope, snippet };
      });
    return json(200, hits);
  }
  if (p === '/api/knowledge/note') {
    const path = method === 'PUT' ? String(body.path ?? '') : (url.searchParams.get('path') ?? '');
    if (method === 'GET') {
      if (!(path in db.notes)) fail(404, 'not_found', `No note at ${path}`);
      return json(200, { path, scope: scopeOf(path), frontmatter: parseFrontmatter(db.notes[path]), content: db.notes[path] });
    }
    if (method === 'PUT') {
      if (!validNotePath(path)) fail(400, 'invalid_path', 'path must be knowledge/*.md, groups/<slug>/knowledge/*.md or projects/<slug>/knowledge/*.md');
      db.notes[path] = stampUpdated(String(body.content ?? ''), path in db.notes ? db.notes[path] : null);
      emit('knowledge.changed', { path });
      return json(200, noteMeta(path));
    }
    if (method === 'DELETE') {
      if (!(path in db.notes)) fail(404, 'not_found', `No note at ${path}`);
      delete db.notes[path];
      emit('knowledge.changed', { path });
      return { status: 204, contentType: '', body: '' };
    }
  }

  return err(404, 'not_found', `${method} ${p} is not part of the contract`);
}

export async function mockFetch(method: string, path: string, body?: unknown): Promise<RawResponse> {
  await sleep(LATENCY_MS);
  try {
    // Bodies are serialised to JSON, so the UI never holds references into the mock "database".
    return route(method, new URL(path, 'http://mock'), (body ?? {}) as Body);
  } catch (e) {
    if (e instanceof HttpError) return err(e.status, e.code, e.message);
    return err(500, 'internal', (e as Error).message);
  }
}
