import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createProject } from '../src/core/projects.ts';
import { createQuestion } from '../src/core/questions.ts';
import { createTask, getTask, listTasks } from '../src/core/tasks.ts';
import { buildOwnerServer, projectForCwd } from '../src/mcp/owner.ts';
import { tempCtx, tempRepo } from './helpers.ts';

// Nothing listens here, so session actions see a stopped server.
const DOWN_PORT = '3997';

async function connect(cwd: string) {
  const ctx = tempCtx({ BRAIN_PORT: DOWN_PORT });
  const repo = tempRepo();
  createProject(ctx, { slug: 'shop', name: 'Shop', repo_path: repo });
  createProject(ctx, { slug: 'notes', name: 'Notes' });
  const server = buildOwnerServer(ctx, { cwd: cwd === 'repo' ? path.join(repo, 'src') : cwd });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c: any) => c.text).join('\n') as string, isError: !!r.isError };
  };
  return { ctx, repo, call };
}

describe('owner MCP server', () => {
  it('maps the working directory to a project: repo subfolders and project folders', () => {
    const ctx = tempCtx();
    const repo = tempRepo();
    createProject(ctx, { slug: 'shop', name: 'Shop', repo_path: repo });
    createProject(ctx, { slug: 'notes', name: 'Notes' });
    const notesDir = path.join(ctx.cfg.brainDir, 'projects', 'notes', 'sub');
    mkdirSync(notesDir, { recursive: true });
    expect(projectForCwd(ctx, path.join(repo, 'a', 'b'))?.slug).toBe('shop');
    expect(projectForCwd(ctx, notesDir)?.slug).toBe('notes');
    expect(projectForCwd(ctx, `${repo}-other`)).toBeUndefined();
  });

  it('adds a task to the current project and lists it', async () => {
    const { ctx, call } = await connect('repo');
    const r = await call('add_task', { title: 'Add health check', todo: true, priority: 3 });
    expect(r.isError).toBe(false);
    const [t] = listTasks(ctx, { project: 'shop' });
    expect(t).toMatchObject({ title: 'Add health check', status: 'todo', priority: 3 });
    expect((await call('list_tasks', { project: 'current' })).text).toContain(t.id);
    expect((await call('overview')).text).toContain('current project: shop (Shop)');
  });

  it('asks for a project when the directory is not a registered one', async () => {
    const { call } = await connect('/nowhere/at/all');
    const r = await call('add_task', { title: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not inside a registered project');
    expect((await call('add_task', { title: 'x', project: 'notes' })).isError).toBe(false);
  });

  it('edits a task and refuses transitions the state machine forbids', async () => {
    const { ctx, call } = await connect('repo');
    const t = createTask(ctx, { project_slug: 'shop', title: 'Old' });
    expect((await call('update_task', { id: t.id, title: 'New', status: 'todo' })).isError).toBe(false);
    expect(getTask(ctx, t.id)).toMatchObject({ title: 'New', status: 'todo' });
    const r = await call('approve_task', { id: t.id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not review');
  });

  it('lists open questions, and answering needs the server', async () => {
    const { ctx, call } = await connect('repo');
    const t = createTask(ctx, { project_slug: 'shop', title: 'Pick a colour' });
    createQuestion(ctx, t.id, 'tu_1', { questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] });
    const list = await call('list_questions');
    expect(list.text).toContain('Which colour?');
    expect(list.text).toContain('2) Blue');
    const r = await call('answer_question', { id: t.id, answers: ['2'] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('server is not running');
    expect((await call('answer_question', { id: t.id, answers: ['1', '2'] })).text).toContain('give one answer for each');
  });

  it('saves notes to the current project and finds them', async () => {
    const { call } = await connect('repo');
    const saved = await call('save_note', { title: 'Payments', content: 'We use Stripe webhooks for refunds.' });
    expect(saved.text).toContain('projects/shop/knowledge/payments.md');
    const hits = await call('search_knowledge', { query: 'stripe refunds' });
    expect(hits.text).toContain('Payments');
    expect((await call('read_note', { path: 'projects/shop/knowledge/payments.md' })).text).toContain('Stripe webhooks');
  });
});
