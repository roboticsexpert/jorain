import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Question, Task } from '../api/types';
import { QuestionForm } from '../components/QuestionForm';
import { Empty, ErrorBox, Markdown, Spinner } from '../components/ui';
import { useLive, useReconnect, useSse } from '../live';
import { errorMessage, fullDate, timeAgo } from '../lib/util';

export function InboxPage() {
  const { refreshInbox } = useLive();
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [review, setReview] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [qs, ts] = await Promise.all([api.openQuestions(), api.tasks({ status: ['review'] })]);
      setQuestions(qs);
      setReview(ts.sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useReconnect(load);
  useSse((type, data) => {
    if (type === 'question.created') {
      const q = data as Question;
      setQuestions((qs) => (qs && !qs.some((x) => x.id === q.id) ? [q, ...qs] : qs));
    }
    if (type === 'question.answered') {
      const q = data as Question;
      setQuestions((qs) => qs?.filter((x) => x.id !== q.id) ?? qs);
    }
    if (type === 'task.updated') {
      const t = data as Task;
      setReview((ts) => {
        if (!ts) return ts;
        const rest = ts.filter((x) => x.id !== t.id);
        return t.status === 'review' ? [t, ...rest] : rest;
      });
    }
  });

  const loading = (!questions || !review) && !error;

  return (
    <div className="page inbox-page">
      <div className="toolbar">
        <h1>Inbox</h1>
      </div>
      {error && <ErrorBox error={error} onRetry={load} />}
      {loading && <Spinner />}

      {questions && (
        <section className="inbox-section">
          <h2>
            🙋 Questions <span className="count">{questions.length}</span>
          </h2>
          {questions.length === 0 && <Empty emoji="😌">No open questions. Claude is not waiting on you.</Empty>}
          {questions.map((q) => (
            <article key={q.id} className="card inbox-card">
              <header className="inbox-card-head">
                <Link to={`/board?task=${q.task_id}`} className="task-link">
                  {q.task_title}
                </Link>
                <span className="muted">· {q.project_slug}</span>
                <span className="grow" />
                <span className="muted" title={fullDate(q.asked_at)}>
                  {timeAgo(q.asked_at)}
                </span>
              </header>
              <QuestionForm
                question={q}
                onAnswered={() => {
                  setQuestions((qs) => qs?.filter((x) => x.id !== q.id) ?? qs);
                  refreshInbox();
                }}
              />
            </article>
          ))}
        </section>
      )}

      {review && (
        <section className="inbox-section">
          <h2>
            👀 Ready for review <span className="count">{review.length}</span>
          </h2>
          {review.length === 0 && <Empty emoji="🍃">Nothing to review.</Empty>}
          {review.map((t) => (
            <ReviewCard key={t.id} task={t} onDone={() => setReview((ts) => ts?.filter((x) => x.id !== t.id) ?? ts)} />
          ))}
        </section>
      )}
    </div>
  );
}

function ReviewCard({ task, onDone }: { task: Task; onDone: () => void }) {
  const { toast, toastError, refreshInbox } = useLive();
  const [changes, setChanges] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<Task>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast(msg);
      onDone();
      refreshInbox();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card inbox-card">
      <header className="inbox-card-head">
        <Link to={`/board?task=${task.id}`} className="task-link">
          {task.title}
        </Link>
        <span className="muted">· {task.project_slug}</span>
        <span className="grow" />
        <span className="muted" title={fullDate(task.updated_at)}>
          {timeAgo(task.updated_at)}
        </span>
      </header>
      {task.result_summary ? <Markdown source={task.result_summary} /> : <p className="muted">No summary.</p>}
      {task.branch && <div className="mono small muted">{task.branch}</div>}
      {changes ? (
        <form
          className="changes"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.requestChanges(task.id, note.trim()), 'Changes requested — session resumes');
          }}
        >
          <textarea autoFocus rows={3} placeholder="What should change?" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row end">
            <button type="button" className="btn-ghost" onClick={() => setChanges(false)}>
              Never mind
            </button>
            <button type="submit" className="btn-primary" disabled={busy || !note.trim()}>
              Send to Claude
            </button>
          </div>
        </form>
      ) : (
        <div className="row">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => run(() => api.approveTask(task.id), 'Approved')}>
            ✓ Approve
          </button>
          <button type="button" disabled={busy} onClick={() => setChanges(true)}>
            ↺ Request changes
          </button>
          <Link to={`/board?task=${task.id}`} className="btn-ghost">
            Open details
          </Link>
        </div>
      )}
    </article>
  );
}
