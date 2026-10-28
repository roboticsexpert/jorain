// The task thread (docs/07-task-thread.md): agent updates and to-dos, owner messages, and a composer.
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Task, TaskMessage, TaskStatus } from '../api/types';
import { useLive } from '../live';
import { cx, fullDate, timeAgo } from '../lib/util';
import { Markdown } from './ui';

/** What happens to a message sent now, by task status. */
const DELIVERY: Record<TaskStatus, string> = {
  inbox: 'Claude gets it when the task starts.',
  todo: 'Claude gets it when the task starts.',
  in_progress: 'Claude is working: it gets this at its next step, without stopping.',
  waiting_for_human: 'Claude is paused: it gets this when it resumes.',
  review: 'Sending resumes the session with your message (like a review note).',
  blocked: 'Claude gets it when the task is started again.',
  failed: 'Claude gets it when the task is started again.',
  done: 'This task is done; create a new task instead.',
};

export function Thread({ task, messages, onChanged }: { task: Task; messages: TaskMessage[]; onChanged: () => void }) {
  const { toast, toastError, refreshInbox } = useLive();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const waitingOn = task.waiting_for ? messages.find((m) => m.id === task.waiting_for?.action_id) : undefined;

  // Opening the thread counts as reading the agent's updates.
  useEffect(() => {
    if (task.unread_updates > 0) api.markMessagesRead(task.id).then(refreshInbox, () => {});
  }, [task.id, task.unread_updates, refreshInbox]);

  async function send() {
    setBusy(true);
    try {
      const r = await api.sendMessage(task.id, text.trim());
      setText('');
      toast(r.task.status === 'in_progress' && task.status !== 'in_progress' ? 'Sent — session resumes' : 'Sent to Claude');
      onChanged();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section thread">
      <h3>
        Conversation {task.open_actions > 0 && <span className="count">{task.open_actions} to-do</span>}
      </h3>
      {task.status === 'waiting_for_human' && task.waiting_for && (
        <div className="notice">⏸ Claude is waiting for you: {waitingOn ? `“${waitingOn.title}”` : 'a message from you'}.</div>
      )}
      {messages.length === 0 && <p className="muted small">Updates, drafts and to-dos Claude shares while it works show up here. You can write to it at any time.</p>}
      {messages.map((m) =>
        m.kind === 'action' ? <ActionItem key={m.id} message={m} onChanged={onChanged} /> : <MessageItem key={m.id} message={m} />,
      )}
      {task.status !== 'done' && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void send();
          }}
        >
          <textarea
            rows={2}
            placeholder="Write to Claude: feedback, context, a change of plan…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="row">
            <span className="muted small grow">{DELIVERY[task.status]}</span>
            <button type="submit" className="btn-primary" disabled={busy || !text.trim()}>
              Send
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function MessageItem({ message: m }: { message: TaskMessage }) {
  const mine = m.author === 'owner';
  return (
    <div className={cx('card', 'msg', mine ? 'msg-owner' : 'msg-update')}>
      <div className="msg-head small">
        <span className="msg-label">{mine ? '🧑 You' : '📣 Update'}</span>
        <span className="muted" title={fullDate(m.created_at)}>
          {timeAgo(m.created_at)}
        </span>
        {mine && <span className="muted">· {m.delivered_at ? 'delivered' : 'not delivered yet'}</span>}
      </div>
      {m.title && <div className="msg-title">{m.title}</div>}
      {m.body && <Markdown source={m.body} />}
    </div>
  );
}

/** A to-do the agent handed the owner, with Done / Decline and an optional note. */
export function ActionItem({ message: m, onChanged, showTask }: { message: TaskMessage; onChanged: () => void; showTask?: boolean }) {
  const { toast, toastError, refreshInbox } = useLive();
  const [note, setNote] = useState('');
  const [noting, setNoting] = useState(false);
  const [busy, setBusy] = useState(false);

  async function resolve(status: 'done' | 'declined') {
    setBusy(true);
    try {
      await api.resolveAction(m.id, status, note.trim() || undefined);
      toast(status === 'done' ? 'Marked done — Claude gets your note' : 'Declined — Claude gets your note');
      refreshInbox();
      onChanged();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cx('card', 'msg', 'msg-action', m.status !== 'open' && 'msg-resolved')}>
      <div className="msg-head small">
        <span className="msg-label">📌 To-do for you</span>
        {m.status !== 'open' && <span className={cx('badge', m.status === 'done' ? 'status-review' : 'status-blocked')}>{m.status}</span>}
        {showTask && (
          <span className="muted">
            · {m.task_title} · {m.project_slug}
          </span>
        )}
        <span className="muted" title={fullDate(m.created_at)}>
          {timeAgo(m.created_at)}
        </span>
      </div>
      <div className="msg-title">{m.title}</div>
      {m.body && <Markdown source={m.body} />}
      {m.status === 'open' ? (
        <>
          {noting && (
            <textarea autoFocus rows={2} placeholder="Note for Claude (optional): a receipt, a link, why not…" value={note} onChange={(e) => setNote(e.target.value)} />
          )}
          <div className="row">
            <button type="button" className="btn-primary" disabled={busy} onClick={() => resolve('done')}>
              ✓ Done
            </button>
            <button type="button" disabled={busy} onClick={() => resolve('declined')}>
              ✕ Decline
            </button>
            {!noting && (
              <button type="button" className="btn-ghost" onClick={() => setNoting(true)}>
                + Add a note
              </button>
            )}
          </div>
        </>
      ) : (
        m.note && <div className="msg-note small">Your note: {m.note}</div>
      )}
    </div>
  );
}
