import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Ctx } from '../core/context.ts';
import { bus, listEvents, type LiveMessage } from '../core/events.ts';
import * as knowledge from '../core/knowledge.ts';
import { getMessage, inboxMessages, listMessages, markRead } from '../core/messages.ts';
import { hasFts5 } from '../db/client.ts';
import { createMilestone, deleteMilestone, getMilestone, listMilestones, updateMilestone } from '../core/milestones.ts';
import { createPlanTask } from '../core/planning.ts';
import { portfolio } from '../core/portfolio.ts';
import { createProject, getProject, listProjects, projectMcp, readProjectDoc, updateProject, writeProjectDoc } from '../core/projects.ts';
import { getQuestion, listQuestions, validateAnswers } from '../core/questions.ts';
import { getRun, listRuns, readRunLog } from '../core/runs.ts';
import { nextCronTimes } from '../core/cron.ts';
import { createSchedule, deleteSchedule, fireSchedule, getSchedule, listSchedules, updateSchedule } from '../core/schedules.ts';
import { createTask, getTask, listTasks, parseStatuses, toPublicTask, updateTask } from '../core/tasks.ts';
import { badRequest, BrainError, conflict } from '../core/types.ts';
import * as deliver from '../runner/deliver.ts';
import * as git from '../runner/git.ts';
import type { Orchestrator } from '../runner/orchestrator.ts';
import { claudeVersion } from './claude-version.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export async function status(ctx: Ctx, orch: Orchestrator) {
  return { running: orch.runningCount(), concurrency: ctx.cfg.concurrency, claude_version: await claudeVersion(ctx.cfg.claudeBin), fts5: hasFts5() };
}

async function body(c: { req: { json(): Promise<any> } }): Promise<any> {
  try {
    const b = await c.req.json();
    if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new Error();
    return b;
  } catch {
    throw badRequest('body must be a JSON object');
  }
}

function taskDetail(ctx: Ctx, id: string) {
  const t = getTask(ctx, id);
  const project = getProject(ctx, t.project_slug);
  const commits = project.repo_path && t.branch && t.base_sha ? git.commitsBetween(project.repo_path, t.base_sha, t.branch) : [];
  return {
    task: toPublicTask(t),
    questions: listQuestions(ctx, { taskId: id }),
    runs: listRuns(ctx, id),
    commits,
    events: listEvents(ctx, id),
    messages: listMessages(ctx, id),
  };
}

