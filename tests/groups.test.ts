import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createGroup, deleteGroup, getGroup, listGroups, readGroupDoc, siblingRepos, siblings, updateGroup, writeGroupDoc } from '../src/core/groups.ts';
import { listNotes, saveNote, scopeOfPath, searchKnowledge } from '../src/core/knowledge.ts';
import { portfolio } from '../src/core/portfolio.ts';
import { createProject, getProject, updateProject } from '../src/core/projects.ts';
import { createTask, getTask, listTasks } from '../src/core/tasks.ts';
import { decide } from '../src/hooks/pretooluse.ts';
import { buildServer } from '../src/mcp/server.ts';
import { buildArgs } from '../src/runner/claude.ts';
import { initialPrompt, planPrompt, systemPrompt } from '../src/runner/prompt.ts';
import { tempCtx, tempRepo } from './helpers.ts';

function setup() {
  const ctx = tempCtx();
  const api = tempRepo();
  const web = tempRepo();
  const other = tempRepo();
  createProject(ctx, { slug: 'api', name: 'Shop API', repo_path: api });
  createProject(ctx, { slug: 'web', name: 'Shop Web', repo_path: web });
  createProject(ctx, { slug: 'blog', name: 'Blog', repo_path: other });
  createGroup(ctx, { slug: 'shop', name: 'Shop', projects: ['api', 'web'] });
  return { ctx, api, web, other };
}

async function agentTools(ctx: ReturnType<typeof tempCtx>, env: { taskId?: string; project?: string }) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(ctx, env).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content[0].text as string, error: Boolean(r.isError) };
  };
}

describe('groups', { timeout: 30_000 }, () => {
  it('creates a group with members, GROUP.md and a knowledge folder; membership can change and the group can go', () => {
    const { ctx, api } = setup();
    expect(getGroup(ctx, 'shop').projects).toEqual(['api', 'web']);
    expect(getProject(ctx, 'api').group_slug).toBe('shop');
    expect(readGroupDoc(ctx, 'shop')).toContain('# Shop');
    expect(existsSync(path.join(ctx.cfg.brainDir, 'groups', 'shop', 'knowledge'))).toBe(true);
    expect(siblings(ctx, 'web').map((p) => p.slug)).toEqual(['api']);
    expect(siblingRepos(ctx, 'web')).toEqual([api]);
    expect(siblings(ctx, 'blog')).toEqual([]);

    updateGroup(ctx, 'shop', { projects: ['web', 'blog'] });
    expect(getProject(ctx, 'api').group_slug).toBeNull();
    expect(getGroup(ctx, 'shop').projects).toEqual(['blog', 'web']);
    updateProject(ctx, 'api', { group_slug: 'shop' });
    expect(getGroup(ctx, 'shop').projects).toHaveLength(3);
    expect(() => updateProject(ctx, 'api', { group_slug: 'nope' })).toThrow(/unknown group/);
    expect(() => createGroup(ctx, { slug: 'shop', name: 'Again' })).toThrow(/already exists/);
    expect(() => createGroup(ctx, { slug: 'x', name: 'X', projects: ['missing'] })).toThrow(/not found/);

    writeGroupDoc(ctx, 'shop', '# Shop\n\nREST on :4000');
    expect(readGroupDoc(ctx, 'shop')).toBe('# Shop\n\nREST on :4000\n');

    deleteGroup(ctx, 'shop');
    expect(listGroups(ctx)).toEqual([]);
    expect(getProject(ctx, 'web').group_slug).toBeNull();
  });

  it('lists the tasks of every project in a group, and the portfolio carries the groups', () => {
    const { ctx } = setup();
    createTask(ctx, { project_slug: 'api', title: 'endpoint' });
    createTask(ctx, { project_slug: 'web', title: 'page' });
    createTask(ctx, { project_slug: 'blog', title: 'post' });
    expect(listTasks(ctx, { group: 'shop' }).map((t) => t.title).sort()).toEqual(['endpoint', 'page']);
    expect(portfolio(ctx).groups.map((g) => g.slug)).toEqual(['shop']);
  });

  it('has a group knowledge scope', () => {
    const { ctx } = setup();
    expect(scopeOfPath('groups/shop/knowledge/api-contract.md')).toBe('group:shop');
    const n = saveNote(ctx, 'group:shop', 'API contract', 'Orders are POSTed to /orders');
    expect(n.path).toBe('groups/shop/knowledge/api-contract.md');
    expect(listNotes(ctx, 'group:shop').map((x) => x.title)).toEqual(['API contract']);
    expect(searchKnowledge(ctx, 'orders', ['group:shop'])).toHaveLength(1);
  });
});

