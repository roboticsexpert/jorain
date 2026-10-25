import { newId, now } from '../db/client.ts';
import type { Ctx } from './context.ts';
import { publish, recordEvent } from './events.ts';
import { findMilestone, resolveMilestone } from './milestones.ts';
import { getProject } from './projects.ts';
import { badRequest, BrainError, conflict, notFound, TASK_STATUSES, type Priority, type Task, type TaskKind, type TaskStatus } from './types.ts';

/**
 * Task state machine. `inbox → todo → in_progress → waiting_for_human → in_progress → review → done`,
 * plus `blocked` (parked: cancelled, too many questions, cannot start) and `failed` (run error).
 */
export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ['todo', 'in_progress', 'blocked'],
  todo: ['inbox', 'in_progress', 'blocked'],
  in_progress: ['waiting_for_human', 'review', 'failed', 'blocked'],
  waiting_for_human: ['in_progress', 'blocked'],
  review: ['done', 'in_progress', 'blocked'],
  blocked: ['inbox', 'todo', 'in_progress'],
  failed: ['inbox', 'todo', 'in_progress', 'blocked'],
  done: [],
};

/** Status changes a person may make directly (PATCH); everything else happens through actions. */
export const MANUAL_STATUSES: TaskStatus[] = ['inbox', 'todo', 'blocked'];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function canSetManually(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  if (from === 'review' && to === 'done') return true;
  return MANUAL_STATUSES.includes(from) && MANUAL_STATUSES.includes(to) && canTransition(from, to);
}

/** Statuses a run can be started from (`POST /tasks/:id/start`). */
export const STARTABLE: TaskStatus[] = ['inbox', 'todo', 'blocked', 'failed'];

/**
 * A dependency `u` is met once it is done and its work is in the base branch: merged, no branch at all
 * (no repo), or approved with nothing to merge. A `done` task whose branch was never merged (closed by
 * hand, or approved by an outdated server) keeps its dependents waiting until `brain task merge`.
 */
const DEP_MET = `u.status = 'done' AND (u.merged_sha IS NOT NULL OR u.branch IS NULL OR EXISTS (
  SELECT 1 FROM events e WHERE e.task_id = u.id
    AND (e.type = 'task.merge_skipped' OR (e.type = 'task.status' AND json_extract(e.payload, '$.merge') IS NOT NULL))))`;
const UNMET_DEPS = `FROM task_deps d JOIN tasks u ON u.id = d.depends_on WHERE d.task_id = t.id AND NOT (${DEP_MET})`;

const SELECT = `SELECT t.*, (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id) AS question_count,
  (SELECT group_concat(d.depends_on) FROM task_deps d WHERE d.task_id = t.id) AS deps_csv,
  (SELECT group_concat(d.depends_on) ${UNMET_DEPS}) AS waiting_csv
  FROM tasks t`;

/** Internal row: the public Task plus git bookkeeping. */
export interface TaskRow extends Task {
  base_branch: string | null;
  base_sha: string | null;
}

type RawRow = Omit<TaskRow, 'depends_on' | 'waiting_on'> & { deps_csv: string | null; waiting_csv: string | null };

function hydrate(r: RawRow | undefined): TaskRow | undefined {
  if (!r) return undefined;
  const { deps_csv, waiting_csv, ...t } = r;
  const list = (csv: string | null) => (csv ? csv.split(',').sort() : []);
  return { ...t, depends_on: list(deps_csv), waiting_on: list(waiting_csv) };
}

export function toPublicTask(t: TaskRow): Task {
  const { base_branch: _b, base_sha: _s, ...pub } = t;
  return pub;
}

export function findTask(ctx: Ctx, id: string): TaskRow | undefined {
  return hydrate(ctx.db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as RawRow | undefined);
}

export function getTask(ctx: Ctx, id: string): TaskRow {
  const t = findTask(ctx, id);
  if (!t) throw notFound(`task ${id}`);
  return t;
}

