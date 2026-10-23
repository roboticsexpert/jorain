import { EventEmitter } from 'node:events';
import { now } from '../db/client.ts';
import type { BrainEvent } from './types.ts';
import type { Ctx } from './context.ts';

/**
 * In-process bus for live updates (SSE). Persisted events also go to the `events` table, which the
 * server polls so that changes made by other processes (CLI, brain MCP server) reach the UI too.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export interface LiveMessage {
  type: string;
  data: unknown;
}

/** Ids of events this process already published live, so the poller does not repeat them. */
export const publishedLocally = new Set<number>();

export function publish(type: string, data: unknown): void {
  bus.emit('message', { type, data } satisfies LiveMessage);
}

export function recordEvent(ctx: Ctx, taskId: string | null, type: string, payload: Record<string, unknown> = {}): number {
  const r = ctx.db
    .prepare('INSERT INTO events (task_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
    .run(taskId, type, JSON.stringify(payload), now());
  const id = Number(r.lastInsertRowid);
  publishedLocally.add(id);
  return id;
}

const toEvent = (r: any): BrainEvent => ({ ...r, payload: JSON.parse(r.payload) });

export function listEvents(ctx: Ctx, taskId: string): BrainEvent[] {
  return (ctx.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id').all(taskId) as any[]).map(toEvent);
}

export function eventsAfter(ctx: Ctx, id: number): BrainEvent[] {
  return (ctx.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500').all(id) as any[]).map(toEvent);
}

export function lastEventId(ctx: Ctx): number {
  return (ctx.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get() as { id: number }).id;
}
