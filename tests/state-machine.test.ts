import { describe, expect, it } from 'vitest';
import { createProject } from '../src/core/projects.ts';
import { approveTask, canSetManually, canTransition, createTask, getTask, listTasks, nextRunnable, transition, updateTask, TRANSITIONS } from '../src/core/tasks.ts';
import { listEvents } from '../src/core/events.ts';
import { TASK_STATUSES } from '../src/core/types.ts';
import { tempCtx } from './helpers.ts';

describe('task state machine', () => {
  it('follows the documented happy path', () => {
    const path = ['inbox', 'todo', 'in_progress', 'waiting_for_human', 'in_progress', 'review', 'done'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
  });

  it('has an entry for every status and done is terminal', () => {
    for (const s of TASK_STATUSES) expect(TRANSITIONS[s]).toBeDefined();
    expect(TRANSITIONS.done).toEqual([]);
  });

  it('rejects skipping straight to review or done', () => {
    expect(canTransition('todo', 'review')).toBe(false);
    expect(canTransition('in_progress', 'done')).toBe(false);
    expect(canTransition('waiting_for_human', 'review')).toBe(false);
  });

  it('limits manual changes to inbox/todo/blocked and review → done', () => {
    expect(canSetManually('inbox', 'todo')).toBe(true);
    expect(canSetManually('todo', 'blocked')).toBe(true);
    expect(canSetManually('blocked', 'inbox')).toBe(true);
    expect(canSetManually('review', 'done')).toBe(true);
    expect(canSetManually('todo', 'in_progress')).toBe(false);
    expect(canSetManually('in_progress', 'blocked')).toBe(false);
    expect(canSetManually('failed', 'todo')).toBe(false);
  });
});

describe('tasks over the DB', () => {
  const setup = () => {
    const ctx = tempCtx();
    createProject(ctx, { slug: 'p1', name: 'P1', default_mode: 'assisted' });
    createProject(ctx, { slug: 'p2', name: 'P2' });
    return ctx;
  };

  it('creates tasks with project defaults and validates input', () => {
    const ctx = setup();
    const t = createTask(ctx, { project_slug: 'p1', title: ' Write docs ' });
    expect(t).toMatchObject({ title: 'Write docs', mode: 'assisted', status: 'inbox', priority: 2, question_count: 0 });
    expect(t.id).toMatch(/^t_[a-z0-9]{6}$/);
    expect(() => createTask(ctx, { project_slug: 'p1', title: 'x', status: 'review' as any })).toThrow(/inbox or todo/);
    expect(() => createTask(ctx, { project_slug: 'nope', title: 'x' })).toThrow(/not found/);
    expect(() => createTask(ctx, { project_slug: 'p1', title: '' })).toThrow(/title/);
    expect(() => createTask(ctx, { project_slug: 'p1', title: 'x', priority: 7 as any })).toThrow(/priority/);
  });

  it('PATCH rules: 409 for status changes outside the manual set', () => {
    const ctx = setup();
    const t = createTask(ctx, { project_slug: 'p2', title: 'a' });
    expect(updateTask(ctx, t.id, { status: 'todo', priority: 3 }).status).toBe('todo');
    expect(() => updateTask(ctx, t.id, { status: 'in_progress' })).toThrow(expect.objectContaining({ status: 409 }));
    transition(ctx, t.id, 'in_progress');
    transition(ctx, t.id, 'review');
    expect(updateTask(ctx, t.id, { status: 'done' }).status).toBe('done');
    expect(() => transition(ctx, t.id, 'todo')).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('approve only from review, and records events', () => {
    const ctx = setup();
    const t = createTask(ctx, { project_slug: 'p2', title: 'a', status: 'todo' });
    expect(() => approveTask(ctx, t.id)).toThrow(expect.objectContaining({ status: 409 }));
    transition(ctx, t.id, 'in_progress');
    transition(ctx, t.id, 'review');
    expect(approveTask(ctx, t.id).status).toBe('done');
    const types = listEvents(ctx, t.id).map((e) => [e.type, e.payload.to]);
    expect(types).toEqual([['task.created', undefined], ['task.status', 'in_progress'], ['task.status', 'review'], ['task.status', 'done']]);
  });

  it('filters lists and picks the next runnable auto task by priority, one per busy project', () => {
    const ctx = setup();
    createTask(ctx, { project_slug: 'p1', title: 'assisted', status: 'todo' });
    const low = createTask(ctx, { project_slug: 'p2', title: 'low', status: 'todo', priority: 1 });
    const high = createTask(ctx, { project_slug: 'p2', title: 'high', status: 'todo', priority: 3 });
    expect(nextRunnable(ctx, new Set())?.id).toBe(high.id);
    expect(nextRunnable(ctx, new Set(['p2']))).toBeUndefined();
    expect(listTasks(ctx, { project: 'p2', status: ['todo'] }).map((t) => t.id)).toEqual([high.id, low.id]);
    expect(getTask(ctx, low.id).priority).toBe(1);
  });
});