export function listTasks(ctx: Ctx, filter: { project?: string; status?: TaskStatus[] } = {}): TaskRow[] {
  const where: string[] = [];
  const vals: string[] = [];
  if (filter.project) {
    where.push('t.project_slug = ?');
    vals.push(filter.project);
  }
  if (filter.status?.length) {
    where.push(`t.status IN (${filter.status.map(() => '?').join(',')})`);
    vals.push(...filter.status);
  }
  return (
    ctx.db
      .prepare(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC, t.rowid DESC`)
      .all(...vals) as unknown as RawRow[]
  ).map((r) => hydrate(r)!);
}

export function parseStatuses(s: string | undefined): TaskStatus[] | undefined {
  if (!s) return undefined;
  const list = s.split(',').map((x) => x.trim()).filter(Boolean);
  for (const x of list) if (!TASK_STATUSES.includes(x as TaskStatus)) throw badRequest(`unknown status ${x}`);
  return list as TaskStatus[];
}

function checkPriority(p: unknown): asserts p is Priority {
  if (![1, 2, 3].includes(p as number)) throw badRequest('priority must be 1, 2 or 3');
}

export interface TaskInput {
  project_slug: string;
  title: string;
  body?: string;
  priority?: Priority;
  status?: 'inbox' | 'todo';
  /** Tasks this one waits for: it is not started until each is done and merged. */
  depends_on?: string[];
  /** Milestone id or title within the project; null/omitted = none. */
  milestone?: string | null;
  /** `plan`: a planner run that shapes the project (PROJECT.md, milestones, next tasks) instead of changing code. */
  kind?: TaskKind;
}

function milestoneId(ctx: Ctx, project: string, ref: string | null | undefined): string | null {
  if (ref === undefined || ref === null || ref === '') return null;
  if (typeof ref !== 'string') throw badRequest('milestone must be a milestone id or title');
  return resolveMilestone(ctx, project, ref).id;
}

/** Validates a dependency list for `id`: known tasks, not itself, no cycle. Returns it deduplicated. */
function checkDeps(ctx: Ctx, id: string, deps: unknown): string[] {
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) throw badRequest('depends_on must be a list of task ids');
  const list = [...new Set(deps as string[])].sort();
  for (const d of list) {
    if (d === id) throw badRequest('a task cannot depend on itself');
    if (!findTask(ctx, d)) throw badRequest(`depends_on: unknown task ${d}`);
    if (dependsOn(ctx, d, id)) throw badRequest(`depends_on: ${d} already depends on ${id} (that would be a cycle)`);
  }
  return list;
}

function setDeps(ctx: Ctx, id: string, list: string[]): string[] {
  ctx.db.prepare('DELETE FROM task_deps WHERE task_id = ?').run(id);
  const ins = ctx.db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)');
  for (const d of list) ins.run(id, d);
  return list;
}

/** Whether `from` depends on `target`, directly or through other tasks. */
function dependsOn(ctx: Ctx, from: string, target: string): boolean {
  const next = ctx.db.prepare('SELECT depends_on FROM task_deps WHERE task_id = ?');
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of next.all(cur) as { depends_on: string }[]) stack.push(r.depends_on);
  }
  return false;
}

export function createTask(ctx: Ctx, input: TaskInput, source = 'owner'): TaskRow {
  const project = getProject(ctx, input.project_slug);
  if (!input.title?.trim()) throw badRequest('title is required');
  const priority = input.priority ?? 2;
  checkPriority(priority);
  const status = input.status ?? 'inbox';
  if (status !== 'inbox' && status !== 'todo') throw badRequest('status may only be inbox or todo');
  const kind = input.kind ?? 'work';
  if (kind !== 'work' && kind !== 'plan') throw badRequest('kind must be work or plan');
  const id = newId('t');
  const deps = input.depends_on !== undefined ? checkDeps(ctx, id, input.depends_on) : [];
  const milestone = milestoneId(ctx, project.slug, input.milestone);
  const ts = now();
  ctx.db
    .prepare(
      `INSERT INTO tasks (id, project_slug, title, body, status, priority, milestone_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, project.slug, input.title.trim(), input.body ?? '', status, priority, milestone, kind, ts, ts);
  setDeps(ctx, id, deps);
  recordEvent(ctx, id, 'task.created', { source, status, ...(kind === 'plan' ? { kind } : {}), ...(deps.length ? { depends_on: deps } : {}), ...(milestone ? { milestone_id: milestone } : {}) });
  return emit(ctx, id);
}

/** Re-reads the task and pushes it to live listeners. */
export function emit(ctx: Ctx, id: string): TaskRow {
  const t = getTask(ctx, id);
  publish('task.updated', toPublicTask(t));
  // Milestone progress counts this task.
  const m = t.milestone_id ? findMilestone(ctx, t.milestone_id) : undefined;
  if (m) publish('milestone.updated', m);
  return t;
}

/** Moves a task through the state machine (throws 409 on an illegal move) and records the event. */
export function transition(ctx: Ctx, id: string, to: TaskStatus, info: Record<string, unknown> = {}): TaskRow {
  const t = getTask(ctx, id);
  if (t.status === to) return t;
  if (!canTransition(t.status, to)) throw conflict(`task ${id} cannot go from ${t.status} to ${to}`);
  ctx.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(to, now(), id);
  recordEvent(ctx, id, 'task.status', { from: t.status, to, ...info });
  return emit(ctx, id);
}

type Settable =
  | 'branch'
  | 'base_branch'
  | 'base_sha'
  | 'session_id'
  | 'result_summary'
  | 'commit_count'
  | 'merged_sha'
  | 'merged_into'
  | 'merged_at'
  | 'pushed_at'
  | 'push_error'
  | 'worktree'
  | 'verify_status';

/** Bookkeeping fields written by the runner. */
export function setTaskFields(ctx: Ctx, id: string, fields: Partial<Pick<TaskRow, Settable>>): TaskRow {
  const keys = Object.keys(fields) as Settable[];
  if (keys.length) {
    ctx.db
      .prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k] ?? null), now(), id);
  }
  return emit(ctx, id);
}

