import { newId, now } from '../db/client.ts';
import type { Ctx } from './context.ts';
import { publish, recordEvent } from './events.ts';
import { getTask, type TaskRow } from './tasks.ts';
import { badRequest, conflict, notFound, type ActionStatus, type TaskMessage } from './types.ts';

/**
 * The task thread (docs/07-task-thread.md): updates and to-dos the agent posts without stopping, and
 * messages the owner sends into the session. A row is "pending" for the agent while `delivered_at` is
 * NULL: an owner message not yet shown to the agent, or an action the owner resolved since.
 */

const SELECT = `SELECT m.*, t.title AS task_title, t.project_slug AS project_slug FROM task_messages m JOIN tasks t ON t.id = m.task_id`;

export function findMessage(ctx: Ctx, id: string): TaskMessage | undefined {
  return ctx.db.prepare(`${SELECT} WHERE m.id = ?`).get(id) as TaskMessage | undefined;
}

export function getMessage(ctx: Ctx, id: string): TaskMessage {
  const m = findMessage(ctx, id);
  if (!m) throw notFound(`message ${id}`);
  return m;
}

/** Oldest first, like a chat. */
export function listMessages(ctx: Ctx, taskId: string): TaskMessage[] {
  return ctx.db.prepare(`${SELECT} WHERE m.task_id = ? ORDER BY m.created_at, m.rowid`).all(taskId) as unknown as TaskMessage[];
}

/** What the owner still has to look at, across tasks: open actions and unread updates, newest first. */
export function inboxMessages(ctx: Ctx): TaskMessage[] {
  return ctx.db
    .prepare(
      `${SELECT} WHERE (m.kind = 'action' AND m.status = 'open') OR (m.author = 'agent' AND m.kind = 'update' AND m.read_at IS NULL)
       ORDER BY m.created_at DESC, m.rowid DESC`,
    )
    .all() as unknown as TaskMessage[];
}

function changed(ctx: Ctx, m: TaskMessage, type: 'message.created' | 'message.updated'): TaskMessage {
  recordEvent(ctx, m.task_id, type, { message_id: m.id, kind: m.kind, author: m.author });
  const out = getMessage(ctx, m.id);
  publish('task.message', out);
  return out;
}

function insert(ctx: Ctx, taskId: string, row: { author: 'agent' | 'owner'; kind: TaskMessage['kind']; title: string; body: string; status: ActionStatus | null; delivered: boolean }): TaskMessage {
  const id = newId('m');
  const t = now();
  ctx.db
    .prepare('INSERT INTO task_messages (id, task_id, author, kind, title, body, status, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, taskId, row.author, row.kind, row.title, row.body, row.status, t, row.delivered ? t : null);
  return changed(ctx, getMessage(ctx, id), 'message.created');
}

/** The agent shares something (update) or hands the owner a to-do (action). Nothing waits on it. */
export function postAgentMessage(ctx: Ctx, taskId: string, input: { kind: 'update' | 'action'; title: string; body?: string }): TaskMessage {
  getTask(ctx, taskId);
  const title = input.title?.trim();
  if (!title) throw badRequest('title is required');
  return insert(ctx, taskId, { author: 'agent', kind: input.kind, title, body: input.body?.trim() ?? '', status: input.kind === 'action' ? 'open' : null, delivered: true });
}

/** Stores an owner message as pending for the agent. Delivery depends on the task's state (Orchestrator.message). */
export function addOwnerMessage(ctx: Ctx, taskId: string, body: string): TaskMessage {
  const task = getTask(ctx, taskId);
  if (task.status === 'done') throw conflict(`task ${taskId} is done; create a new task instead`);
  if (typeof body !== 'string' || !body.trim()) throw badRequest('body is required');
  return insert(ctx, taskId, { author: 'owner', kind: 'message', title: '', body: body.trim(), status: null, delivered: false });
}

/** The owner marks an agent action done or declined; the resolution becomes pending for the agent. */
export function resolveAction(ctx: Ctx, id: string, status: ActionStatus, note?: string | null): TaskMessage {
  const m = getMessage(ctx, id);
  if (m.kind !== 'action') throw badRequest(`message ${id} is not an action`);
  if (status !== 'done' && status !== 'declined') throw badRequest('status must be done or declined');
  if (m.status !== 'open') throw conflict(`action ${id} is already ${m.status}`);
  const t = now();
  ctx.db
    .prepare('UPDATE task_messages SET status = ?, note = ?, resolved_at = ?, read_at = COALESCE(read_at, ?), delivered_at = NULL WHERE id = ?')
    .run(status, note?.trim() || null, t, t, id);
  return changed(ctx, m, 'message.updated');
}

/** The owner has seen the agent's messages of a task. Returns how many were newly marked. */
export function markRead(ctx: Ctx, taskId: string): number {
  getTask(ctx, taskId);
  const r = ctx.db.prepare(`UPDATE task_messages SET read_at = ? WHERE task_id = ? AND author = 'agent' AND read_at IS NULL`).run(now(), taskId);
  const n = Number(r.changes);
  if (n) recordEvent(ctx, taskId, 'message.read', { count: n });
  return n;
}

export function pendingForAgent(ctx: Ctx, taskId: string): TaskMessage[] {
  return ctx.db.prepare(`${SELECT} WHERE m.task_id = ? AND m.delivered_at IS NULL ORDER BY m.created_at, m.rowid`).all(taskId) as unknown as TaskMessage[];
}

export function markDelivered(ctx: Ctx, ids: string[]): void {
  if (!ids.length) return;
  ctx.db.prepare(`UPDATE task_messages SET delivered_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(now(), ...ids);
}

/** How pending owner input reads to the agent. */
export function formatForAgent(rows: TaskMessage[]): string {
  return rows
    .map((m) =>
      m.kind === 'action'
        ? `- Your request "${m.title}" (${m.id}) was marked ${m.status} by the owner${m.note ? `: ${m.note}` : '.'}`
        : `- The owner wrote: ${m.body.replace(/\n/g, '\n  ')}`,
    )
    .join('\n');
}

/** Takes the pending owner input of a task (marking it delivered) as one block of text, or null if there is none. */
export function takePending(ctx: Ctx, taskId: string): string | null {
  const rows = pendingForAgent(ctx, taskId);
  if (!rows.length) return null;
  markDelivered(
    ctx,
    rows.map((r) => r.id),
  );
  for (const r of rows) recordEvent(ctx, taskId, 'message.delivered', { message_id: r.id });
  return `Second Brain: new input from the owner on this task.\n${formatForAgent(rows)}`;
}

/**
 * Whether the agent's wait_for_owner can return: the action it named is resolved, or there is pending
 * owner input of any kind (a message may tell it to do something else).
 */
export function waitReady(ctx: Ctx, taskId: string, actionId: string | null | undefined): boolean {
  if (actionId) {
    const a = findMessage(ctx, actionId);
    if (!a || a.task_id !== taskId || a.status !== 'open') return true;
  }
  return pendingForAgent(ctx, taskId).length > 0;
}

/** True when the task is parked on wait_for_owner and the owner has since given what it waits for. */
export function waitSatisfied(ctx: Ctx, task: TaskRow): boolean {
  return task.status === 'waiting_for_human' && !!task.waiting_for && waitReady(ctx, task.id, task.waiting_for.action_id);
}
