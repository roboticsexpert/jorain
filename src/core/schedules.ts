import { newId, now } from '../db/client.ts';
import type { Ctx } from './context.ts';
import { nextCronTime, parseCron } from './cron.ts';
import { publish, recordEvent } from './events.ts';
import { getProject } from './projects.ts';
import { createTask, findTask, type TaskRow } from './tasks.ts';
import { badRequest, notFound, type Priority, type Schedule, type ScheduleKind, type TaskStatus } from './types.ts';

/**
 * Schedules queue a task from a template at a set time: `once` at `run_at` (e.g. "on 1 Nov check whether
 * the domain transfer went through"), or `recurring` whenever a cron expression matches (e.g. "every
 * Monday 09:00 check the error log"). The scheduler calls `fireDue` every tick; a fired schedule creates a
 * normal `todo` task (with `schedule_id`), which an auto task then runs like any other.
 *
 * - Missed times (server down) are caught up with one task, not one per missed time.
 * - A recurring schedule skips a time while its previous task is still queued or running, so slow
 *   runs don't pile up. A task waiting in review doesn't hold the next one back.
 * - A recurring task's prompt carries the previous run's result, so a check can say what changed.
 */

/** A previous task in one of these statuses holds the next occurrence back. */
const BUSY: TaskStatus[] = ['inbox', 'todo', 'in_progress', 'waiting_for_human'];

type Row = Omit<Schedule, 'enabled'> & { enabled: number };
const hydrate = (r: Row): Schedule => ({ ...r, enabled: !!r.enabled });

export function findSchedule(ctx: Ctx, id: string): Schedule | undefined {
  const r = ctx.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as unknown as Row | undefined;
  return r && hydrate(r);
}

export function getSchedule(ctx: Ctx, id: string): Schedule {
  const s = findSchedule(ctx, id);
  if (!s) throw notFound(`schedule ${id}`);
  return s;
}

export function listSchedules(ctx: Ctx, filter: { project?: string } = {}): Schedule[] {
  const rows = filter.project
    ? ctx.db.prepare('SELECT * FROM schedules WHERE project_slug = ? ORDER BY enabled DESC, next_run_at IS NULL, next_run_at, created_at').all(filter.project)
    : ctx.db.prepare('SELECT * FROM schedules ORDER BY enabled DESC, next_run_at IS NULL, next_run_at, created_at').all();
  return (rows as unknown as Row[]).map(hydrate);
}

export interface ScheduleInput {
  project_slug: string;
  title: string;
  body?: string;
  priority?: Priority;
  kind: ScheduleKind;
  /** once: ISO date-time (with offset or Z) the task is queued at. */
  run_at?: string | null;
  /** recurring: five-field cron expression in the server's local time. */
  cron?: string | null;
  enabled?: boolean;
}

function checkRunAt(v: unknown): string {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw badRequest('run_at must be an ISO date-time, e.g. 2026-11-01T09:00:00+03:30');
  return new Date(v).toISOString();
}

function checkCron(v: unknown): string {
  if (typeof v !== 'string') throw badRequest('cron must be a string');
  parseCron(v);
  nextCronTime(v, new Date());
  return v.trim();
}

/** When the schedule should fire next, counted from `from`; null when there is nothing left to fire. */
function computeNext(s: Pick<Schedule, 'kind' | 'run_at' | 'cron' | 'enabled' | 'run_count'>, from: Date): string | null {
  if (!s.enabled) return null;
  if (s.kind === 'once') return s.run_count > 0 ? null : s.run_at;
  return nextCronTime(s.cron!, from).toISOString();
}

