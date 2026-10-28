import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Milestone, Project, Task, TaskStatus } from '../api/types';
import { BOARD_STATUSES, SIDE_STATUSES, STATUS_LABEL } from '../api/types';
import { groupLabel, useGroups } from '../components/groups';
import { NewTaskModal } from '../components/TaskForm';
import { TaskDrawer } from '../components/TaskDrawer';
import {
  ErrorBox,
  GitBadge,
  WaitingBadge,
  PlannerBadge,
  PriorityBadge,
  Spinner,
  StatusEmoji,
  VerifyBadge,
  WorkingChip,
} from '../components/ui';
import { useLive, useReconnect, useSse } from '../live';
import { cx, errorMessage, timeAgo } from '../lib/util';

const SIDE_KEY = 'brain.board.sideOpen';

const EMPTY_COLUMN: Record<TaskStatus, string> = {
  inbox: 'Inbox zero 🎉',
  todo: 'Nothing queued 🌱',
  in_progress: 'Claude is chilling ☕',
  waiting_for_human: 'Nobody needs you 😌',
  review: 'Nothing to review 🍃',
  done: 'Nothing done yet 🌤️',
  blocked: 'No blockers 🙌',
  failed: 'No failures 🍀',
};

export function BoardPage() {
  const [params, setParams] = useSearchParams();
  const projectFilter = params.get('project') ?? '';
  // A group shows the tasks of all its projects; it is ignored while a project is selected.
  const groupFilter = projectFilter ? '' : (params.get('group') ?? '');
  // '' = all milestones, 'none' = tasks without one, else a milestone id (only with a project selected)
  const milestoneFilter = projectFilter ? (params.get('milestone') ?? '') : '';
  const openTask = params.get('task');
  const { toast } = useLive();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { groups } = useGroups();
  const group = groups.find((g) => g.slug === groupFilter);
  const [sideOpen, setSideOpen] = useState(() => {
    try {
      return localStorage.getItem(SIDE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const sideRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sideOpen) sideRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  }, [sideOpen]);

  const load = useCallback(async () => {
    try {
      const [ts, ps] = await Promise.all([
        api.tasks({ project: projectFilter || undefined, group: groupFilter || undefined }),
        api.projects(),
      ]);
      setTasks(ts);
      setProjects(ps);
      setError(null);
      // Milestone titles for card chips: of the selected project, or of every project on the board.
      const slugs = projectFilter ? [projectFilter] : [...new Set(ts.filter((t) => t.milestone_id).map((t) => t.project_slug))];
      const lists = await Promise.all(slugs.map((sl) => api.milestones(sl).catch(() => [] as Milestone[])));
      setMilestones(lists.flat());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [projectFilter, groupFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Members of the selected group changed: reload its tasks.
  const members = group?.projects.join() ?? '';
  const loadedMembers = useRef(members);
  useEffect(() => {
    if (loadedMembers.current && loadedMembers.current !== members && group) void load();
    loadedMembers.current = members;
  }, [members, group, load]);

  useReconnect(load);
  useSse((type, data) => {
    if (type === 'project.updated') {
      const p = data as Project;
      setProjects((ps) => (ps.some((x) => x.slug === p.slug) ? ps.map((x) => (x.slug === p.slug ? p : x)) : [...ps, p]));
      return;
    }
    if (type === 'group.deleted' && (data as { slug: string }).slug === groupFilter) {
      setScope('');
      return;
    }
    if (type === 'milestone.updated') {
      const m = data as Milestone;
      setMilestones((ms) => (ms.some((x) => x.id === m.id) ? ms.map((x) => (x.id === m.id ? m : x)) : [...ms, m]));
      return;
    }
    if (type === 'milestone.deleted') {
      const { id } = data as { id: string };
      setMilestones((ms) => ms.filter((x) => x.id !== id));
      return;
    }
    if (type !== 'task.updated') return;
    const t = data as Task;
    setTasks((ts) => {
      if (!ts) return ts;
      const matches = projectFilter ? t.project_slug === projectFilter : group ? group.projects.includes(t.project_slug) : !groupFilter;
      const i = ts.findIndex((x) => x.id === t.id);
      if (i === -1) return matches ? [t, ...ts] : ts;
      const copy = ts.slice();
      copy[i] = t;
      return copy;
    });
  });

  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>();
    for (const t of tasks ?? []) {
      if (milestoneFilter === 'none' ? t.milestone_id : milestoneFilter && t.milestone_id !== milestoneFilter) continue;
      if (!m.has(t.status)) m.set(t.status, []);
      m.get(t.status)!.push(t);
    }
    for (const list of m.values()) list.sort((a, b) => b.priority - a.priority || b.updated_at.localeCompare(a.updated_at));
    return m;
  }, [tasks, milestoneFilter]);

  const sideCount = SIDE_STATUSES.reduce((n, s) => n + (byStatus.get(s)?.length ?? 0), 0);
  const projectName = (slug: string) => projects.find((p) => p.slug === slug)?.name ?? slug;
  const milestoneTitle = (id: string | null) => (id ? (milestones.find((m) => m.id === id)?.title ?? null) : null);
  // Waiting badge tooltips: dependencies by project and title when the board has them.
  const describeTask = (id: string) => {
    const t = tasks?.find((x) => x.id === id);
    return t ? `${projectName(t.project_slug)}: ${t.title} (${id})` : id;
  };
  const projectMilestones = milestones.filter((m) => m.project_slug === projectFilter).sort((a, b) => a.position - b.position);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === 'project') next.delete('milestone');
    setParams(next, { replace: k === 'project' || k === 'milestone' });
  };

  // One select for both: '' = all, 'group:<slug>' = a group, else a project slug.
  const scopeValue = projectFilter || (groupFilter ? `group:${groupFilter}` : '');
  const setScope = (v: string) => {
    const next = new URLSearchParams(params);
    next.delete('project');
    next.delete('group');
    next.delete('milestone');
    if (v.startsWith('group:')) next.set('group', v.slice('group:'.length));
    else if (v) next.set('project', v);
    setParams(next, { replace: true });
  };
  const activeMembers = group ? group.projects.filter((sl) => projects.some((p) => p.slug === sl && p.status === 'active')) : [];

  const toggleSide = () => {
    setSideOpen((o) => {
      try {
        localStorage.setItem(SIDE_KEY, o ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !o;
    });
  };

  return (
    <div className="page board-page">
      <div className="toolbar">
        <h1>Board</h1>
        <select value={scopeValue} onChange={(e) => setScope(e.target.value)} aria-label="Project filter">
          <option value="">All projects</option>
          {groups.length > 0 && (
            <optgroup label="Groups">
              {groups.map((g) => (
                <option key={g.slug} value={`group:${g.slug}`}>
                  🧩 Group: {groupLabel(g, projects)}
                </option>
              ))}
            </optgroup>
          )}
          {groupFilter && !group && <option value={`group:${groupFilter}`}>🧩 Group: {groupFilter}</option>}
          <optgroup label="Projects">
            {projects
              .filter((p) => p.status === 'active' || p.slug === projectFilter)
              .map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        </select>
        {projectFilter && (
          <select value={milestoneFilter} onChange={(e) => setParam('milestone', e.target.value || null)} aria-label="Milestone filter">
            <option value="">All milestones</option>
            {projectMilestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.status === 'done' ? '🏁' : '🎯'} {m.title}
              </option>
            ))}
            <option value="none">No milestone</option>
          </select>
        )}
        <span className="grow" />
        <button type="button" className={cx('btn-ghost', sideOpen && 'on')} onClick={toggleSide} aria-expanded={sideOpen}>
          🚧 Blocked &amp; failed <span className="count">{sideCount}</span>
        </button>
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
          + New task
        </button>
      </div>

      {error && <ErrorBox error={error} onRetry={load} />}
      {!tasks && !error && <Spinner />}

      {tasks && (
        <div className="board">
          {BOARD_STATUSES.map((s) => (
            <Column
              key={s}
              status={s}
              tasks={byStatus.get(s) ?? []}
              onOpen={(id) => setParam('task', id)}
              projectName={projectName}
              milestoneTitle={milestoneTitle}
              describeTask={describeTask}
              showProject={!projectFilter}
              projectBadge={!!groupFilter}
            />
          ))}
          {sideOpen && (
            <div className="side-group" ref={sideRef}>
              {SIDE_STATUSES.map((s) => (
                <Column
              key={s}
              status={s}
              tasks={byStatus.get(s) ?? []}
              onOpen={(id) => setParam('task', id)}
              projectName={projectName}
              milestoneTitle={milestoneTitle}
              describeTask={describeTask}
              showProject={!projectFilter}
              projectBadge={!!groupFilter}
            />
              ))}
            </div>
          )}
        </div>
      )}

      {creating && (
        <NewTaskModal
          projects={group && activeMembers.length ? projects.filter((p) => activeMembers.includes(p.slug)) : projects}
          defaultProject={projectFilter || activeMembers[0]}
          defaultMilestone={milestoneFilter && milestoneFilter !== 'none' ? milestoneFilter : undefined}
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            setTasks((ts) => (ts && !ts.some((x) => x.id === t.id) ? [t, ...ts] : ts));
            toast(`Created "${t.title}"`);
          }}
        />
      )}
      {openTask && <TaskDrawer taskId={openTask} onClose={() => setParam('task', null)} />}
    </div>
  );
}