export interface TaskPatch {
  title?: string;
  body?: string;
  priority?: Priority;
  status?: TaskStatus;
  depends_on?: string[];
  milestone?: string | null;
}

export function updateTask(ctx: Ctx, id: string, patch: TaskPatch): TaskRow {
  const t = getTask(ctx, id);
  const sets: string[] = [];
  const vals: any[] = [];
  const changes: Record<string, unknown> = {};
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
    changes[col] = v;
  };
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw badRequest('title is required');
    set('title', patch.title.trim());
  }
  if (patch.body !== undefined) set('body', patch.body);
  if (patch.priority !== undefined) {
    checkPriority(patch.priority);
    set('priority', patch.priority);
  }
  if (patch.milestone !== undefined) set('milestone_id', milestoneId(ctx, t.project_slug, patch.milestone));
  const deps = patch.depends_on !== undefined ? checkDeps(ctx, id, patch.depends_on) : undefined;
  if (patch.status !== undefined && patch.status !== t.status) {
    if (!TASK_STATUSES.includes(patch.status)) throw badRequest(`unknown status ${patch.status}`);
    if (!canSetManually(t.status, patch.status)) throw conflict(`status cannot be changed by hand from ${t.status} to ${patch.status}`);
  }
  if (deps) {
    changes.depends_on = setDeps(ctx, id, deps);
    if (!sets.length) ctx.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), id);
  }
  if (sets.length) ctx.db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now(), id);
  if (Object.keys(changes).length) recordEvent(ctx, id, 'task.edited', changes);
  if (patch.status !== undefined && patch.status !== t.status) return transition(ctx, id, patch.status, { by: 'owner' });
  return emit(ctx, id);
}

/** review → done without touching git. `src/runner/deliver.ts` wraps this with the squash merge and push. */
export function approveTask(ctx: Ctx, id: string, info: Record<string, unknown> = {}): TaskRow {
  const t = getTask(ctx, id);
  if (t.status !== 'review') throw conflict(`task ${id} is ${t.status}, not review`);
  return transition(ctx, id, 'done', { by: 'owner', action: 'approve', ...info });
}

/** Next todo task the scheduler may start: highest priority first, then oldest; never one waiting on a dependency. `busyProjects` are at capacity. */
export function nextRunnable(ctx: Ctx, busyProjects: Set<string>): TaskRow | undefined {
  const rows = ctx.db
    .prepare(
      `${SELECT} JOIN projects p ON p.slug = t.project_slug
       WHERE t.status = 'todo' AND p.status = 'active' AND NOT EXISTS (SELECT 1 ${UNMET_DEPS})
       ORDER BY t.priority DESC, t.created_at ASC, t.rowid ASC`,
    )
    .all() as unknown as RawRow[];
  return hydrate(rows.find((t) => !busyProjects.has(t.project_slug)));
}

export { BrainError };