export function createSchedule(ctx: Ctx, input: ScheduleInput, source = 'owner'): Schedule {
  const project = getProject(ctx, input.project_slug);
  if (typeof input.title !== 'string' || !input.title.trim()) throw badRequest('title is required');
  if (input.body !== undefined && typeof input.body !== 'string') throw badRequest('body must be a string');
  const priority = input.priority ?? 2;
  if (![1, 2, 3].includes(priority)) throw badRequest('priority must be 1, 2 or 3');
  if (input.kind !== 'once' && input.kind !== 'recurring') throw badRequest('kind must be once or recurring');
  const run_at = input.kind === 'once' ? checkRunAt(input.run_at) : null;
  const cron = input.kind === 'recurring' ? checkCron(input.cron) : null;
  const enabled = input.enabled ?? true;
  const next = computeNext({ kind: input.kind, run_at, cron, enabled, run_count: 0 }, new Date());
  const id = newId('s');
  const ts = now();
  ctx.db
    .prepare(
      `INSERT INTO schedules (id, project_slug, title, body, priority, kind, run_at, cron, enabled, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, project.slug, input.title.trim(), input.body ?? '', priority, input.kind, run_at, cron, enabled ? 1 : 0, next, ts, ts);
  recordEvent(ctx, null, 'schedule.created', { id, project: project.slug, source });
  return emit(ctx, id);
}

export type SchedulePatch = Partial<Omit<ScheduleInput, 'project_slug'>>;

export function updateSchedule(ctx: Ctx, id: string, patch: SchedulePatch): Schedule {
  const s = getSchedule(ctx, id);
  const next: Schedule = { ...s };
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || !patch.title.trim()) throw badRequest('title is required');
    next.title = patch.title.trim();
  }
  if (patch.body !== undefined) {
    if (typeof patch.body !== 'string') throw badRequest('body must be a string');
    next.body = patch.body;
  }
  if (patch.priority !== undefined) {
    if (![1, 2, 3].includes(patch.priority)) throw badRequest('priority must be 1, 2 or 3');
    next.priority = patch.priority;
  }
  if (patch.kind !== undefined) {
    if (patch.kind !== 'once' && patch.kind !== 'recurring') throw badRequest('kind must be once or recurring');
    next.kind = patch.kind;
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw badRequest('enabled must be true or false');
    next.enabled = patch.enabled;
  }
  if (next.kind === 'once') {
    next.run_at = checkRunAt(patch.run_at !== undefined ? patch.run_at : s.run_at);
    next.cron = null;
    // A new time re-arms a one-off that already ran.
    if (patch.run_at !== undefined && next.run_at !== s.run_at) next.run_count = 0;
  } else {
    next.cron = checkCron(patch.cron !== undefined ? patch.cron : s.cron);
    next.run_at = null;
  }
  if (next.kind === 'once' && s.run_count > 0 && next.run_count === 0 && patch.enabled === undefined) next.enabled = true;
  next.next_run_at = computeNext(next, new Date());
  ctx.db
    .prepare(
      `UPDATE schedules SET title = ?, body = ?, priority = ?, kind = ?, run_at = ?, cron = ?, enabled = ?, next_run_at = ?, run_count = ?, updated_at = ? WHERE id = ?`,
    )
    .run(next.title, next.body, next.priority, next.kind, next.run_at, next.cron, next.enabled ? 1 : 0, next.next_run_at, next.run_count, now(), id);
  recordEvent(ctx, null, 'schedule.edited', { id, ...patch });
  return emit(ctx, id);
}

/** Deletes a schedule; tasks it already created stay. */
export function deleteSchedule(ctx: Ctx, id: string): void {
  const s = getSchedule(ctx, id);
  ctx.db.prepare('UPDATE tasks SET schedule_id = NULL WHERE schedule_id = ?').run(id);
  ctx.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  recordEvent(ctx, null, 'schedule.deleted', { id, project: s.project_slug });
  publish('schedule.deleted', { id, project_slug: s.project_slug });
}

function taskBody(s: Schedule, at: Date, previous: TaskRow | undefined): string {
  const when = s.kind === 'once' ? 'one-off' : `recurring, cron \`${s.cron}\``;
  const parts = [...(s.body.trim() ? [s.body.trim(), '', '---'] : []), `Scheduled task (${when}), queued ${at.toISOString()} by schedule ${s.id}.`];
  if (s.kind === 'recurring') {
    parts.push(
      previous?.result_summary
        ? `\nResult of the previous run (${previous.id}, ${previous.updated_at}):\n\n${previous.result_summary.trim()}\n\nSay what changed since then.`
        : '\nThis is the first run of this schedule.',
    );
  }
  return parts.join('\n').trim();
}

export type FireResult = { status: 'queued'; task: TaskRow } | { status: 'skipped'; reason: string; task_id: string };

/**
 * Queues this schedule's task now. `manual` (Run now) neither advances the schedule nor ends a one-off,
 * but still refuses while the previous task is queued or running.
 */
export function fireSchedule(ctx: Ctx, id: string, opts: { at?: Date; manual?: boolean } = {}): FireResult {
  const s = getSchedule(ctx, id);
  const at = opts.at ?? new Date();
  const previous = s.last_task_id ? findTask(ctx, s.last_task_id) : undefined;
  if (previous && BUSY.includes(previous.status)) {
    // Recurring: skip this time and wait for the next one. A one-off (after a Run now) just waits until that task is out of the way.
    if (!opts.manual && s.kind === 'recurring') {
      ctx.db.prepare('UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?').run(computeNext(s, at), now(), id);
      recordEvent(ctx, null, 'schedule.skipped', { id, task_id: previous.id, status: previous.status });
      emit(ctx, id);
    }
    return { status: 'skipped', reason: `previous task ${previous.id} is still ${previous.status}`, task_id: previous.id };
  }
  const task = createTask(
    ctx,
    { project_slug: s.project_slug, title: s.title, body: taskBody(s, at, previous), priority: s.priority, status: 'todo', depends_on: [] },
    `schedule:${s.id}`,
  );
  ctx.db.prepare('UPDATE tasks SET schedule_id = ? WHERE id = ?').run(s.id, task.id);
  const runCount = s.run_count + 1;
  const next = opts.manual ? s.next_run_at : computeNext({ ...s, run_count: runCount }, at);
  const enabled = s.kind === 'once' && !opts.manual ? false : s.enabled;
  ctx.db
    .prepare('UPDATE schedules SET last_run_at = ?, last_task_id = ?, run_count = ?, next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .run(at.toISOString(), task.id, runCount, enabled ? next : null, enabled ? 1 : 0, now(), id);
  recordEvent(ctx, task.id, 'schedule.fired', { id, manual: !!opts.manual });
  emit(ctx, id);
  return { status: 'queued', task: findTask(ctx, task.id)! };
}

/** Fires every enabled schedule whose time has come (on active projects). Returns what happened. */
export function fireDue(ctx: Ctx, at = new Date()): { schedule: Schedule; result: FireResult }[] {
  const due = ctx.db
    .prepare(
      `SELECT s.id FROM schedules s JOIN projects p ON p.slug = s.project_slug
       WHERE s.enabled = 1 AND s.next_run_at IS NOT NULL AND s.next_run_at <= ? AND p.status = 'active' ORDER BY s.next_run_at`,
    )
    .all(at.toISOString()) as { id: string }[];
  return due.map(({ id }) => {
    const result = fireSchedule(ctx, id, { at });
    return { schedule: getSchedule(ctx, id), result };
  });
}

function emit(ctx: Ctx, id: string): Schedule {
  const s = getSchedule(ctx, id);
  publish('schedule.updated', s);
  return s;
}
