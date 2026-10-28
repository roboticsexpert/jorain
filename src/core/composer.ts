import { newId, now } from '../db/client.ts';
import type { Ctx } from './context.ts';
import { publish, recordEvent } from './events.ts';
import { siblings } from './groups.ts';
import { resolveMilestone } from './milestones.ts';
import { getProject } from './projects.ts';
import { createTask, findTask, type TaskRow } from './tasks.ts';
import { badRequest, conflict, notFound, type ComposerChat, type ComposerDraft, type ComposerMessage, type Priority } from './types.ts';

/**
 * Task composer (docs/08-task-composer.md): a chat per project where the owner talks an idea through
 * with a read-only Claude session. The session proposes tasks as drafts; only the owner turns a draft
 * into a real task, always into the inbox. A draft may target any project of the chat's group.
 */

export function findChat(ctx: Ctx, id: string): ComposerChat | undefined {
  return ctx.db.prepare('SELECT * FROM composer_chats WHERE id = ?').get(id) as ComposerChat | undefined;
}

export function getChat(ctx: Ctx, id: string): ComposerChat {
  const c = findChat(ctx, id);
  if (!c) throw notFound(`chat ${id}`);
  return c;
}

/** Newest first. */
export function listChats(ctx: Ctx, project?: string): ComposerChat[] {
  const sql = `SELECT * FROM composer_chats ${project ? 'WHERE project_slug = ?' : ''} ORDER BY updated_at DESC, rowid DESC`;
  return (project ? ctx.db.prepare(sql).all(project) : ctx.db.prepare(sql).all()) as unknown as ComposerChat[];
}

