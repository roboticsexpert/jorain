import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { BrainEvent, Priority, Question, Run, SyncResult, Task, TaskDetail, TaskMessage, TaskStatus } from '../api/types';
import { STATUS_LABEL } from '../api/types';
import { useLive, useReconnect, useSse } from '../live';
import { errorMessage, fullDate, timeAgo } from '../lib/util';
import { AnsweredQuestion, QuestionForm } from './QuestionForm';
import { groupOf, useGroups } from './groups';
import { useMilestones } from './milestones';
import { RunLog } from './RunLog';
import { Thread } from './Thread';
import {
  ConfirmButton,
  ErrorBox,
  GitBadge,
  WaitingBadge,
  Markdown,
  PlannerBadge,
  PriorityBadge,
  Spinner,
  StatusBadge,
  VerifyBadge,
} from './ui';

const STARTABLE: TaskStatus[] = ['inbox', 'todo', 'blocked', 'failed'];
const MANUAL: TaskStatus[] = ['inbox', 'todo', 'blocked'];
const CANCELLABLE: TaskStatus[] = ['inbox', 'todo', 'in_progress', 'waiting_for_human', 'review', 'failed'];
// The server refuses sync while the task runs or once it is done.
const NO_SYNC: TaskStatus[] = ['in_progress', 'done'];

export function TaskDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { toastError, toast } = useLive();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api.task(taskId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [taskId]);

  useEffect(() => {
    setDetail(null);
    setEditing(false);
    setChangesOpen(false);
    void load();
  }, [load]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !editing && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, editing]);

  useReconnect(load);
  useSse((type, data) => {
    if (type === 'task.updated' && (data as Task).id === taskId) {
      setDetail((d) => (d ? { ...d, task: data as Task } : d));
    }
    if ((type === 'question.created' || type === 'question.answered') && (data as Question).task_id === taskId) void load();
    if ((type === 'run.started' || type === 'run.ended') && (data as Run).task_id === taskId) void load();
    if (type === 'task.message' && (data as TaskMessage).task_id === taskId) {
      const m = data as TaskMessage;
      setDetail((d) => (d ? { ...d, messages: d.messages.some((x) => x.id === m.id) ? d.messages.map((x) => (x.id === m.id ? m : x)) : [...d.messages, m] } : d));
    }
  });

  async function act(fn: () => Promise<Task>, msg: Msg) {
    setBusy(true);
    try {
      const t = await fn();
      setDetail((d) => (d ? { ...d, task: t } : d));
      toast(typeof msg === 'function' ? msg(t) : msg);
      void load();
    } catch (e) {
      toastError(e);
      void load(); // e.g. a merge conflict shows up in the activity list
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" aria-label="Task detail">
        {!detail && !error && (
          <div className="pad">
            <Spinner />
          </div>
        )}
        {error && (
          <div className="pad">
            <button type="button" className="btn-ghost icon close" onClick={onClose} aria-label="Close">
              ✕
            </button>
            <ErrorBox error={error} onRetry={load} />
          </div>
        )}
        {detail && (
          <DrawerBody
            detail={detail}
            editing={editing}
            setEditing={setEditing}
            changesOpen={changesOpen}
            setChangesOpen={setChangesOpen}
            busy={busy}
            act={act}
            onClose={onClose}
            reload={load}
          />
        )}
      </aside>
    </div>
  );
}

