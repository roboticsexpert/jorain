import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Milestone, Priority, Task, TaskStatus } from '../api/types';
import { PRIORITY_LABEL, STATUS_LABEL } from '../api/types';
import { cx } from '../lib/util';

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }) as string), [source]);
  return <div className={cx('markdown', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

export const STATUS_EMOJI: Record<TaskStatus, string> = {
  inbox: '📥',
  todo: '📝',
  in_progress: '✳️', // rendered as <Clawd> instead
  waiting_for_human: '🙋',
  review: '👀',
  done: '✅',
  blocked: '🧱',
  failed: '💥',
};

// Clawd, Claude Code's mascot, pixel for pixel from its terminal block art
// (each cell is a quadrant of a block character, so 1 wide × 2 tall). # body, o eye.
const CLAWD = [
  '...############...',
  '...##o######o##...',
  '.################.',
  '...############...',
  '....#.#....#.#....',
];
const clawdPath = (ch: string) =>
  CLAWD.flatMap((row, y) => [...row].flatMap((c, x) => (c === ch ? [`M${x} ${y * 2}h1v2h-1z`] : []))).join('');
// one path per colour, so no hairline seams between pixels
const CLAWD_BODY = clawdPath('#');
const CLAWD_EYES = [...CLAWD[1]].flatMap((c, x) => (c === 'o' ? [x] : []));

/** Clawd. `working` makes it hop and blink while Claude is on a task. */
export function Clawd({ working = false, size = 18 }: { working?: boolean; size?: number }) {
  return (
    <svg
      className={cx('clawd', working && 'working')}
      width={size}
      height={(size * 10) / 18}
      viewBox="0 0 18 10"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <path d={CLAWD_BODY} />
      {CLAWD_EYES.map((x) => (
        <rect key={x} className="clawd-eye" x={x} y={2} width={1} height={2} />
      ))}
    </svg>
  );
}

/** Status emoji; in progress shows Clawd, hopping while Claude works. */
export function StatusEmoji({ status }: { status: TaskStatus }) {
  if (status === 'in_progress') return <Clawd working />;
  return (
    <span className={cx('emoji', `emoji-${status}`)} aria-hidden="true">
      {STATUS_EMOJI[status]}
    </span>
  );
}

const PRIORITY_EMOJI: Record<Priority, string> = { 1: '💤', 2: '', 3: '🔥' };

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`badge prio-${priority}`}>
      {PRIORITY_EMOJI[priority] && `${PRIORITY_EMOJI[priority]} `}
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`badge status status-${status}`}>
      <StatusEmoji status={status} /> {STATUS_LABEL[status]}
    </span>
  );
}

/** Animated chip on a task Claude is working on right now. */
export function WorkingChip() {
  return (
    <span className="working-chip" title="Claude is working on this">
      <Clawd working />
      Claude is working
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

/** Where a task's git work stands: commits on its branch → merged into base → pushed. Nothing for non-git tasks. */
export function GitBadge({ task }: { task: Task }) {
  if (!task.branch) return null;
  if (task.pushed_at) return <span className="badge git-pushed" title={`Merged into ${task.merged_into} and pushed`}>⇡ pushed</span>;
  if (task.push_error) return <span className="badge git-error" title={`Push failed: ${task.push_error}`}>⇡ push failed</span>;
  if (task.merged_sha) return <span className="badge git-merged" title={`Squash-merged into ${task.merged_into} as ${task.merged_sha.slice(0, 7)}`}>⑂ merged</span>;
  if (task.status === 'done' && task.commit_count > 0)
    return <span className="badge git-error" title={`Done, but ${task.branch} was never merged; tasks that depend on it keep waiting`}>⑂ not merged</span>;
  if (task.commit_count === 0) return null;
  return (
    <span className="badge git-commits" title={`${task.commit_count} commit${task.commit_count === 1 ? '' : 's'} on ${task.branch}`}>
      ● {task.commit_count}
    </span>
  );
}

/** Shown while a task waits for tasks it depends on to be done and merged; the scheduler does not start it. */
export function WaitingBadge({ task, describe = (id) => id }: { task: Task; describe?: (id: string) => string }) {
  if (!task.waiting_on.length || task.status === 'done') return null;
  return (
    <span className="badge q" title={`Waits for ${task.waiting_on.map(describe).join(', ')} to be approved and merged`}>
      ⏳ waiting on {task.waiting_on.length}
    </span>
  );
}

/** Result of the project's verify_command after the task's last run. */
export function VerifyBadge({ task }: { task: Task }) {
  if (!task.verify_status) return null;
  return task.verify_status === 'passed' ? (
    <span className="badge verify-ok" title="Project checks passed after the last run">
      ✓ checks
    </span>
  ) : (
    <span className="badge git-error" title="Project checks still failed after the agent's fix attempts">
      ✗ checks
    </span>
  );
}

/** A planner run: shapes the project (PROJECT.md, milestones, next tasks) instead of changing code. */
export function PlannerBadge({ task }: { task: Task }) {
  if (task.kind !== 'plan') return null;
  if (task.milestone_id)
    return (
      <span className="badge planner" title="Milestone check: all its tasks are done; queues what is missing or asks you to close the milestone">
        🏁 milestone check
      </span>
    );
  return (
    <span className="badge planner" title="Planner task: updates PROJECT.md, milestones and queues the next tasks">
      🧭 planner
    </span>
  );
}

/** done/total bar for a milestone. */
export function MilestoneBar({ milestone }: { milestone: Milestone }) {
  const pct = milestone.total ? Math.round((milestone.done / milestone.total) * 100) : 0;
  return (
    <div className="ms-bar" title={`${milestone.done} of ${milestone.total} tasks done`}>
      <div className="ms-bar-head">
        <span className="ms-title">
          {milestone.status === 'done' ? '🏁' : '🎯'} {milestone.title}
        </span>
        <span className="muted small">
          {milestone.done}/{milestone.total}
          {milestone.due && ` · due ${milestone.due}`}
        </span>
      </div>
      <div className="ms-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={milestone.title}>
        <div className="ms-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Two-step button for destructive or irreversible actions (no window.confirm). */
export function ConfirmButton({
  children,
  confirmLabel = 'Confirm',
  onConfirm,
  className,
  disabled,
}: {
  children: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  if (!armed) {
    return (
      <button type="button" className={className} disabled={disabled} onClick={() => setArmed(true)}>
        {children}
      </button>
    );
  }
  return (
    <span className="confirm">
      <button
        type="button"
        className="btn-danger"
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="btn-ghost" onClick={() => setArmed(false)}>
        Keep
      </button>
    </span>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn-ghost icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children, emoji = '🌱' }: { children: ReactNode; emoji?: string }) {
  return (
    <div className="empty">
      <span className="empty-emoji" aria-hidden="true">
        {emoji}
      </span>
      {children}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="error-box">
      <span>{error}</span>
      {onRetry && (
        <button type="button" className="btn-ghost" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
