import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import type { Group, McpConfig, Milestone, Project, PushPolicy, SseType } from '../api/types';
import { upsertGroup, useGroups } from '../components/groups';
import { useMilestones } from '../components/milestones';
import { ConfirmButton, Empty, ErrorBox, MilestoneBar, Spinner } from '../components/ui';
import { useLive, useReconnect, useSse } from '../live';
import { cx, errorMessage, timeAgo } from '../lib/util';

export function ProjectsPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('slug');
  const isNew = params.get('new') === '1';
  const selectedGroup = params.get('group');
  const isNewGroup = params.get('newgroup') === '1';
  const [projects, setProjects] = useState<Project[] | null>(null);
  const { groups, setGroups, reload: reloadGroups } = useGroups();
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    try {
      setProjects(await api.projects());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Show one thing in the main pane: a project (`slug`), a group (`group`) or a new-form flag. */
  const select = (key: 'slug' | 'group' | 'new' | 'newgroup' | null, value = '1') => {
    const next = new URLSearchParams();
    if (key) next.set(key, value);
    setParams(next);
  };

  const upsert = (p: Project) =>
    setProjects((ps) => (ps ? (ps.some((x) => x.slug === p.slug) ? ps.map((x) => (x.slug === p.slug ? p : x)) : [...ps, p]) : ps));

  useReconnect(load);
  useSse((type, data) => {
    if (type === 'project.updated') upsert(data as Project);
    // Membership changes move projects between groups on the server; refetch their group_slug.
    if (type === 'group.updated' || type === 'group.deleted') void load();
  });

  const visible = (projects ?? []).filter((p) => showArchived || p.status === 'active' || p.slug === selected);
  const archivedCount = (projects ?? []).filter((p) => p.status === 'archived').length;
  const current = projects?.find((p) => p.slug === selected);
  const currentGroup = groups.find((g) => g.slug === selectedGroup);
  const ungrouped = visible.filter((p) => !p.group_slug || !groups.some((g) => g.slug === p.group_slug));

  const item = (p: Project) => (
    <li key={p.slug}>
      <button type="button" aria-label={p.name} className={cx('proj-item', p.slug === selected && 'on', p.status === 'archived' && 'archived')} onClick={() => select('slug', p.slug)}>
        <span className="proj-name">{p.name}</span>
        <span className="muted small mono">{p.slug}</span>
        <span className="small">
          {p.status === 'archived' && <span className="badge">archived</span>}
          {!p.repo_path && <span className="badge">no repo</span>}
          {p.repo_path && p.push_policy === 'after_merge' && <span className="badge git-pushed">auto-push</span>}
        </span>
      </button>
    </li>
  );

  return (
    <div className="page projects-page">
      <aside className="proj-side">
        <div className="toolbar">
          <h1>Projects</h1>
          <span className="grow" />
          <button type="button" className="btn-ghost" onClick={() => select('newgroup')} title="Tie several projects (e.g. backend + frontend) into one product">
            + Group
          </button>
          <button type="button" className="btn-primary" onClick={() => select('new')}>
            + New
          </button>
        </div>
        {error && <ErrorBox error={error} onRetry={load} />}
        {!projects && !error && <Spinner />}
        <ul className="proj-list">
          {groups.map((g) => (
            <li key={g.slug} className="proj-group">
              <button type="button" aria-label={`Group ${g.name}`} className={cx('proj-item proj-group-head', g.slug === selectedGroup && 'on')} onClick={() => select('group', g.slug)}>
                <span className="proj-name">🧩 {g.name}</span>
                <span className="muted small">
                  {g.projects.length} project{g.projects.length === 1 ? '' : 's'}
                </span>
              </button>
              <ul className="proj-list proj-members">{visible.filter((p) => p.group_slug === g.slug).map(item)}</ul>
            </li>
          ))}
          {groups.length > 0 && ungrouped.length > 0 && <li className="proj-list-label">Ungrouped</li>}
          {ungrouped.map(item)}
        </ul>
        {archivedCount > 0 && (
          <label className="small muted">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived ({archivedCount})
          </label>
        )}
      </aside>

      <main className="proj-main">
        {isNew ? (
          <ProjectForm
            key="new"
            groups={groups}
            onSaved={(p) => {
              upsert(p);
              void reloadGroups();
              select('slug', p.slug);
            }}
            onCancel={() => select(null)}
          />
        ) : isNewGroup ? (
          <GroupForm
            key="newgroup"
            projects={projects ?? []}
            groups={groups}
            onSaved={(g) => {
              setGroups((gs) => upsertGroup(gs, g));
              void load();
              select('group', g.slug);
            }}
            onCancel={() => select(null)}
          />
        ) : current ? (
          <ProjectDetail
            key={current.slug}
            project={current}
            groups={groups}
            onSaved={(p) => {
              upsert(p);
              void reloadGroups();
            }}
          />
        ) : currentGroup ? (
          <GroupDetail
            key={currentGroup.slug}
            group={currentGroup}
            projects={projects ?? []}
            groups={groups}
            onSaved={(g) => {
              setGroups((gs) => upsertGroup(gs, g));
              void load();
            }}
            onDeleted={() => {
              setGroups((gs) => gs.filter((x) => x.slug !== currentGroup.slug));
              void load();
              select(null);
            }}
          />
        ) : (
          projects && <Empty emoji="🧩">{projects.length ? 'Pick a project or group on the left.' : 'No projects yet. Create one to start adding tasks.'}</Empty>
        )}
      </main>
    </div>
  );
}