function DrawerBody({
  detail,
  editing,
  setEditing,
  changesOpen,
  setChangesOpen,
  busy,
  act,
  onClose,
  reload,
}: {
  detail: TaskDetail;
  editing: boolean;
  setEditing: (b: boolean) => void;
  changesOpen: boolean;
  setChangesOpen: (b: boolean) => void;
  busy: boolean;
  act: (fn: () => Promise<Task>, msg: Msg) => Promise<void>;
  onClose: () => void;
  reload: () => void;
}) {
  const { task, questions, runs, commits, events, messages } = detail;
  const [note, setNote] = useState('');
  const [sync, setSync] = useState<SyncResult | null>(null);
  const { milestones } = useMilestones(task.project_slug);
  const { groups } = useGroups();
  const group = groupOf(groups, task.project_slug);
  const lastVerify = events.filter((e) => e.type === 'task.verify').sort((a, b) => b.id - a.id)[0];
  const open = questions.filter((q) => !q.answer);
  const answered = questions.filter((q) => q.answer);

  return (
    <>
      <header className="drawer-head">
        <div className="drawer-meta">
          <span className="mono muted">{task.id}</span>
          <span className="muted">· {task.project_slug}</span>
          {group && (
            <Link className="badge proj-chip" to={`/board?group=${encodeURIComponent(group.slug)}`} title="This project's group: open the group board">
              🧩 {group.name}
            </Link>
          )}
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
          <PlannerBadge task={task} />
          <GitBadge task={task} />
          <VerifyBadge task={task} />
          <WaitingBadge task={task} />
        </div>
        <button type="button" className="btn-ghost icon" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {editing ? (
        <EditTask task={task} onDone={() => setEditing(false)} act={act} />
      ) : (
        <>
          <h2 className="drawer-title">{task.title}</h2>
          <div className="actions">
            {STARTABLE.includes(task.status) && (
              <button
                type="button"
                className="btn-primary"
                disabled={busy || task.waiting_on.length > 0}
                title={task.waiting_on.length ? `Waiting on ${task.waiting_on.join(', ')}: approve and merge those first, or remove them under Edit` : undefined}
                onClick={() => act(() => api.startTask(task.id), 'Run started')}
              >
                ▶ Start
              </button>
            )}
            {task.status === 'review' && (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  title={task.commit_count > 0 ? 'Squash-merge the task branch into its base branch' : undefined}
                  onClick={() => act(() => api.approveTask(task.id), deliveredMessage)}
                >
                  {task.commit_count > 0 ? '✓ Approve & merge' : '✓ Approve'}
                </button>
                <button type="button" disabled={busy} onClick={() => setChangesOpen(!changesOpen)}>
                  ↺ Request changes
                </button>
              </>
            )}
            {task.status === 'done' && task.branch && !task.merged_sha && (
              <button
                type="button"
                disabled={busy}
                title="This task was closed without its branch reaching the base branch. Squash-merge it now."
                onClick={() => act(() => api.mergeTask(task.id), deliveredMessage)}
              >
                ⑂ Merge into base
              </button>
            )}
            {task.merged_sha && !task.pushed_at && (
              <button type="button" disabled={busy} title={task.push_error ?? undefined} onClick={() => act(() => api.pushTask(task.id), deliveredMessage)}>
                ⇡ {task.push_error ? 'Retry push' : `Push ${task.merged_into}`}
              </button>
            )}
            {task.branch && !NO_SYNC.includes(task.status) && (
              <button
                type="button"
                disabled={busy}
                title="Bring the task branch up to date with its base branch (fast-forward or merge)"
                onClick={() => {
                  let result: SyncResult | null = null;
                  void act(
                    async () => {
                      const r = await api.syncTask(task.id);
                      result = r.result;
                      setSync(r.result);
                      return r.task;
                    },
                    () => (result ? syncText(result) : 'Synced'),
                  );
                }}
              >
                ⟳ Update from base
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>
              ✎ Edit
            </button>
            {MANUAL.includes(task.status) &&
              MANUAL.filter((s) => s !== task.status).map((s) => (
                <button
                  key={s}
                  type="button"
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() => act(() => api.updateTask(task.id, { status: s }), `Moved to ${STATUS_LABEL[s]}`)}
                >
                  → {STATUS_LABEL[s]}
                </button>
              ))}
            {CANCELLABLE.includes(task.status) && (
              <ConfirmButton
                className="btn-ghost danger"
                disabled={busy}
                confirmLabel={task.status === 'in_progress' ? 'Kill session' : 'Cancel task'}
                onConfirm={() => act(() => api.cancelTask(task.id), 'Cancelled — task is now blocked')}
              >
                ✕ Cancel
              </ConfirmButton>
            )}
          </div>
          {sync && (
            <div className={sync.status === 'conflict' ? 'notice sync-result' : 'muted sync-result'}>
              {syncText(sync)}
              {sync.status === 'conflict' && (
                <>
                  : <span className="mono">{sync.conflicts.join(', ')}</span>. Nothing was changed; request changes (or start the task) so
                  the agent merges and resolves them.
                </>
              )}
            </div>
          )}
          {changesOpen && task.status === 'review' && (
            <form
              className="changes"
              onSubmit={(e) => {
                e.preventDefault();
                void act(() => api.requestChanges(task.id, note.trim()), 'Changes requested — session resumes').then(() => {
                  setNote('');
                  setChangesOpen(false);
                });
              }}
            >
              <textarea
                autoFocus
                rows={3}
                placeholder="What should change? This note is sent to the session."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="row end">
                <button type="button" className="btn-ghost" onClick={() => setChangesOpen(false)}>
                  Never mind
                </button>
                <button type="submit" className="btn-primary" disabled={!note.trim() || busy}>
                  Send to Claude
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <dl className="facts">
        {(milestones.length > 0 || task.milestone_id) && (
          <>
            <dt>Milestone</dt>
            <dd>
              <select
                value={task.milestone_id ?? ''}
                disabled={busy}
                aria-label="Milestone"
                onChange={(e) =>
                  act(() => api.updateTask(task.id, { milestone: e.target.value || null }), e.target.value ? 'Milestone set' : 'Removed from milestone')
                }
              >
                <option value="">No milestone</option>
                {milestones
                  .filter((m) => m.status === 'open' || m.id === task.milestone_id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.status === 'done' ? '🏁' : '🎯'} {m.title}
                    </option>
                  ))}
              </select>
            </dd>
          </>
        )}
        {task.depends_on.length > 0 && (
          <>
            <dt>Depends on</dt>
            <dd className="deps">
              {task.depends_on.map((d) => (
                <DependencyLink key={d} id={d} waiting={task.waiting_on.includes(d)} fromProject={task.project_slug} />
              ))}
            </dd>
          </>
        )}
        {task.branch && (
          <>
            <dt>Branch</dt>
            <dd className="mono">{task.branch}</dd>
          </>
        )}
        {task.worktree && (
          <>
            <dt>Worktree</dt>
            <dd className="mono">{task.worktree}</dd>
          </>
        )}
        {task.verify_status && (
          <>
            <dt>Checks</dt>
            <dd className={task.verify_status === 'failed' ? 'danger' : undefined}>
              {task.verify_status === 'passed' ? '✓ passed' : '✗ failed'}
              {lastVerify && <span className="muted mono"> · {String(lastVerify.payload.command ?? '')}</span>}
            </dd>
          </>
        )}
        {task.merged_sha && (
          <>
            <dt>Merged</dt>
            <dd>
              into <span className="mono">{task.merged_into}</span> as <span className="mono">{task.merged_sha.slice(0, 7)}</span>{' '}
              <span className="muted" title={fullDate(task.merged_at)}>
                {timeAgo(task.merged_at)}
              </span>
            </dd>
            <dt>Pushed</dt>
            <dd className={task.push_error ? 'danger' : undefined}>
              {task.pushed_at ? <span title={fullDate(task.pushed_at)}>{timeAgo(task.pushed_at)}</span> : task.push_error ? `failed: ${task.push_error}` : 'not yet'}
            </dd>
          </>
        )}
        {task.session_id && (
          <>
            <dt>Session</dt>
            <dd className="mono">{task.session_id}</dd>
          </>
        )}
        {task.schedule_id && (
          <>
            <dt>Schedule</dt>
            <dd>
              ⏰ <Link to={`/schedules?project=${encodeURIComponent(task.project_slug)}`}>{task.schedule_id}</Link>
            </dd>
          </>
        )}
        <dt>Created</dt>
        <dd title={fullDate(task.created_at)}>{timeAgo(task.created_at)}</dd>
        <dt>Updated</dt>
        <dd title={fullDate(task.updated_at)}>{timeAgo(task.updated_at)}</dd>
      </dl>

      {task.result_summary && (
        <section className={`section summary${task.status === 'failed' || task.status === 'blocked' ? ' summary-bad' : ''}`}>
          <h3>Summary</h3>
          <Markdown source={task.result_summary} />
        </section>
      )}

      {!editing && (
        <section className="section">
          <h3>Description</h3>
          {task.body.trim() ? <Markdown source={task.body} /> : <p className="muted">No description.</p>}
        </section>
      )}

      <Thread task={task} messages={messages} onChanged={reload} />

      {questions.length > 0 && (
        <section className="section">
          <h3>Questions {open.length > 0 && <span className="count">{open.length} open</span>}</h3>
          {open.map((q) => (
            <div key={q.id} className="card question-card">
              <div className="muted small">asked {timeAgo(q.asked_at)}</div>
              <QuestionForm question={q} onAnswered={reload} />
            </div>
          ))}
          {answered.map((q) => (
            <div key={q.id} className="card answered">
              <div className="muted small">
                asked {timeAgo(q.asked_at)} · answered {timeAgo(q.answered_at)}
              </div>
              <AnsweredQuestion question={q} />
            </div>
          ))}
        </section>
      )}

      {lastVerify && <VerifyOutput event={lastVerify} />}

      <Runs runs={runs} />

      <Commits taskId={task.id} commits={commits} hasBranch={!!task.branch} />

      {events.length > 0 && (
        <section className="section">
          <h3>Activity</h3>
          <ul className="activity">
            {events.map((e) => (
              <li key={e.id}>
                <span className="muted" title={fullDate(e.created_at)}>
                  {timeAgo(e.created_at)}
                </span>{' '}
                {describeEvent(e)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** One task this task depends on: opens it in the drawer so you can see why it is holding things up. */
function DependencyLink({ id, waiting, fromProject }: { id: string; waiting: boolean; fromProject: string }) {
  const [params] = useSearchParams();
  const [dep, setDep] = useState<Task | null>(null);
  const [missing, setMissing] = useState(false);
  const [foreignName, setForeignName] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.task(id).then(
      (d) => {
        if (!live) return;
        setDep(d.task);
        // A task of another project (e.g. the backend half of a group): show that project's name.
        if (d.task.project_slug !== fromProject)
          api.project(d.task.project_slug).then(
            (p) => live && setForeignName(p.name),
            () => live && setForeignName(d.task.project_slug),
          );
      },
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [id, fromProject]);

  const next = new URLSearchParams(params);
  next.set('task', id);
  return (
    <div className="dep">
      <Link to={`/board?${next}`} className="task-link">
        {dep ? dep.title : <span className="mono">{id}</span>}
      </Link>{' '}
      {dep && dep.project_slug !== fromProject && (
        <span className="badge proj-chip" title="A task of another project">
          {foreignName ?? dep.project_slug}
        </span>
      )}
      {dep && <StatusBadge status={dep.status} />}
      {missing && <span className="muted"> (not found)</span>}
      {waiting ? <span className="muted"> not merged yet</span> : ' ✓'}
    </div>
  );
}

function EditTask({ task, onDone, act }: { task: Task; onDone: () => void; act: (fn: () => Promise<Task>, msg: string) => Promise<void> }) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [deps, setDeps] = useState(task.depends_on.join(', '));

  function save(e: React.FormEvent) {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    if (title.trim() !== task.title) patch.title = title.trim();
    if (body !== task.body) patch.body = body;
    if (priority !== task.priority) patch.priority = priority;
    const depList = deps.split(/[\s,]+/).filter(Boolean);
    if ([...depList].sort().join() !== task.depends_on.join()) patch.depends_on = depList;
    if (Object.keys(patch).length === 0) return onDone();
    void act(() => api.updateTask(task.id, patch), 'Saved').then(onDone);
  }

  return (
    <form className="form edit-task" onSubmit={save}>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
      </label>
      <label>
        Description <span className="hint">markdown</span>
        <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="grid3">
        <label>
          Priority
          <select value={priority} onChange={(e) => setPriority(Number(e.target.value) as Priority)}>
            <option value={3}>High</option>
            <option value={2}>Normal</option>
            <option value={1}>Low</option>
          </select>
        </label>
      </div>
      <label>
        Depends on <span className="hint">task ids, comma-separated; it starts only after each is approved and merged</span>
        <input className="mono" value={deps} onChange={(e) => setDeps(e.target.value)} placeholder="t_abc123, t_def456" />
      </label>
      <div className="row end">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={!title.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}

/** Output of the latest verify_command check, collapsed unless it failed. */
function VerifyOutput({ event }: { event: BrainEvent }) {
  const p = event.payload;
  const ok = p.ok === true;
  return (
    <section className="section">
      <h3>Checks</h3>
      <details className="verify-out" open={!ok}>
        <summary>
          {ok ? '✓' : '✗'} <span className="mono">{String(p.command ?? '')}</span>{' '}
          <span className="muted">
            exit {String(p.exit_code ?? '?')} · {timeAgo(event.created_at)}
          </span>
        </summary>
        <pre className="json">{String(p.output ?? '') || '(no output)'}</pre>
      </details>
    </section>
  );
}

function Runs({ runs }: { runs: Run[] }) {
  const latest = runs[runs.length - 1]?.id;
  const [openId, setOpenId] = useState<string | undefined>(latest);
  useEffect(() => setOpenId(latest), [latest]);
  if (runs.length === 0) return null;
  return (
    <section className="section">
      <h3>Runs</h3>
      {[...runs].reverse().map((r) => (
        <div key={r.id} className="run">
          <button type="button" className="run-head" onClick={() => setOpenId(openId === r.id ? undefined : r.id)} aria-expanded={openId === r.id}>
            <span>{openId === r.id ? '▾' : '▸'}</span>
            <span className="mono">{r.id}</span>
            <span className="badge">{r.kind}</span>
            <span className="muted" title={fullDate(r.started_at)}>
              {timeAgo(r.started_at)}
            </span>
            <span className="grow" />
            {r.ended_at ? (
              <span className={`badge stop-${r.stop_reason === 'end_turn' ? 'ok' : r.stop_reason === 'tool_deferred' ? 'wait' : 'bad'}`}>
                {r.stop_reason ?? `exit ${r.exit_code}`}
              </span>
            ) : (
              <span className="badge running">running</span>
            )}
            {r.cost_usd != null && <span className="muted">${r.cost_usd.toFixed(2)}</span>}
          </button>
          {openId === r.id && <RunLog run={r} />}
        </div>
      ))}
    </section>
  );
}

function Commits({ taskId, commits, hasBranch }: { taskId: string; commits: TaskDetail['commits']; hasBranch: boolean }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const head = commits[0]?.sha;

  useEffect(() => {
    if (!showDiff) return;
    api
      .taskDiff(taskId)
      .then((d) => {
        setDiff(d ?? '');
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [taskId, showDiff, head]);

  if (!hasBranch && commits.length === 0) return null;
  return (
    <section className="section">
      <h3>Commits</h3>
      {commits.length === 0 ? (
        <p className="muted">No commits yet.</p>
      ) : (
        <ul className="commits">
          {commits.map((c) => (
            <li key={c.sha}>
              <span className="mono sha">{c.sha.slice(0, 7)}</span> {c.message}{' '}
              <span className="muted" title={fullDate(c.date)}>
                — {c.author}, {timeAgo(c.date)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn-ghost" onClick={() => setShowDiff(!showDiff)}>
        {showDiff ? 'Hide diff' : 'Show diff'}
      </button>
      {showDiff && error && <ErrorBox error={error} />}
      {showDiff && diff !== null && <Diff text={diff} />}
    </section>
  );
}

function Diff({ text }: { text: string }) {
  if (!text.trim()) return <p className="muted">Empty diff.</p>;
  return (
    <pre className="diff">
      {text.split('\n').map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')
          ? 'd-file'
          : l.startsWith('@@')
            ? 'd-hunk'
            : l.startsWith('+')
              ? 'd-add'
              : l.startsWith('-')
                ? 'd-del'
                : '';
        return (
          <div key={i} className={cls}>
            {l || ' '}
          </div>
        );
      })}
    </pre>
  );
}

const statusName = (s: unknown) => STATUS_LABEL[s as TaskStatus] ?? String(s);

/** One-line text for the persisted activity types listed in the API contract; unknown types fall back to raw JSON. */
type Msg = string | ((t: Task) => string);

/** One line for a sync result. */
function syncText(r: SyncResult): string {
  const base = r.base ?? 'base';
  switch (r.status) {
    case 'up_to_date':
      return `Already up to date with ${base}`;
    case 'fast_forwarded':
      return `Fast-forwarded to ${base}`;
    case 'merged':
      return `Merged ${base} into the task branch`;
    case 'no_branch':
      return 'The task has no branch yet';
    case 'conflict':
      return `Merging ${base} conflicts in ${r.conflicts.length} file${r.conflicts.length === 1 ? '' : 's'}`;
  }
}

/** Toast after approve/push, saying how far the git work got. */
function deliveredMessage(t: Task): string {
  if (t.pushed_at) return `Merged into ${t.merged_into} and pushed`;
  if (t.push_error) return `Merged into ${t.merged_into}, but the push failed`;
  if (t.merged_sha) return `Approved — squash-merged into ${t.merged_into}`;
  return 'Approved';
}

function describeEvent(e: BrainEvent): React.ReactNode {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'task.created':
      return `Created by ${String(p.source ?? 'owner')} in ${statusName(p.status)}`;
    case 'task.status': {
      const extra = [p.action, p.stop_reason, p.reason, p.via].filter(Boolean).map(String).join(' · ');
      return `${statusName(p.from)} → ${statusName(p.to)}${extra ? ` (${extra})` : ''}`;
    }
    case 'task.edited':
      return `Edited ${Object.keys(p).join(', ')}`;
    case 'task.changes_requested':
      return `Changes requested: “${String(p.note ?? '')}”`;
    case 'task.autocommit':
      return 'Committed changes the agent left uncommitted';
    case 'task.merged':
      return `Squash-merged into ${String(p.into)} as ${String(p.sha).slice(0, 7)}`;
    case 'task.merge_conflict':
      return `Merge into ${String(p.into)} blocked by conflicts in ${(p.files as string[] | undefined)?.join(', ') ?? '?'}`;
    case 'task.pushed':
      return `Pushed ${String(p.branch)} to ${String(p.remote)}`;
    case 'task.push_failed':
      return `Push of ${String(p.branch)} failed: ${String(p.error)}`;
    case 'task.worktree':
      return (
        <>
          Worktree created at <span className="mono">{String(p.path)}</span>
          {p.branch ? (
            <>
              {' '}
              on <span className="mono">{String(p.branch)}</span>
            </>
          ) : null}
        </>
      );
    case 'task.worktree_removed':
      return (
        <>
          Worktree removed (<span className="mono">{String(p.path)}</span>)
        </>
      );
    case 'task.synced':
      return p.how === 'merged'
        ? `Merged ${String(p.base)} into the branch${p.to ? ` (now ${String(p.to).slice(0, 7)})` : ''}`
        : `Fast-forwarded to ${String(p.base)}${p.to ? ` (${String(p.to).slice(0, 7)})` : ''}`;
    case 'task.sync_conflict':
      return `Update from ${String(p.base)} conflicts in ${(p.files as string[] | undefined)?.join(', ') ?? '?'}; the agent is asked to resolve them`;
    case 'task.verify':
      return p.ok === true
        ? `Checks passed (${String(p.command)})`
        : `Checks failed (${String(p.command)}, exit ${String(p.exit_code)})`;
    case 'task.verify_fix':
      return `Failed checks sent back to the agent (attempt ${String(p.attempt)})`;
    case 'task.owner_input_continue':
      return 'Your message arrived as the run ended: the session continued with it';
    case 'message.created':
      return p.author === 'owner' ? 'You wrote to Claude' : p.kind === 'action' ? 'Claude handed you a to-do' : 'Claude posted an update';
    case 'message.updated':
      return 'To-do resolved';
    case 'message.delivered':
      return 'Claude received your input';
    case 'message.read':
      return `Read ${String(p.count)} update${p.count === 1 ? '' : 's'}`;
    case 'question.created':
      return 'Asked a question';
    case 'question.answered':
      return 'Question answered';
    case 'run.started':
      return `Run ${String(p.run_id ?? '')} started (${String(p.kind ?? '')})`;
    case 'run.ended': {
      const cost = typeof p.cost_usd === 'number' ? ` · $${p.cost_usd.toFixed(2)}` : '';
      return `Run ${String(p.run_id ?? '')} ended: ${String(p.stop_reason ?? `exit ${String(p.exit_code)}`)}${cost}`;
    }
    default:
      return (
        <>
          <span className="mono">{e.type}</span> <span className="muted">{JSON.stringify(p)}</span>
        </>
      );
  }
}