describe('agents in a group', { timeout: 30_000 }, () => {
  it('see GROUP.md and the sibling repos in their prompts, and get them as --add-dir', () => {
    const { ctx, api } = setup();
    writeGroupDoc(ctx, 'shop', '# Shop\n\nThe web app calls the API at /v1.');
    const t = createTask(ctx, { project_slug: 'web', title: 'checkout page' });
    const sys = systemPrompt(ctx, getTask(ctx, t.id), getProject(ctx, 'web'));
    expect(sys).toContain('product "Shop"');
    expect(sys).toContain(api);
    expect(initialPrompt(ctx, getTask(ctx, t.id), getProject(ctx, 'web'))).toContain('The web app calls the API at /v1.');
    const plan = createTask(ctx, { project_slug: 'web', title: 'plan', kind: 'plan' });
    expect(planPrompt(ctx, getTask(ctx, plan.id), getProject(ctx, 'web'))).toContain('## Other parts of the product');
    // A project without a group gets none of it.
    const b = createTask(ctx, { project_slug: 'blog', title: 'post' });
    expect(systemPrompt(ctx, getTask(ctx, b.id), getProject(ctx, 'blog'))).not.toContain('product "');

    const args = buildArgs({ sessionId: 's', resume: false, mcpConfig: 'm', settings: 's', settingSources: 'project', tools: ['Read'], allowedTools: [], disallowedTools: [], appendSystemPrompt: '', maxTurns: 5, addDirs: [api] });
    expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2)).toEqual(['--add-dir', api]);
  });

  it('the hook denies file edits inside a sibling repo and allows them elsewhere', () => {
    const dirs = () => ['/repos/api'];
    const edit = (file_path: string, cwd = '/wt/web/t1') => decide({ tool_name: 'Edit', tool_input: { file_path }, cwd }, () => null, undefined, dirs)?.permissionDecision ?? null;
    expect(edit('/repos/api/src/routes.ts')).toBe('deny');
    expect(edit('../../../repos/api/x.ts')).toBe('deny');
    expect(decide({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/repos/api/n.ipynb' } }, () => null, undefined, dirs)?.permissionDecision).toBe('deny');
    expect(edit('/wt/web/t1/src/page.tsx')).toBeNull();
    expect(edit('/repos/api-docs/readme.md')).toBeNull();
    // The session's own directory is never read-only, even if a sibling path contains it.
    expect(edit('/repos/api/x.ts', '/repos/api/sub')).toBeNull();
  });

  it('create tasks and read boards in sibling projects only; a sibling task gets no default dependency', async () => {
    const { ctx } = setup();
    const cur = createTask(ctx, { project_slug: 'web', title: 'checkout page' });
    const call = await agentTools(ctx, { taskId: cur.id, project: 'web' });

    const r = await call('create_task', { project: 'api', title: 'POST /orders', body: 'Accepts a cart, returns an order id.' });
    expect(r.error).toBe(false);
    const created = listTasks(ctx, { project: 'api' })[0];
    expect(created).toMatchObject({ title: 'POST /orders', status: 'inbox', depends_on: [] });

    const own = await call('create_task', { title: 'follow-up', depends_on: [created.id] });
    expect(own.error).toBe(false);
    expect(listTasks(ctx, { project: 'web' }).find((t) => t.title === 'follow-up')?.depends_on).toEqual([created.id]);

    expect((await call('create_task', { project: 'blog', title: 'nope' })).error).toBe(true);
    expect((await call('project_board', { project: 'api' })).text).toContain('POST /orders');
    expect((await call('project_board', { project: 'blog' })).error).toBe(true);

    expect((await call('save_knowledge', { scope: 'group', title: 'Orders API', content: 'POST /orders' })).text).toContain('groups/shop/knowledge/orders-api.md');
    expect(readFileSync(path.join(ctx.cfg.brainDir, 'groups/shop/knowledge/orders-api.md'), 'utf8')).toContain('POST /orders');
    expect((await call('search_knowledge', { query: 'orders' })).text).toContain('Orders API');
  });
});
