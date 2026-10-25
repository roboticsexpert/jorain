import { useState } from 'react';
import { api } from '../api/client';
import type { Priority, Project, Task } from '../api/types';
import { useLive } from '../live';
import { useMilestones } from './milestones';
import { Modal } from './ui';

export function NewTaskModal({
  projects,
  defaultProject,
  defaultMilestone,
  onClose,
  onCreated,
}: {
  projects: Project[];
  defaultProject?: string;
  defaultMilestone?: string;
  onClose: () => void;
  onCreated: (t: Task) => void;
}) {
  const { toastError } = useLive();
  const active = projects.filter((p) => p.status === 'active');
  const [slug, setSlug] = useState(defaultProject && active.some((p) => p.slug === defaultProject) ? defaultProject : (active[0]?.slug ?? ''));
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>(2);
  const [status, setStatus] = useState<'inbox' | 'todo'>('inbox');
  const [milestone, setMilestone] = useState(defaultMilestone ?? '');
  const { milestones } = useMilestones(slug);
  const openMilestones = milestones.filter((m) => m.status === 'open' || m.id === milestone);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const t = await api.createTask({
        project_slug: slug,
        title: title.trim(),
        body,
        priority,
        status,
        milestone: milestones.some((m) => m.id === milestone) ? milestone : undefined,
      });
      onCreated(t);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New task" onClose={onClose}>
      {active.length === 0 ? (
        <p>Create a project first.</p>
      ) : (
        <form className="form" onSubmit={submit}>
          <label>
            Project
            <select
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setMilestone('');
              }}
            >
              {active.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Title
            <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should happen?" />
          </label>
          <label>
            Details <span className="hint">markdown</span>
            <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="grid2">
            <label>
              Priority
              <select value={priority} onChange={(e) => setPriority(Number(e.target.value) as Priority)}>
                <option value={3}>High</option>
                <option value={2}>Normal</option>
                <option value={1}>Low</option>
              </select>
            </label>
            <label>
              Column
              <select value={status} onChange={(e) => setStatus(e.target.value as 'inbox' | 'todo')}>
                <option value="inbox">Inbox: waits for you</option>
                <option value="todo">Todo: Claude starts it</option>
              </select>
            </label>
          </div>
          {openMilestones.length > 0 && (
            <label>
              Milestone
              <select value={milestone} onChange={(e) => setMilestone(e.target.value)}>
                <option value="">No milestone</option>
                {openMilestones.map((m) => (
                  <option key={m.id} value={m.id}>
                    🎯 {m.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="row end">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={busy || !title.trim()}>
              Create task
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
