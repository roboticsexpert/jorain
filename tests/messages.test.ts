import { describe, expect, it } from 'vitest';
import { addOwnerMessage, inboxMessages, listMessages, markRead, pendingForAgent, postAgentMessage, resolveAction, takePending, waitReady } from '../src/core/messages.ts';
import { createProject } from '../src/core/projects.ts';
import { createTask, getTask, transition } from '../src/core/tasks.ts';
import { decide } from '../src/hooks/pretooluse.ts';
import { tempCtx } from './helpers.ts';

function setup() {
  const ctx = tempCtx();
  createProject(ctx, { slug: 'ads', name: 'Ads' });
  const t = createTask(ctx, { project_slug: 'ads', title: 'Advertise on Telegram' });
  return { ctx, t };
}

describe('task thread', () => {
  it('agent updates and actions count on the task and show in the inbox until read / resolved', () => {
    const { ctx, t } = setup();
    const u = postAgentMessage(ctx, t.id, { kind: 'update', title: 'Ad drafts', body: '1. …' });
    const a = postAgentMessage(ctx, t.id, { kind: 'action', title: 'Pay the admin' });
    expect(u).toMatchObject({ author: 'agent', kind: 'update', status: null, task_title: 'Advertise on Telegram', project_slug: 'ads' });
    expect(a.status).toBe('open');
    expect(getTask(ctx, t.id)).toMatchObject({ open_actions: 1, unread_updates: 1 });
    expect(inboxMessages(ctx).map((m) => m.id).sort()).toEqual([u.id, a.id].sort());
    // The agent's own posts are never pending for the agent.
    expect(pendingForAgent(ctx, t.id)).toEqual([]);

    expect(markRead(ctx, t.id)).toBe(2);
    expect(getTask(ctx, t.id).unread_updates).toBe(0);
    expect(inboxMessages(ctx).map((m) => m.id)).toEqual([a.id]); // open actions stay until resolved

    const r = resolveAction(ctx, a.id, 'done', ' tx 0xabc ');
    expect(r).toMatchObject({ status: 'done', note: 'tx 0xabc', delivered_at: null });
    expect(getTask(ctx, t.id).open_actions).toBe(0);
    expect(inboxMessages(ctx)).toEqual([]);
    expect(() => resolveAction(ctx, a.id, 'declined')).toThrow(/already done/);
    expect(() => resolveAction(ctx, u.id, 'done')).toThrow(/not an action/);
  });

  it('owner input is pending until taken, then delivered once', () => {
    const { ctx, t } = setup();
    const a = postAgentMessage(ctx, t.id, { kind: 'action', title: 'Pay the admin' });
    addOwnerMessage(ctx, t.id, 'Use draft 2, shorter');
    resolveAction(ctx, a.id, 'declined', 'too expensive');
    expect(pendingForAgent(ctx, t.id)).toHaveLength(2);
    const text = takePending(ctx, t.id)!;
    expect(text).toContain('new input from the owner');
    expect(text).toContain('The owner wrote: Use draft 2, shorter');
    expect(text).toContain(`"Pay the admin" (${a.id}) was marked declined by the owner: too expensive`);
    expect(takePending(ctx, t.id)).toBeNull();
    expect(listMessages(ctx, t.id).every((m) => m.delivered_at)).toBe(true);
  });

  it('rejects empty messages and messages to done tasks', () => {
    const { ctx, t } = setup();
    expect(() => addOwnerMessage(ctx, t.id, '  ')).toThrow(/body is required/);
    expect(() => postAgentMessage(ctx, t.id, { kind: 'update', title: '' })).toThrow(/title is required/);
    transition(ctx, t.id, 'in_progress');
    transition(ctx, t.id, 'review');
    transition(ctx, t.id, 'done');
    expect(() => addOwnerMessage(ctx, t.id, 'hi')).toThrow(/is done/);
  });

  it('wait_for_owner is ready once its action is resolved or the owner writes', () => {
    const { ctx, t } = setup();
    const a = postAgentMessage(ctx, t.id, { kind: 'action', title: 'Pay the admin' });
    expect(waitReady(ctx, t.id, a.id)).toBe(false);
    expect(waitReady(ctx, t.id, null)).toBe(false);
    expect(waitReady(ctx, t.id, 'm_unknown')).toBe(true); // nothing to wait for
    addOwnerMessage(ctx, t.id, 'Hold on, I am asking my accountant');
    expect(waitReady(ctx, t.id, a.id)).toBe(true);
    takePending(ctx, t.id);
    expect(waitReady(ctx, t.id, a.id)).toBe(false);
    resolveAction(ctx, a.id, 'done');
    expect(waitReady(ctx, t.id, a.id)).toBe(true);
  });

  it('the PreToolUse hook defers wait_for_owner until ready', () => {
    const input = { tool_name: 'mcp__brain__wait_for_owner', tool_use_id: 'toolu_w', tool_input: { action_id: 'm_1' } };
    const seen: (string | null)[] = [];
    expect(decide(input, () => null, (id) => (seen.push(id), false))?.permissionDecision).toBe('defer');
    expect(decide(input, () => null, () => true)?.permissionDecision).toBe('allow');
    expect(seen).toEqual(['m_1']);
    expect(decide({ ...input, tool_input: {} }, () => null)?.permissionDecision).toBe('defer');
  });
});
