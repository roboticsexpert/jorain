// Task composer (docs/08-task-composer.md): chat with Claude about a project, get draft tasks, create the ones you want (into the inbox).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { ComposerChat, ComposerDetail, ComposerDraft, ComposerMessage, Priority, Project } from '../api/types';
import { useMilestones } from '../components/milestones';
import { Clawd, ConfirmButton, Empty, ErrorBox, Markdown, PriorityBadge, Spinner } from '../components/ui';
import { useLive, useReconnect, useSse } from '../live';
import { cx, errorMessage, timeAgo } from '../lib/util';

export function ComposePage() {
  const [params, setParams] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [chats, setChats] = useState<ComposerChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = projects.filter((p) => p.status === 'active');
  const slug = params.get('project') || active[0]?.slug || '';
  const chatId = params.get('chat');
  // Drafts may go to any project of the selected project's group.
  const home = projects.find((p) => p.slug === slug);
  const groupProjects = home?.group_slug ? active.filter((p) => p.group_slug === home.group_slug) : home ? [home] : [];

  const setParam = useCallback(
    (changes: Record<string, string | null>) =>
      setParams((p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(changes)) {
          if (v) n.set(k, v);
          else n.delete(k);
        }
        return n;
      }),
    [setParams],
  );

  useEffect(() => {
    api.projects().then(setProjects, (e) => setError(errorMessage(e)));
  }, []);

  const loadChats = useCallback(async () => {
    if (!slug) return;
    try {
      setChats(await api.composerChats(slug));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [slug]);
  useEffect(() => {
    setChats(null);
    void loadChats();
  }, [loadChats]);
  useReconnect(loadChats);

  useSse((type, data) => {
    if (type === 'composer.chat') {
      const c = data as ComposerChat;
      if (c.project_slug !== slug) return;
      setChats((cs) => {
        if (!cs) return cs;
        const rest = cs.filter((x) => x.id !== c.id);
        return [c, ...rest].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      });
    }
    if (type === 'composer.deleted') {
      const { id } = data as { id: string };
      setChats((cs) => cs?.filter((x) => x.id !== id) ?? cs);
      if (id === chatId) setParam({ chat: null });
    }
  });

  return (
    <div className="page compose-page">
      <div className="toolbar">
        <h1>Compose tasks</h1>
        <select value={slug} onChange={(e) => setParam({ project: e.target.value, chat: null })} aria-label="Project">
          {active.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="grow" />
        <button type="button" className="btn-primary" onClick={() => setParam({ chat: null })} disabled={!chatId}>
          + New chat
        </button>
      </div>
      {error && <ErrorBox error={error} onRetry={loadChats} />}
      {projects.length > 0 && active.length === 0 && <Empty>Create a project first.</Empty>}
      {slug && (
        <div className="cmp-layout">
          <aside className="cmp-chats" aria-label="Chats">
            {!chats && <Spinner />}
            {chats?.length === 0 && <p className="hint">No chats yet.</p>}
            {chats?.map((c) => (
              <button key={c.id} type="button" className={cx('cmp-chat-item', c.id === chatId && 'on')} onClick={() => setParam({ chat: c.id })}>
                <span className="cmp-chat-title">{c.title || 'Untitled chat'}</span>
                <span className="hint">
                  {c.status === 'thinking' ? 'thinking…' : timeAgo(c.updated_at)}
                </span>
              </button>
            ))}
          </aside>
          {chatId ? (
            <ChatView key={chatId} chatId={chatId} slug={slug} groupProjects={groupProjects} onDeleted={() => setParam({ chat: null })} />
          ) : (
            <NewChat key={slug} slug={slug} onCreated={(id) => setParam({ chat: id })} />
          )}
        </div>
      )}
    </div>
  );
}

function NewChat({ slug, onCreated }: { slug: string; onCreated: (id: string) => void }) {
  const { toastError } = useLive();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  async function start() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const d = await api.createComposerChat(slug, text.trim());
      onCreated(d.chat.id);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  }
  return (
    <section className="cmp-main cmp-new">
      <Empty emoji="💬">
        <p>
          Describe what you want done. Claude reads the project and its board, asks what is unclear and proposes tasks. Nothing goes on the board until you
          create it.
        </p>
      </Empty>
      <MessageBox value={text} onChange={setText} onSend={start} busy={busy} placeholder="e.g. Customers should be able to reset their password by email" autoFocus />
    </section>
  );
}

function ChatView({ chatId, slug, groupProjects, onDeleted }: { chatId: string; slug: string; groupProjects: Project[]; onDeleted: () => void }) {
  const { toastError } = useLive();
  const [detail, setDetail] = useState<ComposerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api.composerChat(chatId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [chatId]);
  useEffect(() => {
    void load();
  }, [load]);
  useReconnect(load);

  useSse((type, data) => {
    if (type === 'composer.chat' && (data as ComposerChat).id === chatId) setDetail((d) => d && { ...d, chat: data as ComposerChat });
    if (type === 'composer.message' && (data as ComposerMessage).chat_id === chatId) {
      const m = data as ComposerMessage;
      setDetail((d) => d && (d.messages.some((x) => x.id === m.id) ? d : { ...d, messages: [...d.messages, m] }));
    }
    if (type === 'composer.draft' && (data as ComposerDraft).chat_id === chatId) {
      const dr = data as ComposerDraft;
      setDetail((d) => d && { ...d, drafts: d.drafts.some((x) => x.id === dr.id) ? d.drafts.map((x) => (x.id === dr.id ? dr : x)) : [...d.drafts, dr] });
    }
  });

  const count = detail?.messages.length ?? 0;
  const thinking = detail?.chat.status === 'thinking';
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [count, thinking]);

  async function send() {
    if (!text.trim()) return;
    setSending(true);
    try {
      await api.sendComposer(chatId, text.trim());
      setText('');
    } catch (e) {
      toastError(e);
    } finally {
      setSending(false);
    }
  }

  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!detail) return <Spinner />;
  const { chat, messages, drafts } = detail;
  return (
    <>
      <section className="cmp-main">
        <header className="cmp-head">
          <h2>{chat.title || 'Untitled chat'}</h2>
          <span className="grow" />
          {chat.cost_usd > 0 && <span className="hint">${chat.cost_usd.toFixed(2)}</span>}
          <ConfirmButton
            className="btn-ghost"
            confirmLabel="Delete chat"
            disabled={thinking}
            onConfirm={() => api.deleteComposerChat(chatId).then(onDeleted, toastError)}
          >
            🗑️
          </ConfirmButton>
        </header>
        <div className="cmp-messages">
          {messages.map((m) => (
            <div key={m.id} className={cx('cmp-msg', `cmp-${m.role}`)}>
              {m.role === 'assistant' && (
                <span className="cmp-avatar" aria-hidden="true">
                  <Clawd size={18} />
                </span>
              )}
              <Markdown source={m.body} />
            </div>
          ))}
          {thinking && (
            <div className="cmp-msg cmp-assistant cmp-thinking">
              <span className="cmp-avatar" aria-hidden="true">
                <Clawd working size={18} />
              </span>
              <span className="hint">Reading the project and thinking…</span>
              <button type="button" className="btn-ghost" onClick={() => api.stopComposer(chatId).catch(toastError)}>
                Stop
              </button>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <MessageBox value={text} onChange={setText} onSend={send} busy={sending || thinking} placeholder={thinking ? 'Claude is answering…' : 'Reply, refine a draft, or ask for more tasks'} />
      </section>
      <DraftsPanel chatId={chatId} slug={slug} groupProjects={groupProjects} drafts={drafts} onChange={(dr) => setDetail((d) => d && { ...d, drafts: dr })} />
    </>
  );
}

function MessageBox({
  value,
  onChange,
  onSend,
  busy,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <form
      className="cmp-input"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <textarea
        rows={3}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!busy) onSend();
          }
        }}
      />
      <div className="row end">
        <span className="hint">Enter to send, Shift+Enter for a new line</span>
        <button type="submit" className="btn-primary" disabled={busy || !value.trim()}>
          Send
        </button>
      </div>
    </form>
  );
}

