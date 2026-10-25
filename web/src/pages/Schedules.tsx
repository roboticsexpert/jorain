import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Priority, Project, Schedule, ScheduleKind } from '../api/types';
import { ConfirmButton, Empty, ErrorBox, Modal, PriorityBadge, Spinner } from '../components/ui';
import { useLive, useReconnect, useSse } from '../live';
import { cx, errorMessage, fullDate, timeAgo } from '../lib/util';

// ---------- cron <-> friendly builder ----------

type Freq = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

interface Builder {
  freq: Freq;
  /** HH:MM (minute only for hourly). */
  time: string;
  everyHours: number;
  days: number[];
  dom: number;
  custom: string;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad2 = (n: number) => String(n).padStart(2, '0');

const DEFAULT_BUILDER: Builder = { freq: 'daily', time: '09:00', everyHours: 1, days: [1], dom: 1, custom: '0 9 * * *' };

function toCron(b: Builder): string {
  const [h, m] = b.time.split(':').map(Number);
  switch (b.freq) {
    case 'hourly':
      return `${m || 0} ${b.everyHours > 1 ? `*/${b.everyHours}` : '*'} * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'weekly':
      return `${m} ${h} * * ${[...b.days].sort().join(',') || '1'}`;
    case 'monthly':
      return `${m} ${h} ${b.dom} * *`;
    default:
      return b.custom.trim();
  }
}

const NUM = /^\d+$/;

/** Reads a cron expression back into the builder; anything it did not produce is `custom`. */
function fromCron(cron: string): Builder {
  const base = { ...DEFAULT_BUILDER, custom: cron };
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || !NUM.test(f[0])) return { ...base, freq: 'custom' };
  const [mi, hr, dom, mon, dow] = f;
  if (mon !== '*') return { ...base, freq: 'custom' };
  const step = /^\*\/(\d+)$/.exec(hr);
  if ((hr === '*' || step) && dom === '*' && dow === '*') return { ...base, freq: 'hourly', time: `00:${pad2(+mi)}`, everyHours: step ? +step[1] : 1 };
  if (!NUM.test(hr)) return { ...base, freq: 'custom' };
  const time = `${pad2(+hr)}:${pad2(+mi)}`;
  if (dom === '*' && dow === '*') return { ...base, freq: 'daily', time };
  if (dom === '*' && dow === '1-5') return { ...base, freq: 'weekdays', time };
  if (dom === '*' && /^[0-6](,[0-6])*$/.test(dow)) return { ...base, freq: 'weekly', time, days: dow.split(',').map(Number) };
  if (NUM.test(dom) && dow === '*') return { ...base, freq: 'monthly', time, dom: +dom };
  return { ...base, freq: 'custom' };
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

function describeCron(cron: string): string {
  const b = fromCron(cron);
  switch (b.freq) {
    case 'hourly':
      return `${b.everyHours > 1 ? `Every ${b.everyHours} hours` : 'Every hour'} at :${b.time.slice(3)}`;
    case 'daily':
      return `Every day at ${b.time}`;
    case 'weekdays':
      return `Weekdays at ${b.time}`;
    case 'weekly':
      return `Every ${b.days.map((d) => DAY_NAMES[d]).join(', ')} at ${b.time}`;
    case 'monthly':
      return `The ${ordinal(b.dom)} of every month at ${b.time}`;
    default:
      return `cron ${cron}`;
  }
}

function describe(s: Schedule): string {
  return s.kind === 'once' ? `Once, ${fullDate(s.run_at)}` : describeCron(s.cron ?? '');
}

function timeUntil(iso: string | null): string {
  if (!iso) return '';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  if (diff < 60) return 'due now';
  if (diff < 3600) return `in ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `in ${Math.round(diff / 3600)} h`;
  return `in ${Math.round(diff / 86400)} d`;
}

/** ISO → value for <input type="datetime-local"> in the browser's time zone. */
function toLocalInput(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + 3_600_000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ---------- page ----------

export function SchedulesPage() {
  const { toastError } = useLive();
  const [params, setParams] = useSearchParams();
  const project = params.get('project') ?? '';
  const [projects, setProjects] = useState<Project[]>([]);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      const [ps, ss] = await Promise.all([api.projects(), api.schedules()]);
      setProjects(ps);
      setSchedules(ss);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useReconnect(load);

  const upsert = (s: Schedule) => setSchedules((list) => (list?.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...(list ?? []), s]));
  useSse((type, data) => {
    if (type === 'schedule.updated') upsert(data as Schedule);
    if (type === 'schedule.deleted') setSchedules((list) => list?.filter((x) => x.id !== (data as { id: string }).id) ?? null);
  });

  const shown = (schedules ?? [])
    .filter((s) => !project || s.project_slug === project)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.next_run_at ?? '9').localeCompare(b.next_run_at ?? '9'));
  const projectName = (slug: string) => projects.find((p) => p.slug === slug)?.name ?? slug;

