import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import type { Group, Portfolio, ProjectSummary, TaskStatus } from '../api/types';
import { Empty, ErrorBox, MilestoneBar, Spinner, StatusEmoji } from '../components/ui';
import { useLive, useReconnect, useSse } from '../live';
import { errorMessage, timeAgo } from '../lib/util';

const usd = (n: number) => `$${n.toFixed(2)}`;

// Counts shown on a card, in board order; "waiting on you" is waiting_for_human.
const COUNTS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'todo' },
  { status: 'in_progress', label: 'running' },
  { status: 'waiting_for_human', label: 'waiting on you' },
  { status: 'review', label: 'review' },
  { status: 'failed', label: 'failed' },
  { status: 'done', label: 'done' },
];

export function OverviewPage() {
  const location = useLocation();
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setData(await api.portfolio());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);

  // Portfolio numbers are aggregates: refetch (debounced) instead of patching them from events.
  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 400);
  }, [load]);

  useReconnect(load);
  useSse((type) => {
    if (
      type === 'task.updated' ||
      type === 'milestone.updated' ||
      type === 'milestone.deleted' ||
      type === 'project.updated' ||
      type === 'group.updated' ||
      type === 'group.deleted' ||
      type === 'run.ended' ||
      type === 'question.created' ||
      type === 'question.answered'
    )
      refresh();
  });

  // Old board links were `/?task=…` / `/?project=…`: the board now lives at /board.
  const sp = new URLSearchParams(location.search);
  if (sp.has('task') || sp.has('project')) return <Navigate to={`/board${location.search}`} replace />;

  return (
    <div className="page overview-page">
      <div className="toolbar">
        <h1>Overview</h1>
      </div>
      {error && <ErrorBox error={error} onRetry={load} />}
      {!data && !error && <Spinner />}
      {data && (
        <>
          <div className="totals">
            <div className="total">
              <b>{usd(data.totals.cost_usd)}</b>
              <span>💸 total cost</span>
            </div>
            <div className="total">
              <b>{usd(data.totals.cost_last_7_days)}</b>
              <span>📅 last 7 days</span>
            </div>
            <div className="total">
              <b>{data.totals.open_questions}</b>
              <span>🙋 open questions</span>
            </div>
            <div className="total">
              <b>{data.totals.in_review}</b>
              <span>👀 in review</span>
            </div>
            <div className="total">
              <b>{data.totals.running}</b>
              <span>⚙️ running</span>
            </div>
          </div>
          {data.projects.length === 0 ? (
            <Empty emoji="🧩">
              No active projects. <Link to="/projects?new=1">Create one</Link> to get started.
            </Empty>
          ) : (
            <PortfolioGroups data={data} onPlanned={refresh} />
          )}
        </>
      )}
    </div>
  );
}

/** Projects under their group's header (with summed numbers), then the ungrouped ones as before. */
function PortfolioGroups({ data, onPlanned }: { data: Portfolio; onPlanned: () => void }) {
  // Older backends do not send groups.
  const groups = (data.groups ?? [])
    .map((g) => ({ group: g, members: data.projects.filter((s) => s.project.group_slug === g.slug || g.projects.includes(s.project.slug)) }))
    .filter((x) => x.members.length > 0)
    .sort((a, b) => a.group.name.localeCompare(b.group.name));
  const grouped = new Set(groups.flatMap((x) => x.members.map((s) => s.project.slug)));
  const rest = data.projects.filter((s) => !grouped.has(s.project.slug));
  const cards = (list: ProjectSummary[]) => (
    <div className="portfolio">
      {list.map((s) => (
        <ProjectCard key={s.project.slug} summary={s} onPlanned={onPlanned} />
      ))}
    </div>
  );

  if (groups.length === 0) return cards(rest);
  return (
    <>
      {groups.map(({ group, members }) => (
        <section key={group.slug} className="pf-group">
          <GroupHeader group={group} members={members} />
          {cards(members)}
        </section>
      ))}
      {rest.length > 0 && (
        <section className="pf-group">
          <header className="pf-group-head">
            <h2>Other projects</h2>
          </header>
          {cards(rest)}
        </section>
      )}
    </>
  );
}