export function createApp(ctx: Ctx, orch: Orchestrator): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof BrainError) return c.json({ error: { code: err.code, message: err.message } }, err.status as any);
    console.error('[server]', err);
    return c.json({ error: { code: 'internal', message: (err as Error).message } }, 500);
  });

  const api = new Hono();

  api.get('/status', async (c) => c.json(await status(ctx, orch)));

  // Projects
  api.get('/projects', (c) => c.json(listProjects(ctx)));
  api.post('/projects', async (c) => c.json(createProject(ctx, await body(c)), 201));
  api.get('/projects/:slug', (c) => c.json(getProject(ctx, c.req.param('slug'))));
  api.patch('/projects/:slug', async (c) => c.json(updateProject(ctx, c.req.param('slug'), await body(c))));
  api.get('/projects/:slug/mcp', (c) => c.json(projectMcp(ctx, c.req.param('slug'))));
  api.get('/projects/:slug/doc', (c) => c.json({ content: readProjectDoc(ctx, c.req.param('slug')) }));
  api.put('/projects/:slug/doc', async (c) => {
    const { content } = await body(c);
    if (typeof content !== 'string') throw badRequest('content must be a string');
    return c.json({ content: writeProjectDoc(ctx, c.req.param('slug'), content) });
  });
  api.post('/projects/:slug/plan', async (c) => {
    const b = c.req.header('content-type')?.includes('json') ? await body(c) : {};
    if (b.focus !== undefined && typeof b.focus !== 'string') throw badRequest('focus must be a string');
    let t = createPlanTask(ctx, c.req.param('slug'), { focus: b.focus });
    try {
      t = orch.start(t.id);
    } catch (err) {
      // At capacity: the scheduler starts it (it is an auto task in todo).
      if (!(err instanceof BrainError)) throw err;
    }
    return c.json(toPublicTask(t), 201);
  });

  // Milestones
  api.get('/projects/:slug/milestones', (c) => c.json(listMilestones(ctx, c.req.param('slug'))));
  api.post('/projects/:slug/milestones', async (c) => c.json(createMilestone(ctx, c.req.param('slug'), await body(c)), 201));
  api.get('/milestones/:id', (c) => c.json(getMilestone(ctx, c.req.param('id'))));
  api.patch('/milestones/:id', async (c) => c.json(updateMilestone(ctx, c.req.param('id'), await body(c))));
  api.delete('/milestones/:id', (c) => {
    deleteMilestone(ctx, c.req.param('id'));
    return c.body(null, 204);
  });

  // Schedules
  api.get('/schedules', (c) => c.json(listSchedules(ctx, { project: c.req.query('project') || undefined })));
  api.post('/schedules', async (c) => c.json(createSchedule(ctx, await body(c)), 201));
  api.get('/schedules/preview', (c) => c.json({ next: nextCronTimes(c.req.query('cron') ?? '', new Date(), 3).map((d) => d.toISOString()) }));
  api.get('/schedules/:id', (c) => c.json(getSchedule(ctx, c.req.param('id'))));
  api.patch('/schedules/:id', async (c) => c.json(updateSchedule(ctx, c.req.param('id'), await body(c))));
  api.delete('/schedules/:id', (c) => {
    deleteSchedule(ctx, c.req.param('id'));
    return c.body(null, 204);
  });
  api.post('/schedules/:id/run', (c) => {
    const r = fireSchedule(ctx, c.req.param('id'), { manual: true });
    if (r.status === 'skipped') throw conflict(r.reason);
    let t = r.task;
    try {
      t = orch.start(t.id);
    } catch (err) {
      // At capacity: the scheduler starts it.
      if (!(err instanceof BrainError)) throw err;
    }
    return c.json(toPublicTask(t), 201);
  });

  // Overview
  api.get('/portfolio', (c) => c.json(portfolio(ctx)));

  // Tasks
  api.get('/tasks', (c) => c.json(listTasks(ctx, { project: c.req.query('project') || undefined, status: parseStatuses(c.req.query('status')) }).map(toPublicTask)));
  api.post('/tasks', async (c) => c.json(toPublicTask(createTask(ctx, await body(c))), 201));
  api.get('/tasks/:id', (c) => c.json(taskDetail(ctx, c.req.param('id'))));
  api.patch('/tasks/:id', async (c) => c.json(toPublicTask(updateTask(ctx, c.req.param('id'), await body(c)))));
  api.post('/tasks/:id/start', (c) => c.json(toPublicTask(orch.start(c.req.param('id')))));
  api.post('/tasks/:id/approve', async (c) => c.json(toPublicTask(await deliver.approveAndPush(ctx, c.req.param('id')))));
  api.post('/tasks/:id/merge', (c) => c.json(toPublicTask(deliver.merge(ctx, c.req.param('id')))));
  api.post('/tasks/:id/push', async (c) => c.json(toPublicTask(await deliver.push(ctx, c.req.param('id')))));
  api.post('/tasks/:id/request-changes', async (c) => {
    const { note } = await body(c);
    if (typeof note !== 'string' || !note.trim()) throw badRequest('note is required');
    return c.json(toPublicTask(orch.requestChanges(c.req.param('id'), note.trim())));
  });
  api.post('/tasks/:id/sync', (c) => {
    const id = c.req.param('id');
    const result = orch.sync(id);
    return c.json({ result, task: toPublicTask(getTask(ctx, id)) });
  });
  api.post('/tasks/:id/cancel', (c) => c.json(toPublicTask(orch.cancel(c.req.param('id')))));
  api.get('/tasks/:id/diff', (c) => {
    const t = getTask(ctx, c.req.param('id'));
    const project = getProject(ctx, t.project_slug);
    const diff = project.repo_path && t.branch && t.base_sha ? git.diffBetween(project.repo_path, t.base_sha, t.branch) : '';
    return c.text(diff);
  });

  // Task thread (docs/07-task-thread.md)
  api.get('/tasks/:id/messages', (c) => {
    getTask(ctx, c.req.param('id'));
    return c.json(listMessages(ctx, c.req.param('id')));
  });
  api.post('/tasks/:id/messages', async (c) => {
    const { body: text } = await body(c);
    if (typeof text !== 'string' || !text.trim()) throw badRequest('body is required');
    const r = orch.message(c.req.param('id'), text);
    return c.json({ message: r.message, task: toPublicTask(r.task) }, 201);
  });
  api.post('/tasks/:id/messages/read', (c) => c.json({ marked: markRead(ctx, c.req.param('id')) }));
  api.get('/messages', (c) => c.json(inboxMessages(ctx)));
  api.post('/messages/:id/resolve', async (c) => {
    const id = c.req.param('id');
    getMessage(ctx, id);
    const { status: s, note } = await body(c);
    if (s !== 'done' && s !== 'declined') throw badRequest('status must be done or declined');
    if (note !== undefined && note !== null && typeof note !== 'string') throw badRequest('note must be a string');
    const r = orch.resolveAction(id, s, note);
    return c.json({ message: r.message, task: toPublicTask(r.task) });
  });

  // Questions
  api.get('/questions', (c) => c.json(listQuestions(ctx, { open: c.req.query('open') === 'true' })));
  api.post('/questions/:id/answer', async (c) => {
    const id = c.req.param('id');
    getQuestion(ctx, id);
    const { answers } = await body(c);
    return c.json(orch.answer(id, validateAnswers(answers)));
  });

  // Runs
  api.get('/runs/:id', (c) => c.json(getRun(ctx, c.req.param('id'))));
  api.get('/runs/:id/log', (c) => {
    const after = Number(c.req.query('after') ?? 0);
    return c.json(readRunLog(ctx, c.req.param('id'), Number.isFinite(after) ? after : 0));
  });

  // Knowledge
  api.get('/knowledge', (c) => c.json(knowledge.listNotes(ctx, knowledge.parseScope(c.req.query('scope')))));
  api.get('/knowledge/note', (c) => c.json(knowledge.readNote(ctx, c.req.query('path') ?? '')));
  api.put('/knowledge/note', async (c) => {
    const { path: p, content } = await body(c);
    return c.json(knowledge.putNote(ctx, p, knowledge.stampUpdated(ctx, p, content)));
  });
  api.delete('/knowledge/note', (c) => {
    knowledge.deleteNote(ctx, c.req.query('path') ?? '');
    return c.body(null, 204);
  });
  api.get('/knowledge/search', (c) => {
    const scope = knowledge.parseScope(c.req.query('scope'));
    return c.json(knowledge.searchKnowledge(ctx, c.req.query('q') ?? '', scope ? [scope] : undefined, 20));
  });

  // Live events
  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: LiveMessage[] = [];
      let wake: (() => void) | null = null;
      const onMsg = (m: LiveMessage) => {
        queue.push(m);
        wake?.();
      };
      bus.on('message', onMsg);
      const ping = setInterval(() => {
        stream.write(': ping\n\n').catch(() => {});
      }, 25_000);
      stream.onAbort(() => {
        bus.off('message', onMsg);
        clearInterval(ping);
        wake?.();
      });
      await stream.writeSSE({ event: 'status', data: JSON.stringify(await status(ctx, orch)) });
      while (!stream.aborted) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = null;
        while (queue.length && !stream.aborted) {
          const m = queue.shift()!;
          await stream.writeSSE({ event: m.type, data: JSON.stringify(m.data) });
        }
      }
      bus.off('message', onMsg);
      clearInterval(ping);
    }),
  );

  api.all('*', (c) => c.json({ error: { code: 'not_found', message: `no route ${c.req.method} ${c.req.path}` } }, 404));
  app.route('/api', api);

  // Web UI: web/dist with SPA fallback, or a notice when it has not been built.
  app.get('*', (c) => {
    const dist = ctx.cfg.webDist;
    const index = path.join(dist, 'index.html');
    if (!existsSync(index)) {
      return c.text('Second Brain API is running. The web UI is not built yet: run the web build so that web/dist exists, or use the dev server on :5173.\n');
    }
    const rel = decodeURIComponent(c.req.path).replace(/^\/+/, '');
    const file = path.resolve(dist, rel);
    if (rel && file.startsWith(dist + path.sep) && existsSync(file) && statSync(file).isFile()) {
      const type = MIME[path.extname(file)] ?? 'application/octet-stream';
      const cache = rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      return c.body(readFileSync(file), 200, { 'content-type': type, 'cache-control': cache });
    }
    return c.html(readFileSync(index, 'utf8'));
  });

  return app;
}