export function createChat(ctx: Ctx, project: string, title = ''): ComposerChat {
  getProject(ctx, project);
  const id = newId('c');
  const t = now();
  ctx.db.prepare('INSERT INTO composer_chats (id, project_slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, project, title.trim(), t, t);
  return chatChanged(ctx, id);
}

export function setChatFields(ctx: Ctx, id: string, fields: Partial<Pick<ComposerChat, 'title' | 'session_id' | 'status'>> & { add_cost?: number }): ComposerChat {
  const c = getChat(ctx, id);
  ctx.db
    .prepare('UPDATE composer_chats SET title = ?, session_id = ?, status = ?, cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?')
    .run(fields.title ?? c.title, fields.session_id !== undefined ? fields.session_id : c.session_id, fields.status ?? c.status, fields.add_cost ?? 0, now(), id);
  return chatChanged(ctx, id);
}

export function deleteChat(ctx: Ctx, id: string): void {
  const c = getChat(ctx, id);
  if (c.status === 'thinking') throw conflict(`chat ${id} is still answering`);
  ctx.db.exec('BEGIN');
  try {
    ctx.db.prepare('DELETE FROM composer_drafts WHERE chat_id = ?').run(id);
    ctx.db.prepare('DELETE FROM composer_messages WHERE chat_id = ?').run(id);
    ctx.db.prepare('DELETE FROM composer_chats WHERE id = ?').run(id);
    ctx.db.exec('COMMIT');
  } catch (err) {
    ctx.db.exec('ROLLBACK');
    throw err;
  }
  recordEvent(ctx, null, 'composer.deleted', { chat_id: id, project: c.project_slug });
  publish('composer.deleted', { id, project_slug: c.project_slug });
}

function chatChanged(ctx: Ctx, id: string): ComposerChat {
  recordEvent(ctx, null, 'composer.chat', { chat_id: id });
  const c = getChat(ctx, id);
  publish('composer.chat', c);
  return c;
}

export function listChatMessages(ctx: Ctx, chatId: string): ComposerMessage[] {
  return ctx.db.prepare('SELECT * FROM composer_messages WHERE chat_id = ? ORDER BY created_at, rowid').all(chatId) as unknown as ComposerMessage[];
}

export function addChatMessage(ctx: Ctx, chatId: string, role: ComposerMessage['role'], body: string): ComposerMessage {
  getChat(ctx, chatId);
  const id = newId('cm');
  ctx.db.prepare('INSERT INTO composer_messages (id, chat_id, role, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, chatId, role, body, now());
  const m = ctx.db.prepare('SELECT * FROM composer_messages WHERE id = ?').get(id) as unknown as ComposerMessage;
  recordEvent(ctx, null, 'composer.message', { message_id: id, chat_id: chatId });
  publish('composer.message', m);
  return m;
}

export function findChatMessage(ctx: Ctx, id: string): ComposerMessage | undefined {
  return ctx.db.prepare('SELECT * FROM composer_messages WHERE id = ?').get(id) as ComposerMessage | undefined;
}

// --- drafts ---

const toDraft = (r: any): ComposerDraft => ({ ...r, depends_on: JSON.parse(r.depends_on) });

/** The chat's project and its group siblings: where its drafts may go. */
export function chatProjects(ctx: Ctx, chatId: string): string[] {
  const slug = getChat(ctx, chatId).project_slug;
  return [slug, ...siblings(ctx, slug).map((p) => p.slug)];
}

/** Project a draft becomes a task in. */
export const draftProject = (ctx: Ctx, d: ComposerDraft): string => d.project_slug ?? getChat(ctx, d.chat_id).project_slug;

export function findDraft(ctx: Ctx, id: string): ComposerDraft | undefined {
  const r = ctx.db.prepare('SELECT * FROM composer_drafts WHERE id = ?').get(id);
  return r ? toDraft(r) : undefined;
}

export function getDraft(ctx: Ctx, id: string): ComposerDraft {
  const d = findDraft(ctx, id);
  if (!d) throw notFound(`draft ${id}`);
  return d;
}

export function listDrafts(ctx: Ctx, chatId: string): ComposerDraft[] {
  return (ctx.db.prepare('SELECT * FROM composer_drafts WHERE chat_id = ? ORDER BY created_at, rowid').all(chatId) as any[]).map(toDraft);
}

export interface DraftInput {
  /** Another project of the chat's group; omitted = the chat's project. */
  project?: string;
  title?: string;
  body?: string;
  priority?: Priority;
  milestone?: string | null;
  depends_on?: string[];
}

/** Validates the input against `project` (the draft's target project); returns that project. */
function checkDraftInput(ctx: Ctx, chatId: string, input: DraftInput, current?: string): string {
  const allowed = chatProjects(ctx, chatId);
  const project = input.project ?? current ?? allowed[0];
  if (!allowed.includes(project)) throw badRequest(`project ${project} is not part of this chat's group; drafts can go to ${allowed.join(', ')}`);
  if (input.title !== undefined && !input.title.trim()) throw badRequest('title is required');
  if (input.priority !== undefined && ![1, 2, 3].includes(input.priority)) throw badRequest('priority must be 1, 2 or 3');
  if (input.milestone) resolveMilestone(ctx, project, input.milestone);
  if (input.depends_on !== undefined) {
    if (!Array.isArray(input.depends_on) || input.depends_on.some((d) => typeof d !== 'string')) throw badRequest('depends_on must be a list of task or draft ids');
    for (const d of input.depends_on) {
      if (d.startsWith('d_')) {
        if (findDraft(ctx, d)?.chat_id !== chatId) throw badRequest(`depends_on: unknown draft ${d} in this chat`);
      } else if (!findTask(ctx, d)) throw badRequest(`depends_on: unknown task ${d}`);
    }
  }
  return project;
}

/** A new draft (the composer session's propose_task). */
export function addDraft(ctx: Ctx, chatId: string, input: DraftInput & { title: string }): ComposerDraft {
  const chat = getChat(ctx, chatId);
  const project = checkDraftInput(ctx, chatId, input);
  const id = newId('d');
  const t = now();
  ctx.db
    .prepare('INSERT INTO composer_drafts (id, chat_id, project_slug, title, body, priority, milestone, depends_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, chatId, project === chat.project_slug ? null : project, input.title.trim(), input.body ?? '', input.priority ?? 2, input.milestone || null, JSON.stringify([...new Set(input.depends_on ?? [])]), t, t);
  return draftChanged(ctx, id);
}

/** Edits a draft that is still open (by the owner, or by the session revising its own proposal). */
export function updateDraft(ctx: Ctx, id: string, patch: DraftInput): ComposerDraft {
  const d = getDraft(ctx, id);
  if (d.status !== 'draft') throw conflict(`draft ${id} is ${d.status}; only open drafts change`);
  const home = getChat(ctx, d.chat_id).project_slug;
  const project = checkDraftInput(ctx, d.chat_id, patch, draftProject(ctx, d));
  if (patch.depends_on?.includes(id)) throw badRequest('a draft cannot depend on itself');
  // A milestone belongs to one project: moving the draft drops it unless a new one is given.
  const moved = project !== draftProject(ctx, d);
  ctx.db
    .prepare('UPDATE composer_drafts SET project_slug = ?, title = ?, body = ?, priority = ?, milestone = ?, depends_on = ?, updated_at = ? WHERE id = ?')
    .run(
      project === home ? null : project,
      patch.title?.trim() ?? d.title,
      patch.body ?? d.body,
      patch.priority ?? d.priority,
      patch.milestone !== undefined ? patch.milestone || null : moved ? null : d.milestone,
      JSON.stringify(patch.depends_on ? [...new Set(patch.depends_on)] : d.depends_on),
      now(),
      id,
    );
  return draftChanged(ctx, id);
}

export function discardDraft(ctx: Ctx, id: string): ComposerDraft {
  const d = getDraft(ctx, id);
  if (d.status === 'created') throw conflict(`draft ${id} is already task ${d.task_id}`);
  ctx.db.prepare("UPDATE composer_drafts SET status = 'discarded', updated_at = ? WHERE id = ?").run(now(), id);
  return draftChanged(ctx, id);
}

function draftChanged(ctx: Ctx, id: string): ComposerDraft {
  const d = getDraft(ctx, id);
  recordEvent(ctx, null, 'composer.draft', { draft_id: id, chat_id: d.chat_id });
  publish('composer.draft', d);
  return d;
}

/**
 * Turns an open draft into an inbox task in its project. Draft dependencies must be created first (createAllDrafts orders
 * them); they map to the tasks those drafts became.
 */
export function createFromDraft(ctx: Ctx, id: string): { draft: ComposerDraft; task: TaskRow } {
  const d = getDraft(ctx, id);
  if (d.status !== 'draft') throw conflict(`draft ${id} is ${d.status}`);
  const chat = getChat(ctx, d.chat_id);
  const deps = d.depends_on.map((dep) => {
    if (!dep.startsWith('d_')) return dep;
    const other = getDraft(ctx, dep);
    if (other.status === 'created' && other.task_id) return other.task_id;
    if (other.status === 'discarded') return null;
    throw conflict(`"${d.title}" depends on draft "${other.title}" (${dep}); create that one first`);
  });
  const task = createTask(
    ctx,
    { project_slug: draftProject(ctx, d), title: d.title, body: d.body, priority: d.priority, milestone: d.milestone, status: 'inbox', depends_on: deps.filter((x): x is string => !!x) },
    `composer:${chat.id}`,
  );
  ctx.db.prepare("UPDATE composer_drafts SET status = 'created', task_id = ?, updated_at = ? WHERE id = ?").run(task.id, now(), id);
  return { draft: draftChanged(ctx, id), task };
}

/** Creates every open draft of a chat, dependencies first. */
export function createAllDrafts(ctx: Ctx, chatId: string): TaskRow[] {
  const open = () => listDrafts(ctx, chatId).filter((d) => d.status === 'draft');
  const created: TaskRow[] = [];
  let pending = open();
  while (pending.length) {
    const openIds = new Set(pending.map((d) => d.id));
    const ready = pending.filter((d) => !d.depends_on.some((dep) => openIds.has(dep)));
    if (!ready.length) throw conflict(`drafts ${pending.map((d) => d.id).join(', ')} depend on each other in a cycle`);
    for (const d of ready) created.push(createFromDraft(ctx, d.id).task);
    pending = open();
  }
  return created;
}
