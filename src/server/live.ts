import type { Ctx } from '../core/context.ts';
import { eventsAfter, lastEventId, publish, publishedLocally } from '../core/events.ts';
import { findMilestone } from '../core/milestones.ts';
import { findGroup } from '../core/groups.ts';
import { findProject } from '../core/projects.ts';
import { findMessage } from '../core/messages.ts';
import { findChat, findChatMessage, findDraft } from '../core/composer.ts';
import { findQuestion } from '../core/questions.ts';
import { findTask, toPublicTask } from '../core/tasks.ts';
import { getRun } from '../core/runs.ts';
import { findSchedule } from '../core/schedules.ts';

/**
 * Relays events written by other processes (CLI, brain MCP servers, a foreground `brain run`) to the
 * SSE bus by polling the events table. Events written by this process were already published.
 */
export function startEventRelay(ctx: Ctx, intervalMs = 1500): () => void {
  let last = lastEventId(ctx);
  const timer = setInterval(() => {
    try {
      for (const e of eventsAfter(ctx, last)) {
        last = e.id;
        if (publishedLocally.delete(e.id)) continue;
        const p = e.payload as Record<string, any>;
        if (e.type === 'knowledge.changed') publish('knowledge.changed', { path: p.path });
        else if (e.type === 'question.created' || e.type === 'question.answered') {
          const q = findQuestion(ctx, p.question_id);
          if (q) publish(e.type, q);
        } else if (e.type === 'message.created' || e.type === 'message.updated') {
          const m = findMessage(ctx, p.message_id);
          if (m) publish('task.message', m);
        } else if (e.type === 'composer.chat') {
          const ch = findChat(ctx, p.chat_id);
          if (ch) publish('composer.chat', ch);
        } else if (e.type === 'composer.message') {
          const m = findChatMessage(ctx, p.message_id);
          if (m) publish('composer.message', m);
        } else if (e.type === 'composer.draft') {
          const d = findDraft(ctx, p.draft_id);
          if (d) publish('composer.draft', d);
        } else if (e.type === 'composer.deleted') publish('composer.deleted', { id: p.chat_id, project_slug: p.project });
        else if (e.type === 'run.started' || e.type === 'run.ended') publish(e.type, getRun(ctx, p.run_id));
        else if (e.type === 'milestone.created' || e.type === 'milestone.edited') {
          const m = findMilestone(ctx, p.id);
          if (m) publish('milestone.updated', m);
        } else if (e.type === 'milestone.deleted') publish('milestone.deleted', { id: p.id, project_slug: p.project });
        else if (e.type.startsWith('schedule.') && e.type !== 'schedule.deleted') {
          const s = findSchedule(ctx, p.id);
          if (s) publish('schedule.updated', s);
        } else if (e.type === 'schedule.deleted') publish('schedule.deleted', { id: p.id, project_slug: p.project });
        else if (e.type === 'project.doc_updated') {
          const proj = findProject(ctx, p.slug);
          if (proj) publish('project.updated', proj);
        } else if (e.type === 'group.deleted') publish('group.deleted', { slug: p.slug });
        else if (e.type.startsWith('group.')) {
          const g = findGroup(ctx, p.slug);
          if (g) publish('group.updated', g);
          for (const slug of g?.projects ?? []) {
            const proj = findProject(ctx, slug);
            if (proj) publish('project.updated', proj);
          }
        }
        if (e.task_id) {
          const t = findTask(ctx, e.task_id);
          if (t) publish('task.updated', toPublicTask(t));
        }
      }
    } catch (err) {
      console.error('[relay]', err);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
