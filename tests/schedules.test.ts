import { describe, expect, it } from 'vitest';
import { nextCronTime, nextCronTimes, parseCron } from '../src/core/cron.ts';
import { createProject } from '../src/core/projects.ts';
import { createSchedule, deleteSchedule, fireDue, fireSchedule, getSchedule, updateSchedule } from '../src/core/schedules.ts';
import { getTask, setTaskFields, transition } from '../src/core/tasks.ts';
import { tempCtx } from './helpers.ts';

// Local-time dates, like the cron evaluation.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe('cron', () => {
  it('finds the next matching minute', () => {
    expect(nextCronTime('0 9 * * *', at(2026, 10, 23, 8, 59))).toEqual(at(2026, 10, 23, 9, 0));
    expect(nextCronTime('0 9 * * *', at(2026, 10, 23, 9, 0))).toEqual(at(2026, 10, 24, 9, 0));
    expect(nextCronTime('*/15 * * * *', at(2026, 10, 23, 9, 7))).toEqual(at(2026, 10, 23, 9, 15));
    // 2026-10-23 is a Friday; next Monday 09:00.
    expect(nextCronTime('0 9 * * 1', at(2026, 10, 23, 12))).toEqual(at(2026, 10, 26, 9, 0));
    expect(nextCronTime('0 9 * * 1-5', at(2026, 10, 23, 12))).toEqual(at(2026, 10, 26, 9, 0));
    expect(nextCronTime('0 0 1 * *', at(2026, 10, 23))).toEqual(at(2026, 11, 1));
    expect(nextCronTime('@weekly', at(2026, 10, 23))).toEqual(at(2026, 10, 25));
    expect(nextCronTime('0 0 * * 7', at(2026, 10, 23))).toEqual(at(2026, 10, 25));
    expect(nextCronTime('0 0 29 2 *', at(2026, 10, 23))).toEqual(at(2028, 2, 29));
  });

  it('ORs day-of-month and day-of-week when both are set', () => {
    // the 1st, or any Monday
    expect(nextCronTimes('0 8 1 * 1', at(2026, 10, 23), 2)).toEqual([at(2026, 10, 26, 8), at(2026, 11, 1, 8)]);
  });

  it('rejects bad expressions', () => {
    expect(() => parseCron('0 9 * *')).toThrow(/5 fields/);
    expect(() => parseCron('60 * * * *')).toThrow(/outside/);
    expect(() => parseCron('a * * * *')).toThrow(/not a number/);
    expect(() => parseCron('5-1 * * * *')).toThrow(/backwards/);
    expect(() => nextCronTime('0 0 31 2 *', new Date())).toThrow(/never matches/);
  });
});

function setup() {
  const ctx = tempCtx({ BRAIN_TICK_MS: '100000' });
  createProject(ctx, { slug: 'p', name: 'P' });
  return ctx;
}

describe('schedules', () => {
  it('a one-off queues one todo task at its time, then turns itself off', () => {
    const ctx = setup();
    const s = createSchedule(ctx, { project_slug: 'p', title: 'Check the transfer', body: 'Did it arrive?', kind: 'once', run_at: '2026-11-01T09:00:00Z' });
    expect(s).toMatchObject({ enabled: true, next_run_at: '2026-11-01T09:00:00.000Z', run_count: 0 });

    expect(fireDue(ctx, new Date('2026-11-01T08:59:00Z'))).toEqual([]);
    const [fired] = fireDue(ctx, new Date('2026-11-01T09:00:30Z'));
    expect(fired.result.status).toBe('queued');
    const task = getTask(ctx, (fired.result as { task: { id: string } }).task.id);
    expect(task).toMatchObject({ status: 'todo', title: 'Check the transfer', schedule_id: s.id });
    expect(task.body).toMatch(/^Did it arrive\?/);
    expect(getSchedule(ctx, s.id)).toMatchObject({ enabled: false, next_run_at: null, run_count: 1, last_task_id: task.id });
    expect(fireDue(ctx, new Date('2026-11-02T00:00:00Z'))).toEqual([]);

    // A new time re-arms it.
    expect(updateSchedule(ctx, s.id, { run_at: '2026-12-01T09:00:00Z' })).toMatchObject({ enabled: true, run_count: 0, next_run_at: '2026-12-01T09:00:00.000Z' });
  });

  it('a recurring schedule catches up once, skips while its last task runs, and passes on the last result', () => {
    const ctx = setup();
    const s = createSchedule(ctx, { project_slug: 'p', title: 'Error log', kind: 'recurring', cron: '0 * * * *' });
    // Server was down for hours: one task, next run in the future.
    const now = new Date(Date.parse(s.next_run_at!) + 5 * 3_600_000 + 60_000);
    const first = fireDue(ctx, now);
    expect(first).toHaveLength(1);
    const t1 = (first[0].result as { task: { id: string } }).task.id;
    expect(Date.parse(getSchedule(ctx, s.id).next_run_at!)).toBeGreaterThan(now.getTime());
    expect(getTask(ctx, t1).body).toMatch(/first run/);

    // Next hour: t1 still todo → skipped, schedule moves on.
    const later = new Date(now.getTime() + 3_600_000);
    expect(fireDue(ctx, later)[0].result.status).toBe('skipped');
    expect(getSchedule(ctx, s.id).run_count).toBe(1);

    // t1 finished in review: the next one is queued and carries its result.
    transition(ctx, t1, 'in_progress');
    setTaskFields(ctx, t1, { result_summary: 'Two 500s in /api/pay.' });
    transition(ctx, t1, 'review');
    const third = fireDue(ctx, new Date(later.getTime() + 3_600_000));
    expect(third[0].result.status).toBe('queued');
    const t2 = getTask(ctx, (third[0].result as { task: { id: string } }).task.id);
    expect(t2.body).toMatch(/Two 500s in \/api\/pay\./);
    expect(getSchedule(ctx, s.id)).toMatchObject({ run_count: 2, last_task_id: t2.id, enabled: true });
  });

  it('run now keeps the schedule, disabled schedules never fire, delete keeps the tasks', () => {
    const ctx = setup();
    const s = createSchedule(ctx, { project_slug: 'p', title: 'Weekly', kind: 'recurring', cron: '0 9 * * 1' });
    const r = fireSchedule(ctx, s.id, { manual: true });
    expect(r.status).toBe('queued');
    expect(getSchedule(ctx, s.id).next_run_at).toBe(s.next_run_at);
    expect(fireSchedule(ctx, s.id, { manual: true })).toMatchObject({ status: 'skipped' });

    updateSchedule(ctx, s.id, { enabled: false });
    expect(getSchedule(ctx, s.id).next_run_at).toBeNull();
    expect(fireDue(ctx, new Date('2030-01-01T00:00:00Z'))).toEqual([]);

    const taskId = (r as { task: { id: string } }).task.id;
    deleteSchedule(ctx, s.id);
    expect(getTask(ctx, taskId)).toMatchObject({ status: 'todo', schedule_id: null });
  });

  it('validates input', () => {
    const ctx = setup();
    expect(() => createSchedule(ctx, { project_slug: 'p', title: 'x', kind: 'once' })).toThrow(/run_at/);
    expect(() => createSchedule(ctx, { project_slug: 'p', title: 'x', kind: 'recurring', cron: 'nope' })).toThrow(/5 fields/);
    expect(() => createSchedule(ctx, { project_slug: 'nope', title: 'x', kind: 'recurring', cron: '@daily' })).toThrow(/not found/);
  });
});