  return (
    <div className="page schedules-page">
      <div className="toolbar">
        <h1>Schedules</h1>
        <select
          value={project}
          onChange={(e) => setParams(e.target.value ? { project: e.target.value } : {})}
          aria-label="Filter by project"
        >
          <option value="">All projects</option>
          {projects
            .filter((p) => p.status === 'active')
            .map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
        </select>
        <span className="grow" />
        <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
          + New schedule
        </button>
      </div>
      <p className="muted small">
        A schedule queues a task at a set time, once or on repeat. Auto tasks then run by themselves and land in review with the agent's report; a
        repeating check gets the previous run's result in its prompt. Times are the server's local time.
      </p>
      {error && <ErrorBox error={error} onRetry={load} />}
      {!schedules && !error && <Spinner />}
      {schedules && shown.length === 0 && (
        <Empty emoji="⏰">
          No schedules yet.{' '}
          <button type="button" className="btn-ghost" onClick={() => setEditing('new')}>
            Schedule a task
          </button>
        </Empty>
      )}
      <ul className="sched-list">
        {shown.map((s) => (
          <ScheduleCard key={s.id} schedule={s} projectName={projectName(s.project_slug)} onEdit={() => setEditing(s)} onChanged={upsert} onError={toastError} />
        ))}
      </ul>
      {editing && (
        <ScheduleModal
          projects={projects}
          initial={editing === 'new' ? undefined : editing}
          defaultProject={project}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            upsert(s);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ScheduleCard({
  schedule: s,
  projectName,
  onEdit,
  onChanged,
  onError,
}: {
  schedule: Schedule;
  projectName: string;
  onEdit: () => void;
  onChanged: (s: Schedule) => void;
  onError: (e: unknown) => void;
}) {
  const { toast } = useLive();
  const [busy, setBusy] = useState(false);
  const finished = s.kind === 'once' && s.run_count > 0 && !s.enabled;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={cx('card sched-item', !s.enabled && 'off')}>
      <div className="row">
        <span className="sched-icon" aria-hidden="true">
          {s.kind === 'once' ? '📅' : '🔁'}
        </span>
        <b className="sched-title">{s.title}</b>
        {s.priority !== 2 && <PriorityBadge priority={s.priority} />}
        <span className="grow" />
        <label className="switch" title={s.enabled ? 'On: queues tasks on time' : 'Off'}>
          <input
            type="checkbox"
            checked={s.enabled}
            disabled={busy}
            onChange={(e) => run(async () => onChanged(await api.updateSchedule(s.id, { enabled: e.target.checked })))}
          />
          {s.enabled ? 'On' : 'Off'}
        </label>
      </div>
      <div className="sched-meta small">
        <span>🧩 {projectName}</span>
        <span>⏰ {describe(s)}</span>
        {s.next_run_at ? (
          <span title={fullDate(s.next_run_at)}>
            ⏭️ next {fullDate(s.next_run_at)} <span className="muted">({timeUntil(s.next_run_at)})</span>
          </span>
        ) : (
          <span className="muted">{finished ? '✅ done' : '⏸️ paused'}</span>
        )}
        {s.last_run_at && (
          <span title={fullDate(s.last_run_at)}>
            ↩️ last {timeAgo(s.last_run_at)}
            {s.last_task_id && (
              <>
                {' · '}
                <Link to={`/board?task=${s.last_task_id}`}>{s.last_task_id}</Link>
              </>
            )}
          </span>
        )}
        <span className="muted">
          {s.run_count} run{s.run_count === 1 ? '' : 's'}
        </span>
      </div>
      {s.body && <p className="small muted sched-body">{s.body}</p>}
      <div className="row end">
        <button
          type="button"
          className="btn-ghost"
          disabled={busy}
          title="Queue the task now; the schedule keeps its next run"
          onClick={() =>
            run(async () => {
              const t = await api.runSchedule(s.id);
              toast(`Queued ${t.id}`);
            })
          }
        >
          ▶ Run now
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onEdit}>
          ✎ Edit
        </button>
        <ConfirmButton className="btn-ghost danger" disabled={busy} confirmLabel="Delete schedule" onConfirm={() => run(() => api.deleteSchedule(s.id))}>
          Delete
        </ConfirmButton>
      </div>
    </li>
  );
}

function ScheduleModal({
  projects,
  initial,
  defaultProject,
  onClose,
  onSaved,
}: {
  projects: Project[];
  initial?: Schedule;
  defaultProject?: string;
  onClose: () => void;
  onSaved: (s: Schedule) => void;
}) {
  const { toastError } = useLive();
  const active = projects.filter((p) => p.status === 'active' || p.slug === initial?.project_slug);
  const [slug, setSlug] = useState(initial?.project_slug ?? (active.some((p) => p.slug === defaultProject) ? defaultProject! : (active[0]?.slug ?? '')));
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? 2);
  const [kind, setKind] = useState<ScheduleKind>(initial?.kind ?? 'once');
  const [runAt, setRunAt] = useState(toLocalInput(initial?.run_at ?? null));
  const [b, setB] = useState<Builder>(initial?.cron ? fromCron(initial.cron) : DEFAULT_BUILDER);
  const [preview, setPreview] = useState<{ next: string[] } | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const cron = toCron(b);
  const set = (p: Partial<Builder>) => setB((x) => ({ ...x, ...p }));

  useEffect(() => {
    if (kind !== 'recurring') return;
    let stale = false;
    const t = setTimeout(() => {
      api
        .cronPreview(cron)
        .then((r) => !stale && setPreview(r))
        .catch((e) => !stale && setPreview({ error: errorMessage(e) }));
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [kind, cron]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const timing = kind === 'once' ? { kind, run_at: new Date(runAt).toISOString() } : { kind, cron };
    try {
      const fields = { title: title.trim(), body, priority, ...timing };
      onSaved(initial ? await api.updateSchedule(initial.id, fields) : await api.createSchedule({ project_slug: slug, ...fields }));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  const pastOnce = kind === 'once' && new Date(runAt).getTime() < Date.now() - 60_000;

  return (
    <Modal title={initial ? 'Edit schedule' : 'New schedule'} onClose={onClose}>
      {active.length === 0 ? (
        <p>Create a project first.</p>
      ) : (
        <form className="form" onSubmit={submit}>
          <label>
            Project
            <select value={slug} disabled={!!initial} onChange={(e) => setSlug(e.target.value)}>
              {active.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Title
            <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Check whether the payment arrived" />
          </label>
          <label>
            What to do or check <span className="hint">markdown; say what to report</span>
            <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>

          <div className="seg" role="radiogroup" aria-label="When">
            {(['once', 'recurring'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={cx(kind === k && 'on')} onClick={() => setKind(k)}>
                {k === 'once' ? '📅 One time' : '🔁 Repeating'}
              </button>
            ))}
          </div>

          {kind === 'once' ? (
            <label>
              Run at
              <input type="datetime-local" required value={runAt} onChange={(e) => setRunAt(e.target.value)} />
              {pastOnce && <span className="hint">This time has passed: the task is queued right away.</span>}
            </label>
          ) : (
            <>
              <div className="grid3">
                <label>
                  Repeat
                  <select value={b.freq} onChange={(e) => set({ freq: e.target.value as Freq, custom: cron, ...(b.freq === 'hourly' ? { time: '09:00' } : {}) })}>
                    <option value="hourly">Every few hours</option>
                    <option value="daily">Every day</option>
                    <option value="weekdays">Weekdays (Mon–Fri)</option>
                    <option value="weekly">On days of the week</option>
                    <option value="monthly">Once a month</option>
                    <option value="custom">Custom (cron)</option>
                  </select>
                </label>
                {b.freq === 'hourly' && (
                  <>
                    <label>
                      Every
                      <select value={b.everyHours} onChange={(e) => set({ everyHours: Number(e.target.value) })}>
                        {[1, 2, 3, 4, 6, 8, 12].map((n) => (
                          <option key={n} value={n}>
                            {n} hour{n === 1 ? '' : 's'}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      At minute
                      <input
                        type="number"
                        min={0}
                        max={59}
                        value={Number(b.time.slice(3))}
                        onChange={(e) => set({ time: `00:${pad2(Math.min(59, Math.max(0, Number(e.target.value) || 0)))}` })}
                      />
                    </label>
                  </>
                )}
                {b.freq === 'monthly' && (
                  <label>
                    Day
                    <select value={b.dom} onChange={(e) => set({ dom: Number(e.target.value) })}>
                      {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                        <option key={d} value={d}>
                          {ordinal(d)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {b.freq !== 'hourly' && b.freq !== 'custom' && (
                  <label>
                    Time
                    <input type="time" required value={b.time} onChange={(e) => set({ time: e.target.value })} />
                  </label>
                )}
                {b.freq === 'custom' && (
                  <label className="span2">
                    Cron <span className="hint">min hour day month weekday</span>
                    <input className="mono" value={b.custom} onChange={(e) => set({ custom: e.target.value })} placeholder="0 9 * * 1" />
                  </label>
                )}
              </div>
              {b.freq === 'weekly' && (
                <div className="day-picks" role="group" aria-label="Days of the week">
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={b.days.includes(d)}
                      className={cx(b.days.includes(d) && 'on')}
                      onClick={() => set({ days: b.days.includes(d) ? b.days.filter((x) => x !== d) : [...b.days, d] })}
                    >
                      {DAY_NAMES[d]}
                    </button>
                  ))}
                </div>
              )}
              <p className="small sched-preview">
                <span className="mono muted">{cron || '—'}</span>
                {preview && 'error' in preview && <span className="danger"> {preview.error}</span>}
                {preview && 'next' in preview && <span className="muted"> · next: {preview.next.map((x) => fullDate(x)).join(' · ')}</span>}
              </p>
            </>
          )}

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
          <div className="row end">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={busy || !title.trim() || (kind === 'recurring' && (!cron || (b.freq === 'weekly' && !b.days.length)))}
            >
              {initial ? 'Save' : 'Create schedule'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
