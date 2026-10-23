import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { newId, now } from '../db/client.ts';
import type { Ctx } from './context.ts';
import { publish, recordEvent } from './events.ts';
import { notFound, type Run } from './types.ts';

const toRun = (r: any): Run => {
  const { pid: _pid, ...run } = r;
  return { ...run, usage: r.usage ? JSON.parse(r.usage) : null };
};

export function createRun(ctx: Ctx, taskId: string, sessionId: string, kind: Run['kind']): Run {
  const id = newId('r', 8);
  const dir = path.join(ctx.cfg.brainDir, 'runs', taskId);
  mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${id}.jsonl`);
  ctx.db
    .prepare('INSERT INTO runs (id, task_id, session_id, kind, started_at, log_path) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, taskId, sessionId, kind, now(), logPath);
  recordEvent(ctx, taskId, 'run.started', { run_id: id, kind });
  const run = getRun(ctx, id);
  publish('run.started', run);
  return run;
}

export function endRun(
  ctx: Ctx,
  id: string,
  r: { exit_code: number | null; stop_reason: string | null; usage?: unknown; cost_usd?: number | null },
): Run {
  ctx.db
    .prepare('UPDATE runs SET ended_at = ?, exit_code = ?, stop_reason = ?, usage = ?, cost_usd = ? WHERE id = ?')
    .run(now(), r.exit_code, r.stop_reason, r.usage == null ? null : JSON.stringify(r.usage), r.cost_usd ?? null, id);
  const run = getRun(ctx, id);
  recordEvent(ctx, run.task_id, 'run.ended', { run_id: id, stop_reason: r.stop_reason, exit_code: r.exit_code, cost_usd: r.cost_usd ?? null });
  publish('run.ended', run);
  return run;
}

export function getRun(ctx: Ctx, id: string): Run {
  const r = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  if (!r) throw notFound(`run ${id}`);
  return toRun(r);
}

export function listRuns(ctx: Ctx, taskId: string): Run[] {
  return (ctx.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at, rowid').all(taskId) as any[]).map(toRun);
}

export function setRunPid(ctx: Ctx, id: string, pid: number | undefined): void {
  ctx.db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(pid ?? null, id);
}

/** Runs without an end, with the pid of the process that owns them (the server or a foreground CLI). */
export function openRuns(ctx: Ctx): (Run & { pid: number | null })[] {
  return (ctx.db.prepare('SELECT * FROM runs WHERE ended_at IS NULL').all() as any[]).map((r) => ({ ...toRun(r), pid: r.pid }));
}

/** Raw stream-json lines of a run from index `after`. */
export function readRunLog(ctx: Ctx, id: string, after = 0): { lines: string[]; next: number } {
  const run = getRun(ctx, id);
  if (!existsSync(run.log_path)) return { lines: [], next: after };
  const all = readFileSync(run.log_path, 'utf8').split('\n');
  if (all[all.length - 1] === '') all.pop();
  const start = Math.max(0, after);
  return { lines: all.slice(start), next: Math.max(start, all.length) };
}

/** One readable line per stream-json event (for `brain task log` and the owner MCP server). */
export function digestLogLine(line: string): string {
  try {
    const m = JSON.parse(line);
    if (m.type === 'system') return `· system ${m.subtype ?? ''}`;
    if (m.type === 'assistant') {
      return (m.message?.content ?? [])
        .map((b: any) => (b.type === 'text' ? `assistant: ${b.text}` : b.type === 'tool_use' ? `→ ${b.name} ${JSON.stringify(b.input).slice(0, 200)}` : `· ${b.type}`))
        .join('\n');
    }
    if (m.type === 'user') {
      return (m.message?.content ?? [])
        .filter((b: any) => b.type === 'tool_result')
        .map((b: any) => `← ${b.is_error ? 'ERROR ' : ''}${(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 300)}`)
        .join('\n');
    }
    if (m.type === 'result') return `= result ${m.subtype} stop=${m.stop_reason ?? ''} turns=${m.num_turns ?? '?'} cost=$${m.total_cost_usd ?? '?'}\n${m.result ?? ''}`;
    if (m.type === 'brain_stderr') return `! stderr: ${m.text}`;
    return `· ${m.type}`;
  } catch {
    return line;
  }
}