// Tasks that are not finished yet ("open"): everything except done.
const OPEN: TaskStatus[] = ['inbox', 'todo', 'in_progress', 'waiting_for_human', 'review', 'blocked', 'failed'];

function GroupHeader({ group, members }: { group: Group; members: ProjectSummary[] }) {
  const sum = (f: (s: ProjectSummary) => number) => members.reduce((n, s) => n + f(s), 0);
  const open = sum((s) => OPEN.reduce((n, st) => n + (s.counts[st] ?? 0), 0));
  return (
    <header className="pf-group-head">
      <Link to={`/board?group=${encodeURIComponent(group.slug)}`} title="Open the board for the whole group">
        <h2>🧩 {group.name}</h2>
      </Link>
      <span className="badge" title="Tasks not done yet, all projects of the group">
        📝 {open} open
      </span>
      <span className="badge status-review" title="Tasks in review">
        👀 {sum((s) => s.in_review)} review
      </span>
      <span className="muted small">
        💸 {usd(sum((s) => s.cost_usd.last_7_days))} 7 d · {usd(sum((s) => s.cost_usd.total))} total
      </span>
      <span className="grow" />
      <Link className="btn-ghost" to={`/projects?group=${encodeURIComponent(group.slug)}`}>
        Group settings
      </Link>
    </header>
  );
}

function ProjectCard({ summary, onPlanned }: { summary: ProjectSummary; onPlanned: () => void }) {
  const { toast, toastError } = useLive();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const { project, counts } = summary;
  const toBoard = () => navigate(`/board?project=${encodeURIComponent(project.slug)}`);

  async function plan() {
    setBusy(true);
    try {
      await api.planProject(project.slug);
      toast(`Planner queued for ${project.name}`);
      onPlanned();
    } catch (e) {
      // 409: a planner task is already open (e.g. waiting in review); the message says which.
      if (e instanceof ApiError && e.status === 409) toast(e.message);
      else toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="pf-card">
      <div className="pf-head">
        <button type="button" className="pf-name" onClick={toBoard} title="Open the board for this project">
          {project.name}
        </button>
        {summary.planning && <span className="badge planning">🧭 planning…</span>}
        <span className="grow" />
        <span className="muted small" title="Last activity">
          {timeAgo(summary.last_activity)}
        </span>
      </div>
      <div className="pf-counts">
        {COUNTS.map(({ status, label }) => (
          <span key={status} className={`badge status-${status}`} title={label}>
            <StatusEmoji status={status} /> {counts[status] ?? 0} {label}
          </span>
        ))}
        {summary.open_questions > 0 && (
          <span className="badge q" title="Unanswered questions">
            💬 {summary.open_questions} open question{summary.open_questions === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {summary.milestones.length > 0 && (
        <div className="pf-milestones">
          {summary.milestones.map((m) => (
            <MilestoneBar key={m.id} milestone={m} />
          ))}
        </div>
      )}
      <div className="pf-foot">
        <span title={`${summary.runs.total} runs, ${summary.runs.last_7_days} in the last 7 days`}>
          💸 {usd(summary.cost_usd.last_7_days)} <span className="muted">7 d</span> · {usd(summary.cost_usd.total)}{' '}
          <span className="muted">total</span>
        </span>
        <span className="grow" />
        <button type="button" className="btn-ghost" onClick={toBoard}>
          Board
        </button>
        <button type="button" disabled={busy || summary.planning} onClick={plan} title="Queue a planner run: it updates PROJECT.md, milestones and the next tasks">
          🧭 Plan next steps
        </button>
      </div>
    </article>
  );
}
