import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { addDraft, createAllDrafts, createChat, createFromDraft, discardDraft, getChat, listChatMessages, listDrafts, updateDraft } from '../src/core/composer.ts';
import { createMilestone } from '../src/core/milestones.ts';
import { createProject } from '../src/core/projects.ts';
import { createTask, getTask } from '../src/core/tasks.ts';
import { buildComposerServer } from '../src/mcp/composer.ts';
import { Composer } from '../src/runner/composer.ts';
import { tempCtx, tempRepo } from './helpers.ts';

const fake = fileURLToPath(new URL('./fake-composer.mjs', import.meta.url));

function setup() {
  const ctx = tempCtx({ BRAIN_CLAUDE_BIN: fake });
  createProject(ctx, { slug: 'shop', name: 'Shop', repo_path: tempRepo() });
  return ctx;
}

describe('task composer', { timeout: 20_000 }, () => {
  it('drafts become tasks with priority, milestone and draft dependencies resolved', () => {
    const ctx = setup();
    const m = createMilestone(ctx, 'shop', { title: 'Backoffice v1' });
    const existing = createTask(ctx, { project_slug: 'shop', title: 'Existing' });
    const chat = createChat(ctx, 'shop');
    const api = addDraft(ctx, chat.id, { title: 'Customer API', priority: 3, milestone: 'Backoffice v1', depends_on: [existing.id] });
    const ui = addDraft(ctx, chat.id, { title: 'Customer list page', body: '## Acceptance criteria\n- [ ] list', depends_on: [api.id] });
    const junk = addDraft(ctx, chat.id, { title: 'Unwanted' });
    discardDraft(ctx, junk.id);

    expect(() => createFromDraft(ctx, ui.id)).toThrow(/create that one first/);
    updateDraft(ctx, ui.id, { title: 'Customer list page (paged)' });

    const tasks = createAllDrafts(ctx, chat.id, 'inbox');
    expect(tasks.map((t) => t.title)).toEqual(['Customer API', 'Customer list page (paged)']);
    const [a, b] = tasks;
    expect(a).toMatchObject({ priority: 3, milestone_id: m.id, depends_on: [existing.id], status: 'inbox' });
    expect(b.depends_on).toEqual([a.id]);
    expect(getTask(ctx, b.id).body).toContain('Acceptance criteria');
    expect(listDrafts(ctx, chat.id).map((d) => d.status)).toEqual(['created', 'created', 'discarded']);
    expect(() => updateDraft(ctx, api.id, { title: 'x' })).toThrow(/only open drafts/);
  });

  it('a draft cannot depend on a draft of another chat', () => {
    const ctx = setup();
    const one = createChat(ctx, 'shop');
    const two = createChat(ctx, 'shop');
    const d = addDraft(ctx, one.id, { title: 'A' });
    expect(() => addDraft(ctx, two.id, { title: 'B', depends_on: [d.id] })).toThrow(/unknown draft/);
  });

  it('chat turns: read-only tools, resume on the second message, errors recorded', async () => {
    const ctx = setup();
    const comp = new Composer(ctx);
    const chat = createChat(ctx, 'shop');
    comp.send(chat.id, 'I want customer management');
    expect(getChat(ctx, chat.id).status).toBe('thinking');
    expect(() => comp.send(chat.id, 'again')).toThrow(/still answering/);
    await comp.wait(chat.id);
    comp.send(chat.id, 'Split it');
    await comp.wait(chat.id);
    comp.send(chat.id, 'FAIL please');
    await comp.wait(chat.id);

    const msgs = listChatMessages(ctx, chat.id);
    expect(msgs.map((m) => m.role)).toEqual(['owner', 'assistant', 'owner', 'assistant', 'owner', 'error']);
    expect(msgs[1].body).toBe('echo: I want customer management | resume=false | tools=Read,Glob,Grep,WebSearch,WebFetch');
    expect(msgs[3].body).toContain('resume=true');
    expect(msgs[5].body).toContain('ran out of turns');
    const after = getChat(ctx, chat.id);
    expect(after).toMatchObject({ status: 'idle', title: 'I want customer management' });
    expect(after.cost_usd).toBeCloseTo(0.004);
  });

  it('MCP tools: propose, revise, list; scoped to the chat', async () => {
    const ctx = setup();
    const chat = createChat(ctx, 'shop');
    const other = createChat(ctx, 'shop');
    const foreign = addDraft(ctx, other.id, { title: 'Not yours' });
    const server = buildComposerServer(ctx, { chatId: chat.id, project: 'shop' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r: any = await client.callTool({ name, arguments: args });
      return { text: r.content.map((c: any) => c.text).join('\n') as string, isError: !!r.isError };
    };

    const p = await call('propose_task', { title: 'Customer API', priority: 3 });
    const id = p.text.match(/d_\w+/)![0];
    expect((await call('revise_draft', { draft_id: id, body: 'Do it' })).isError).toBe(false);
    expect((await call('revise_draft', { draft_id: foreign.id, title: 'x' })).isError).toBe(true);
    expect((await call('propose_task', { title: 'Bad', milestone: 'nope' })).isError).toBe(true);
    expect((await call('propose_task', { title: 'Bad', depends_on: ['t_missing'] })).isError).toBe(true);
    expect(JSON.parse((await call('list_drafts')).text)).toMatchObject([{ id, title: 'Customer API', body: 'Do it', priority: 3, status: 'draft' }]);
    await call('set_chat_title', { title: 'Customers' });
    expect(getChat(ctx, chat.id).title).toBe('Customers');
  });
});