function DraftsPanel({
  chatId,
  slug,
  groupProjects,
  drafts,
  onChange,
}: {
  chatId: string;
  slug: string;
  groupProjects: Project[];
  drafts: ComposerDraft[];
  onChange: (d: ComposerDraft[]) => void;
}) {
  const { toast, toastError } = useLive();
  const [showClosed, setShowClosed] = useState(false);
  const open = drafts.filter((d) => d.status === 'draft');
  const closed = drafts.filter((d) => d.status !== 'draft');
  const byId = useMemo(() => new Map(drafts.map((d) => [d.id, d])), [drafts]);

  async function createAll() {
    try {
      const r = await api.createAllDrafts(chatId);
      onChange(r.drafts);
      toast(`Created ${r.tasks.length} task${r.tasks.length === 1 ? '' : 's'} in the inbox`);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <aside className="cmp-drafts" aria-label="Draft tasks">
      <header className="cmp-head">
        <h2>
          Drafts <span className="count">{open.length}</span>
        </h2>
      </header>
      {open.length === 0 && <p className="hint">Tasks Claude proposes show up here. Edit them, then create the ones you want: they go to the inbox.</p>}
      {open.map((d) => (
        <DraftCard key={d.id} draft={d} byId={byId} slug={slug} groupProjects={groupProjects} />
      ))}
      {open.length > 1 && (
        <button type="button" className="btn-primary" onClick={createAll}>
          Create all {open.length}
        </button>
      )}
      {closed.length > 0 && (
        <button type="button" className="btn-ghost" onClick={() => setShowClosed((s) => !s)}>
          {showClosed ? 'Hide' : 'Show'} created &amp; discarded ({closed.length})
        </button>
      )}
      {showClosed && closed.map((d) => <DraftCard key={d.id} draft={d} byId={byId} slug={slug} groupProjects={groupProjects} />)}
    </aside>
  );
}

function DraftCard({
  draft,
  byId,
  slug,
  groupProjects,
}: {
  draft: ComposerDraft;
  byId: Map<string, ComposerDraft>;
  slug: string;
  groupProjects: Project[];
}) {
  const { toastError } = useLive();
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [priority, setPriority] = useState<Priority>(draft.priority);
  const [milestone, setMilestone] = useState(draft.milestone ?? '');
  const target = draft.project_slug ?? slug;
  const [project, setProject] = useState(target);
  // While editing, milestones follow the project picked in the form.
  const { milestones } = useMilestones(editing ? project : target);
  const open = draft.status === 'draft';
  const ms = milestones.find((m) => m.id === draft.milestone || m.title === draft.milestone);
  const projectName = (s: string) => groupProjects.find((p) => p.slug === s)?.name ?? s;

  function startEdit() {
    setTitle(draft.title);
    setBody(draft.body);
    setPriority(draft.priority);
    setMilestone(ms?.id ?? draft.milestone ?? '');
    setProject(target);
    setEditing(true);
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (e) {
      toastError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <form
        className="card cmp-draft form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api.updateDraft(draft.id, { project, title: title.trim(), body, priority, milestone: milestone || null }))) setEditing(false);
        }}
      >
        <input required value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Details" />
        {groupProjects.length > 1 && (
          <select
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setMilestone('');
            }}
            aria-label="Project"
          >
            {groupProjects.map((p) => (
              <option key={p.slug} value={p.slug}>
                🧩 {p.name}
              </option>
            ))}
          </select>
        )}
        <div className="grid2">
          <select value={priority} onChange={(e) => setPriority(Number(e.target.value) as Priority)} aria-label="Priority">
            <option value={3}>High</option>
            <option value={2}>Normal</option>
            <option value={1}>Low</option>
          </select>
          <select value={milestone} onChange={(e) => setMilestone(e.target.value)} aria-label="Milestone">
            <option value="">No milestone</option>
            {milestones
              .filter((m) => m.status === 'open' || m.id === milestone)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  🎯 {m.title}
                </option>
              ))}
          </select>
        </div>
        <div className="row end">
          <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !title.trim()}>
            Save
          </button>
        </div>
      </form>
    );
  }

  return (
    <article className={cx('card cmp-draft', !open && 'cmp-closed')}>
      <div className="cmp-draft-head">
        <strong>{draft.title}</strong>
        <PriorityBadge priority={draft.priority} />
      </div>
      <div className="cmp-draft-meta">
        {target !== slug && <span className="badge proj-chip">🧩 {projectName(target)}</span>}
        {(ms || draft.milestone) && <span className="badge">🎯 {ms?.title ?? draft.milestone}</span>}
        {draft.depends_on.map((d) => (
          <span key={d} className="badge" title={d}>
            ⛓️ after {byId.get(d)?.title ?? d}
          </span>
        ))}
        {draft.status === 'created' && draft.task_id && (
          <Link className="badge ok" to={`/board?project=${encodeURIComponent(target)}&task=${draft.task_id}`}>
            ✅ {draft.task_id}
          </Link>
        )}
        {draft.status === 'discarded' && <span className="badge">discarded</span>}
      </div>
      {draft.body && (
        <div className={cx('cmp-draft-body', !expanded && 'clamped')}>
          <Markdown source={draft.body} />
        </div>
      )}
      <div className="row">
        {draft.body && (
          <button type="button" className="btn-ghost" onClick={() => setExpanded((x) => !x)}>
            {expanded ? 'Less' : 'More'}
          </button>
        )}
        <span className="grow" />
        {open && (
          <>
            <button type="button" className="btn-ghost" onClick={() => run(() => api.discardDraft(draft.id))} disabled={busy}>
              Discard
            </button>
            <button type="button" className="btn-ghost" onClick={startEdit} disabled={busy}>
              Edit
            </button>
            <button type="button" className="btn-primary" onClick={() => run(() => api.createFromDraft(draft.id))} disabled={busy} title="Create it in the inbox">
              Create
            </button>
          </>
        )}
      </div>
    </article>
  );
}
