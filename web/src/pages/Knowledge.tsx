import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Group, Note, NoteFile, Project, SearchHit } from '../api/types';
import { ConfirmButton, Empty, ErrorBox, Markdown, Modal, Spinner } from '../components/ui';
import { useLive, useReconnect, useSse } from '../live';
import { buildNote, slugify, splitFrontmatter } from '../lib/frontmatter';
import { cx, errorMessage } from '../lib/util';

const scopeDir = (scope: string) =>
  scope === 'global'
    ? 'knowledge'
    : scope.startsWith('group:')
      ? `groups/${scope.slice('group:'.length)}/knowledge`
      : `projects/${scope.slice('project:'.length)}/knowledge`;

function scopeLabel(scope: string, projects: Project[], groups: Group[]) {
  if (scope === 'global') return 'Global';
  if (scope.startsWith('group:')) {
    const slug = scope.slice('group:'.length);
    return `🧩 ${groups.find((g) => g.slug === slug)?.name ?? slug}`;
  }
  const slug = scope.slice('project:'.length);
  return projects.find((p) => p.slug === slug)?.name ?? slug;
}

export function KnowledgePage() {
  const [params, setParams] = useSearchParams();
  const path = params.get('path');
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [groupList, setGroupList] = useState<Group[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchScope, setSearchScope] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ns, ps, gs] = await Promise.all([api.notes(), api.projects(), api.groups().catch(() => [] as Group[])]);
      setNotes(ns);
      setProjects(ps);
      setGroupList(gs);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useReconnect(load);
  useSse((type) => {
    if (type === 'knowledge.changed' || type === 'group.updated' || type === 'group.deleted') void load();
  });

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .search(q, searchScope || undefined)
        .then(setHits)
        .catch((e) => setError(errorMessage(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [query, searchScope]);

  // Scopes in reading order: global, then each group followed by its projects, then ungrouped projects.
  const groups = useMemo(() => {
    const active = projects.filter((p) => p.status === 'active');
    const sorted = groupList.slice().sort((a, b) => a.name.localeCompare(b.name));
    const scopes = ['global'];
    for (const g of sorted) {
      scopes.push(`group:${g.slug}`);
      for (const p of active) if (g.projects.includes(p.slug)) scopes.push(`project:${p.slug}`);
    }
    for (const p of active) if (!scopes.includes(`project:${p.slug}`)) scopes.push(`project:${p.slug}`);
    for (const n of notes ?? []) if (!scopes.includes(n.scope)) scopes.push(n.scope);
    return scopes.map((s) => ({
      scope: s,
      label: scopeLabel(s, projects, groupList),
      notes: (notes ?? []).filter((n) => n.scope === s),
    }));
  }, [notes, projects, groupList]);

  const open = (p: string | null, edit = false) => {
    const next = new URLSearchParams(params);
    if (p) next.set('path', p);
    else next.delete('path');
    setParams(next);
    setEditing(edit);
  };

  return (
    <div className="page knowledge-page">
      <aside className="kb-side">
        <div className="toolbar">
          <h1>Knowledge</h1>
          <span className="grow" />
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            + New note
          </button>
        </div>
        <div className="kb-search">
          <input type="search" placeholder="Search notes…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search notes" />
          <select value={searchScope} onChange={(e) => setSearchScope(e.target.value)} aria-label="Search scope">
            <option value="">All scopes</option>
            {groups.map((g) => (
              <option key={g.scope} value={g.scope}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
        {error && <ErrorBox error={error} onRetry={load} />}
        {!notes && !error && <Spinner />}
        {hits ? (
          <ul className="kb-hits">
            {hits.length === 0 && <li className="muted">No matches.</li>}
            {hits.map((h) => (
              <li key={h.path}>
                <button type="button" className={cx('kb-hit', h.path === path && 'on')} onClick={() => open(h.path)}>
                  <span className="kb-title">{h.title}</span>
                  <span className="muted small">{scopeLabel(h.scope, projects, groupList)}</span>
                  <span className="snippet">{highlight(h.snippet)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          notes &&
          groups.map((g) => (
            <div key={g.scope} className="kb-group">
              <h2>{g.label}</h2>
              <ul>
                {g.notes.length === 0 && <li className="muted small">No notes yet.</li>}
                {g.notes.map((n) => (
                  <li key={n.path}>
                    <button type="button" className={cx('kb-item', n.path === path && 'on')} onClick={() => open(n.path)} title={n.path}>
                      {n.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </aside>

      <main className="kb-main">
        {path ? (
          <NoteView key={path} path={path} editing={editing} setEditing={setEditing} onDeleted={() => open(null)} />
        ) : (
          <Empty emoji="📚">Pick a note on the left, search, or create a new one.</Empty>
        )}
      </main>

      {creating && (
        <NewNoteModal
          scopes={groups.map((g) => ({ scope: g.scope, label: g.label }))}
          existing={new Set((notes ?? []).map((n) => n.path))}
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            void load();
            open(p, true);
          }}
        />
      )}
    </div>
  );
}

function NoteView({
  path,
  editing,
  setEditing,
  onDeleted,
}: {
  path: string;
  editing: boolean;
  setEditing: (b: boolean) => void;
  onDeleted: () => void;
}) {
  const { toast, toastError } = useLive();
  const [note, setNote] = useState<NoteFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const n = await api.note(path);
      setNote(n);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (editing && note) setDraft(note.content);
  }, [editing, note]);

  useReconnect(() => !editing && load());
  useSse((type, data) => {
    if (type === 'knowledge.changed' && (data as { path: string }).path === path && !editing) void load();
  });

  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!note) return <Spinner />;

  const { body } = splitFrontmatter(note.content);
  const fm = note.frontmatter;
  const title = typeof fm.title === 'string' ? fm.title : path.split('/').pop();
  const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
  const extra = Object.entries(fm).filter(([k]) => !['title', 'tags', 'updated'].includes(k));

  async function save() {
    setBusy(true);
    try {
      await api.saveNote(path, draft);
      toast('Note saved');
      setEditing(false);
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      await api.deleteNote(path);
      toast('Note deleted');
      onDeleted();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <article className="note">
      <header className="note-head">
        <div>
          <h2>{title}</h2>
          <div className="note-meta">
            <span className="mono muted">{path}</span>
            {fm.updated != null && <span className="muted">updated {String(fm.updated)}</span>}
            {tags.map((t) => (
              <span key={t} className="tag">
                #{t}
              </span>
            ))}
            {extra.map(([k, v]) => (
              <span key={k} className="muted">
                {k}: {typeof v === 'string' ? v : JSON.stringify(v)}
              </span>
            ))}
          </div>
        </div>
        <div className="row">
          {editing ? (
            <>
              <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" disabled={busy || draft === note.content} onClick={save}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setEditing(true)}>
                ✎ Edit
              </button>
              <ConfirmButton className="btn-ghost danger" confirmLabel="Delete note" onConfirm={remove}>
                Delete
              </ConfirmButton>
            </>
          )}
        </div>
      </header>
      {editing ? (
        <textarea
          className="note-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck
          autoFocus
          aria-label="Note content"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault();
              void save();
            }
          }}
        />
      ) : (
        <Markdown source={body} className="note-body" />
      )}
    </article>
  );
}

function NewNoteModal({
  scopes,
  existing,
  onClose,
  onCreated,
}: {
  scopes: { scope: string; label: string }[];
  existing: Set<string>;
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const { toastError } = useLive();
  const [scope, setScope] = useState('global');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const fileName = (file.trim() || slugify(title)).replace(/\.md$/, '');
  const path = `${scopeDir(scope)}/${fileName}.md`;
  const clash = existing.has(path);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
      await api.saveNote(path, buildNote(title.trim(), tagList, `# ${title.trim()}\n`));
      onCreated(path);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New note" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            {scopes.map((s) => (
              <option key={s.scope} value={s.scope}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Title
          <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          File name <span className="hint">optional, defaults to the title</span>
          <input value={file} onChange={(e) => setFile(slugify(e.target.value))} placeholder={slugify(title) || 'my-note'} />
        </label>
        <label>
          Tags <span className="hint">comma separated</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        <div className={cx('mono small', clash ? 'danger' : 'muted')}>
          {path}
          {clash && ' — already exists'}
        </div>
        <div className="row end">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !title.trim() || !fileName || clash}>
            Create and edit
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Search snippets mark matches with **…** (FTS5 snippet()); show those parts bold. */
function highlight(snippet: string) {
  return snippet
    .replace(/\s+/g, ' ')
    .split('**')
    .map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}