function ProjectDetail({ project, groups, onSaved }: { project: Project; groups: Group[]; onSaved: (p: Project) => void }) {
  const { toast, toastError } = useLive();
  const archived = project.status === 'archived';

  async function setStatus(status: Project['status']) {
    try {
      onSaved(await api.updateProject(project.slug, { status }));
      toast(status === 'archived' ? 'Project archived' : 'Project restored');
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="proj-detail">
      <header className="row">
        <h2>{project.name}</h2>
        <span className="muted small">updated {timeAgo(project.updated_at)}</span>
        <span className="grow" />
        <Link className="btn-ghost" to={`/board?project=${project.slug}`}>
          Open board
        </Link>
        <Link className="btn-ghost" to={`/knowledge`}>
          Knowledge
        </Link>
        {archived ? (
          <button type="button" onClick={() => setStatus('active')}>
            Restore
          </button>
        ) : (
          <ConfirmButton className="btn-ghost danger" confirmLabel="Archive project" onConfirm={() => setStatus('archived')}>
            Archive
          </ConfirmButton>
        )}
      </header>
      {archived && <div className="notice">This project is archived. Its tasks are kept; it is hidden from the board filter and the new-task form.</div>}
      <ProjectForm project={project} groups={groups} onSaved={(p) => (onSaved(p), toast('Project saved'))} />
      {!archived && <PlanBox project={project} />}
      <MilestonesSection slug={project.slug} />
      <DocEditor kind="project" slug={project.slug} />
      <McpView slug={project.slug} />
    </div>
  );
}

function ProjectForm({
  project,
  groups,
  onSaved,
  onCancel,
}: {
  project?: Project;
  groups: Group[];
  onSaved: (p: Project) => void;
  onCancel?: () => void;
}) {
  const { toastError } = useLive();
  const [slug, setSlug] = useState(project?.slug ?? '');
  const [name, setName] = useState(project?.name ?? '');
  const [repo, setRepo] = useState(project?.repo_path ?? '');
  const [model, setModel] = useState(project?.model ?? '');
  const [tools, setTools] = useState<string[]>(project?.allowed_tools ?? []);
  const [pushPolicy, setPushPolicy] = useState<PushPolicy>(project?.push_policy ?? 'never');
  const [verify, setVerify] = useState(project?.verify_command ?? '');
  const [setup, setSetup] = useState(project?.setup_command ?? '');
  const [maxParallel, setMaxParallel] = useState(project?.max_parallel ?? 1);
  const [autoPlan, setAutoPlan] = useState(project?.auto_plan ?? false);
  const [group, setGroup] = useState(project?.group_slug ?? '');
  const [newTool, setNewTool] = useState('');
  const [busy, setBusy] = useState(false);
  const slugOk = /^[a-z0-9-]+$/.test(slug);

  const addTool = () => {
    const t = newTool.trim();
    if (t && !tools.includes(t)) setTools([...tools, t]);
    setNewTool('');
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const fields = {
      name: name.trim(),
      repo_path: repo.trim() || null,
      model: model.trim() || null,
      allowed_tools: tools,
      push_policy: pushPolicy,
      verify_command: verify.trim() || null,
      setup_command: setup.trim() || null,
      max_parallel: Math.min(10, Math.max(1, Math.round(maxParallel) || 1)),
      auto_plan: autoPlan,
      group_slug: group || null,
    };
    try {
      onSaved(project ? await api.updateProject(project.slug, fields) : await api.createProject({ slug, ...fields }));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form proj-form" onSubmit={submit}>
      {!project && <h2>New project</h2>}
      <div className="grid2">
        <label>
          Slug
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            disabled={!!project}
            required
            placeholder="my-project"
            aria-invalid={!!slug && !slugOk}
          />
          {!project && slug && !slugOk && <span className="danger small">Only a–z, 0–9 and dashes.</span>}
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
      </div>
      {(groups.length > 0 || group) && (
        <label>
          Group <span className="hint">projects in one group make one product: their agents read GROUP.md and see each other</span>
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">None</option>
            {groups.map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name}
              </option>
            ))}
            {group && !groups.some((g) => g.slug === group) && <option value={group}>{group}</option>}
          </select>
        </label>
      )}
      <label>
        Repository path <span className="hint">absolute path to a git repo; leave empty for non-code projects</span>
        <input className="mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/Users/you/Projects/thing" />
      </label>
      {repo.trim() && (
        <label>
          After approve <span className="hint">approve always squash-merges the task branch into its base branch</span>
          <select value={pushPolicy} onChange={(e) => setPushPolicy(e.target.value as PushPolicy)}>
            <option value="never">merge only — push yourself (or with the Push button)</option>
            <option value="after_merge">merge, then push the base branch to its upstream</option>
          </select>
        </label>
      )}
      <label>
        Model <span className="hint">empty = CLI default</span>
        <input className="mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-opus-5-5" />
      </label>
      {repo.trim() && (
        <>
          <label>
            Verify command <span className="hint">run in the task worktree before review, e.g. pnpm -s test; failures go back to the agent. Empty = none</span>
            <input className="mono" value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="pnpm -s typecheck && pnpm -s test" />
          </label>
          <label>
            Setup command <span className="hint">prepares a fresh worktree, e.g. pnpm install ($BRAIN_REPO = main checkout). Empty = none</span>
            <input className="mono" value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="pnpm install --frozen-lockfile" />
          </label>
        </>
      )}
      <div className="grid2">
        <label>
          Parallel tasks <span className="hint">1–10 running at once, each in its own worktree</span>
          <input type="number" min={1} max={10} value={maxParallel} onChange={(e) => setMaxParallel(Number(e.target.value))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={autoPlan} onChange={(e) => setAutoPlan(e.target.checked)} />
          <span>
            Auto-plan <span className="hint">queue a planner run when the project runs out of open work</span>
          </span>
        </label>
      </div>
      <fieldset className="tools">
        <legend>
          Allowed tools <span className="hint">extra tools to offer the agent (e.g. NotebookEdit, mcp__name__*); agents already have full permissions</span>
        </legend>
        {tools.length === 0 && <div className="muted small">Defaults only.</div>}
        <ul>
          {tools.map((t) => (
            <li key={t}>
              <span className="mono">{t}</span>
              <button type="button" className="btn-ghost icon" aria-label={`Remove ${t}`} onClick={() => setTools(tools.filter((x) => x !== t))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        <div className="row">
          <input
            className="mono grow"
            value={newTool}
            onChange={(e) => setNewTool(e.target.value)}
            placeholder="Bash(pnpm test:*)"
            aria-label="New allowed tool"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTool();
              }
            }}
          />
          <button type="button" onClick={addTool} disabled={!newTool.trim()}>
            Add
          </button>
        </div>
      </fieldset>
      <div className="row end">
        {onCancel && (
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={busy || !name.trim() || (!project && !slugOk)}>
          {project ? 'Save changes' : 'Create project'}
        </button>
      </div>
    </form>
  );
}

function McpView({ slug }: { slug: string }) {
  const [cfg, setCfg] = useState<McpConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<keyof McpConfig>('merged');

  const load = useCallback(() => {
    api
      .projectMcp(slug)
      .then((c) => {
        setCfg(c);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [slug]);
  useEffect(load, [load]);

  return (
    <section className="section">
      <h3>MCP servers</h3>
      <div className="tabs" role="tablist">
        {(['merged', 'project', 'global'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={cx('tab', tab === k && 'on')} onClick={() => setTab(k)}>
            {k}
          </button>
        ))}
      </div>
      {error && <ErrorBox error={error} onRetry={load} />}
      {cfg && <pre className="json">{JSON.stringify(cfg[tab], null, 2)}</pre>}
      <p className="muted small">Read-only. Edit brain/mcp/global.json or brain/projects/{slug}/mcp.json on disk.</p>
    </section>
  );
}

/** Queue a planner run now, with an optional focus for it. */
function PlanBox({ project }: { project: Project }) {
  const { toast, toastError } = useLive();
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);

  async function plan(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const t = await api.planProject(project.slug, focus.trim() || undefined);
      toast(`Planner queued (${t.id})`);
      setFocus('');
    } catch (err) {
      // 409: a planner task for this project is not done yet.
      if (err instanceof ApiError && err.status === 409) toast(err.message);
      else toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <h3>🧭 Planner</h3>
      <form className="row" onSubmit={plan}>
        <input
          className="grow"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="Optional focus, e.g. “get the beta out” "
          aria-label="Planner focus"
        />
        <button type="submit" className="btn-primary" disabled={busy}>
          Plan next steps
        </button>
      </form>
      <p className="muted small">
        A planner run asks what is unclear, rewrites PROJECT.md, adds milestones and queues the next tasks in the inbox. It lands in review
        like any task.
      </p>
    </section>
  );
}

function MilestonesSection({ slug }: { slug: string }) {
  const { toastError } = useLive();
  const { milestones, setMilestones } = useMilestones(slug);
  const [adding, setAdding] = useState(false);

  const upsert = (m: Milestone) =>
    setMilestones((ms) => (ms.some((x) => x.id === m.id) ? ms.map((x) => (x.id === m.id ? m : x)) : [...ms, m]).sort((a, b) => a.position - b.position));

  async function create(f: MilestoneFields) {
    try {
      upsert(await api.createMilestone(slug, f));
      setAdding(false);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <section className="section">
      <div className="row">
        <h3>🎯 Milestones</h3>
        <span className="grow" />
        {!adding && (
          <button type="button" className="btn-ghost" onClick={() => setAdding(true)}>
            + Add
          </button>
        )}
      </div>
      {adding && <MilestoneForm onSubmit={create} onCancel={() => setAdding(false)} submitLabel="Add milestone" />}
      {milestones.length === 0 && !adding && <p className="muted">No milestones yet. Add one, or let the planner propose them.</p>}
      <ul className="ms-list">
        {milestones.map((m) => (
          <MilestoneItem key={m.id} milestone={m} onSaved={upsert} onDeleted={() => setMilestones((ms) => ms.filter((x) => x.id !== m.id))} />
        ))}
      </ul>
    </section>
  );
}

function MilestoneItem({ milestone, onSaved, onDeleted }: { milestone: Milestone; onSaved: (m: Milestone) => void; onDeleted: () => void }) {
  const { toastError } = useLive();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const done = milestone.status === 'done';

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li>
        <MilestoneForm
          initial={milestone}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={(f) =>
            run(async () => {
              onSaved(await api.updateMilestone(milestone.id, f));
              setEditing(false);
            })
          }
        />
      </li>
    );
  }
  return (
    <li className={done ? 'card ms-item done' : 'card ms-item'}>
      <MilestoneBar milestone={milestone} />
      {milestone.description && <p className="small muted">{milestone.description}</p>}
      <div className="row end">
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => setEditing(true)}>
          ✎ Edit
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={busy}
          onClick={() => run(async () => onSaved(await api.updateMilestone(milestone.id, { status: done ? 'open' : 'done' })))}
        >
          {done ? '↺ Reopen' : '🏁 Mark done'}
        </button>
        <ConfirmButton
          className="btn-ghost danger"
          disabled={busy}
          confirmLabel="Delete milestone"
          onConfirm={() =>
            run(async () => {
              await api.deleteMilestone(milestone.id);
              onDeleted();
            })
          }
        >
          Delete
        </ConfirmButton>
      </div>
    </li>
  );
}

interface MilestoneFields {
  title: string;
  description: string;
  due: string | null;
}

function MilestoneForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Milestone;
  submitLabel: string;
  onSubmit: (f: MilestoneFields) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [due, setDue] = useState(initial?.due ?? '');

  return (
    <form
      className="form card"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ title: title.trim(), description, due: due || null });
      }}
    >
      <div className="grid2">
        <label>
          Title
          <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Beta launch" />
        </label>
        <label>
          Due <span className="hint">optional</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
      </div>
      <label>
        Description <span className="hint">what is true when it is done</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="row end">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={!title.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

// PROJECT.md: the brief every task of the project reads; planner runs rewrite it too.
// GROUP.md: the shared product description every run of every project in the group reads.
const DOCS = {
  project: {
    file: 'PROJECT.md',
    get: api.projectDoc,
    put: api.saveProjectDoc,
    event: 'project.updated',
    placeholder: 'What this project is, its goals and constraints. Every task of the project reads it.',
  },
  group: {
    file: 'GROUP.md',
    get: api.groupDoc,
    put: api.saveGroupDoc,
    event: 'group.updated',
    placeholder: 'What the product is, how its parts talk (API contract, shared types, env/URLs), who owns what. Every task of every project in the group reads it.',
  },
} satisfies Record<string, { file: string; get: unknown; put: unknown; event: SseType; placeholder: string }>;

function DocEditor({ kind, slug }: { kind: keyof typeof DOCS; slug: string }) {
  const doc = DOCS[kind];
  const { toast, toastError } = useLive();
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = saved !== null && draft !== saved;

  const load = useCallback(async () => {
    try {
      const { content } = await doc.get(slug);
      setSaved(content);
      setDraft(content);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [doc, slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // project.updated is also sent when PROJECT.md changes (e.g. a planner rewrote it); keep local edits.
  useReconnect(() => !dirty && load());
  useSse((type, data) => {
    if (type === doc.event && (data as { slug: string }).slug === slug && !dirty) void load();
  });

  async function save() {
    setBusy(true);
    try {
      const { content } = await doc.put(slug, draft);
      setSaved(content);
      setDraft(content);
      toast(`${doc.file} saved`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <div className="row">
        <h3>📄 {doc.file}</h3>
        <span className="grow" />
        {dirty && (
          <button type="button" className="btn-ghost" onClick={() => setDraft(saved ?? '')}>
            Discard
          </button>
        )}
        <button type="button" className="btn-primary" disabled={busy || !dirty} onClick={save}>
          Save
        </button>
      </div>
      {error && <ErrorBox error={error} onRetry={load} />}
      {saved !== null && (
        <textarea
          className="doc-editor"
          rows={14}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={doc.placeholder}
          aria-label={doc.file}
        />
      )}
    </section>
  );
}

function GroupDetail({
  group,
  projects,
  groups,
  onSaved,
  onDeleted,
}: {
  group: Group;
  projects: Project[];
  groups: Group[];
  onSaved: (g: Group) => void;
  onDeleted: () => void;
}) {
  const { toast, toastError } = useLive();

  async function remove() {
    try {
      await api.deleteGroup(group.slug);
      toast(`Group ${group.name} deleted; its projects are ungrouped`);
      onDeleted();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="proj-detail">
      <header className="row">
        <h2>🧩 {group.name}</h2>
        <span className="muted small">updated {timeAgo(group.updated_at)}</span>
        <span className="grow" />
        <Link className="btn-ghost" to={`/board?group=${encodeURIComponent(group.slug)}`}>
          Open board
        </Link>
        <Link className="btn-ghost" to="/knowledge">
          Knowledge
        </Link>
        <ConfirmButton className="btn-ghost danger" confirmLabel="Delete group" onConfirm={remove}>
          Delete
        </ConfirmButton>
      </header>
      <p className="muted small">
        A group ties several projects into one product. Each project keeps its own repo, board and settings; their agents also read GROUP.md and
        the group&apos;s knowledge. Deleting the group keeps the projects.
      </p>
      <GroupForm group={group} projects={projects} groups={groups} onSaved={(g) => (onSaved(g), toast('Group saved'))} />
      <DocEditor kind="group" slug={group.slug} />
    </div>
  );
}

function GroupForm({
  group,
  projects,
  groups,
  onSaved,
  onCancel,
}: {
  group?: Group;
  projects: Project[];
  groups: Group[];
  onSaved: (g: Group) => void;
  onCancel?: () => void;
}) {
  const { toastError } = useLive();
  const [slug, setSlug] = useState(group?.slug ?? '');
  const [name, setName] = useState(group?.name ?? '');
  const [members, setMembers] = useState<string[]>(group?.projects ?? []);
  const [busy, setBusy] = useState(false);
  const slugOk = /^[a-z0-9-]+$/.test(slug);
  // Active projects plus archived members (so they can be removed).
  const choices = projects.filter((p) => p.status === 'active' || members.includes(p.slug));
  const otherGroup = (p: Project) => groups.find((g) => g.slug !== group?.slug && (g.slug === p.group_slug || g.projects.includes(p.slug)));

  const toggle = (sl: string, on: boolean) => setMembers((ms) => (on ? [...ms, sl] : ms.filter((x) => x !== sl)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      onSaved(
        group
          ? await api.updateGroup(group.slug, { name: name.trim(), projects: members })
          : await api.createGroup({ slug, name: name.trim(), projects: members }),
      );
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form proj-form" onSubmit={submit}>
      {!group && <h2>New group</h2>}
      <div className="grid2">
        <label>
          Slug
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            disabled={!!group}
            required
            placeholder="shop"
            aria-invalid={!!slug && !slugOk}
          />
          {!group && slug && !slugOk && <span className="danger small">Only a–z, 0–9 and dashes.</span>}
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Shop" />
        </label>
      </div>
      <fieldset className="tools">
        <legend>
          Projects <span className="hint">a project belongs to one group at most; ticking one from another group moves it here</span>
        </legend>
        {choices.length === 0 && <div className="muted small">No projects yet.</div>}
        <ul>
          {choices.map((p) => {
            const other = otherGroup(p);
            return (
              <li key={p.slug}>
                <label className="member">
                  <input type="checkbox" checked={members.includes(p.slug)} onChange={(e) => toggle(p.slug, e.target.checked)} />
                  <span>{p.name}</span>
                  <span className="muted small mono">{p.slug}</span>
                  {p.status === 'archived' && <span className="badge">archived</span>}
                  {other && !members.includes(p.slug) && <span className="badge">in {other.name}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <div className="row end">
        {onCancel && (
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={busy || !name.trim() || (!group && !slugOk)}>
          {group ? 'Save changes' : 'Create group'}
        </button>
      </div>
    </form>
  );
}