function Column({
  status,
  tasks,
  onOpen,
  projectName,
  milestoneTitle,
  describeTask,
  showProject,
  projectBadge,
}: {
  status: TaskStatus;
  tasks: Task[];
  onOpen: (id: string) => void;
  projectName: (slug: string) => string;
  milestoneTitle: (id: string | null) => string | null;
  describeTask: (id: string) => string;
  showProject: boolean;
  /** Group view: the project as a badge on the card instead of the muted footer text. */
  projectBadge: boolean;
}) {
  return (
    <section className={`column col-${status}`}>
      <h2 className="column-head">
        <StatusEmoji status={status} /> {STATUS_LABEL[status]} <span className="count">{tasks.length}</span>
      </h2>
      <div className="column-body">
        {tasks.map((t) => {
          const ms = milestoneTitle(t.milestone_id);
          return (
          <button key={t.id} type="button" className={cx('task-card', `card-${t.status}`)} aria-label={t.title} onClick={() => onOpen(t.id)}>
            {t.status === 'in_progress' && <WorkingChip />}
            {t.status === 'waiting_for_human' && <span className="needs-you">{t.waiting_for ? '📌 Waiting for you' : '🙋 Needs your answer'}</span>}
            <span className="task-title">{t.title}</span>
            <span className="task-badges">
              {projectBadge && (
                <span className="badge proj-chip" title={`Project: ${projectName(t.project_slug)}`}>
                  {projectName(t.project_slug)}
                </span>
              )}
              <PlannerBadge task={t} />
              {t.priority !== 2 && <PriorityBadge priority={t.priority} />}
              <GitBadge task={t} />
              <VerifyBadge task={t} />
              <WaitingBadge task={t} describe={describeTask} />
              {t.open_actions > 0 && (
                <span className="badge q" title="To-dos Claude handed you">
                  📌 {t.open_actions}
                </span>
              )}
              {t.unread_updates > 0 && (
                <span className="badge running" title="Updates from Claude you have not read">
                  📣 {t.unread_updates}
                </span>
              )}
              {t.question_count > 0 && (
                <span className="badge q" title="Questions asked">
                  💬 {t.question_count}
                </span>
              )}
              {ms && (
                <span className="badge ms-chip" title={`Milestone: ${ms}`}>
                  🎯 {ms}
                </span>
              )}
            </span>
            <span className="task-foot">
              {showProject && !projectBadge && <span className="proj">{projectName(t.project_slug)}</span>}
              <span className="muted">{timeAgo(t.updated_at)}</span>
            </span>
          </button>
          );
        })}
        {tasks.length === 0 && <div className="column-empty">{EMPTY_COLUMN[status]}</div>}
      </div>
    </section>
  );
}
