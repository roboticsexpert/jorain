import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { now } from '../db/client.ts';
import type { Ctx } from './context.ts';
import { publish, recordEvent } from './events.ts';
import { badRequest, BrainError, notFound, PUSH_POLICIES, type Project, type PushPolicy } from './types.ts';

const SLUG = /^[a-z0-9-]+$/;

const toProject = (r: any): Project => ({ ...r, allowed_tools: JSON.parse(r.allowed_tools), auto_plan: Boolean(r.auto_plan) });

export function projectDir(ctx: Ctx, slug: string): string {
  return path.join(ctx.cfg.brainDir, 'projects', slug);
}

export function listProjects(ctx: Ctx): Project[] {
  return (ctx.db.prepare('SELECT * FROM projects ORDER BY name').all() as any[]).map(toProject);
}

export function findProject(ctx: Ctx, slug: string): Project | undefined {
  const r = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
  return r ? toProject(r) : undefined;
}

export function getProject(ctx: Ctx, slug: string): Project {
  const p = findProject(ctx, slug);
  if (!p) throw notFound(`project ${slug}`);
  return p;
}

export interface ProjectInput {
  slug: string;
  name: string;
  repo_path?: string | null;
  model?: string | null;
  allowed_tools?: string[];
  push_policy?: PushPolicy;
  verify_command?: string | null;
  setup_command?: string | null;
  max_parallel?: number;
  auto_plan?: boolean;
  group_slug?: string | null;
}

function checkRepoPath(repo: string | null | undefined): string | null {
  if (repo == null || repo === '') return null;
  if (!path.isAbsolute(repo)) throw badRequest('repo_path must be an absolute path');
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw badRequest(`repo_path ${repo} is not a directory`);
  if (!existsSync(path.join(repo, '.git'))) throw badRequest(`repo_path ${repo} is not a git repository`);
  return repo;
}

function checkGroup(ctx: Ctx, group: string | null | undefined): string | null {
  if (group == null || group === '') return null;
  if (typeof group !== 'string' || !ctx.db.prepare('SELECT 1 FROM project_groups WHERE slug = ?').get(group)) throw badRequest(`unknown group ${group}`);
  return group;
}

function checkFields(input: Partial<ProjectInput & { status: string }>): void {
  if (input.allowed_tools !== undefined && (!Array.isArray(input.allowed_tools) || input.allowed_tools.some((t) => typeof t !== 'string')))
    throw badRequest('allowed_tools must be an array of strings');
  if (input.push_policy !== undefined && !PUSH_POLICIES.includes(input.push_policy)) throw badRequest('push_policy must be never or after_merge');
  for (const k of ['verify_command', 'setup_command'] as const)
    if (input[k] !== undefined && input[k] !== null && typeof input[k] !== 'string') throw badRequest(`${k} must be a string or null`);
  if (input.max_parallel !== undefined && (!Number.isInteger(input.max_parallel) || input.max_parallel < 1 || input.max_parallel > 10))
    throw badRequest('max_parallel must be an integer from 1 to 10');
  if (input.auto_plan !== undefined && typeof input.auto_plan !== 'boolean') throw badRequest('auto_plan must be true or false');
  if (input.status !== undefined && !['active', 'archived'].includes(input.status)) throw badRequest('status must be active or archived');
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw badRequest('name is required');
}

export function createProject(ctx: Ctx, input: ProjectInput): Project {
  if (!input.slug || !SLUG.test(input.slug)) throw badRequest('slug must match [a-z0-9-]+');
  checkFields(input);
  if (!input.name?.trim()) throw badRequest('name is required');
  if (findProject(ctx, input.slug)) throw new BrainError(409, 'conflict', `project ${input.slug} already exists`);
  const repo = checkRepoPath(input.repo_path);
  const group = checkGroup(ctx, input.group_slug);
  const ts = now();
  ctx.db
    .prepare(
      `INSERT INTO projects (slug, name, repo_path, model, allowed_tools, push_policy, verify_command, setup_command, max_parallel, auto_plan, group_slug, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      input.slug,
      input.name.trim(),
      repo,
      input.model ?? null,
      JSON.stringify(input.allowed_tools ?? []),
      input.push_policy ?? 'never',
      input.verify_command?.trim() || null,
      input.setup_command?.trim() || null,
      input.max_parallel ?? 1,
      input.auto_plan ? 1 : 0,
      group,
      ts,
      ts,
    );

  const dir = projectDir(ctx, input.slug);
  mkdirSync(path.join(dir, 'knowledge'), { recursive: true });
  const projectMd = path.join(dir, 'PROJECT.md');
  if (!existsSync(projectMd)) {
    writeFileSync(
      projectMd,
      `# ${input.name.trim()}\n\n${repo ? `Repository: \`${repo}\`\n\n` : ''}## Goal\n\n_(describe what this project is for)_\n\n## Constraints\n\n- \n`,
    );
  }
  recordEvent(ctx, null, 'project.created', { slug: input.slug });
  const p = getProject(ctx, input.slug);
  publish('project.updated', p);
  return p;
}

export function updateProject(ctx: Ctx, slug: string, patch: Partial<Omit<ProjectInput, 'slug'> & { status: 'active' | 'archived' }>): Project {
  getProject(ctx, slug);
  checkFields(patch);
  const sets: string[] = [];
  const vals: any[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.name !== undefined) set('name', patch.name.trim());
  if (patch.repo_path !== undefined) set('repo_path', checkRepoPath(patch.repo_path));
  if (patch.model !== undefined) set('model', patch.model || null);
  if (patch.allowed_tools !== undefined) set('allowed_tools', JSON.stringify(patch.allowed_tools));
  if (patch.push_policy !== undefined) set('push_policy', patch.push_policy);
  if (patch.verify_command !== undefined) set('verify_command', patch.verify_command?.trim() || null);
  if (patch.setup_command !== undefined) set('setup_command', patch.setup_command?.trim() || null);
  if (patch.max_parallel !== undefined) set('max_parallel', patch.max_parallel);
  if (patch.auto_plan !== undefined) set('auto_plan', patch.auto_plan ? 1 : 0);
  if (patch.group_slug !== undefined) set('group_slug', checkGroup(ctx, patch.group_slug));
  if (patch.status !== undefined) set('status', patch.status);
  if (sets.length) {
    set('updated_at', now());
    ctx.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE slug = ?`).run(...vals, slug);
  }
  const p = getProject(ctx, slug);
  publish('project.updated', p);
  return p;
}

/** Reads an optional file from the project's brain folder. */
export function readProjectFile(ctx: Ctx, slug: string, name: string): string | null {
  const f = path.join(projectDir(ctx, slug), name);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

/** PROJECT.md: goal, constraints and current state. Every agent run of the project gets it; the planner keeps it current. */
export function readProjectDoc(ctx: Ctx, slug: string): string {
  getProject(ctx, slug);
  return readProjectFile(ctx, slug, 'PROJECT.md') ?? '';
}

export function writeProjectDoc(ctx: Ctx, slug: string, content: string, source = 'owner'): string {
  const p = getProject(ctx, slug);
  if (typeof content !== 'string') throw badRequest('content must be a string');
  const dir = projectDir(ctx, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'PROJECT.md'), content.endsWith('\n') ? content : `${content}\n`);
  recordEvent(ctx, null, 'project.doc_updated', { slug, source });
  publish('project.updated', p);
  return readProjectDoc(ctx, slug);
}

function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new BrainError(500, 'bad_mcp_config', `${file}: ${(err as Error).message}`);
  }
}

/** MCP configs as stored: brain/mcp/global.json and brain/projects/<slug>/mcp.json. Project servers win on name clashes. */
export function projectMcp(ctx: Ctx, slug: string): { global: object; project: object; merged: { mcpServers: Record<string, unknown> } } {
  getProject(ctx, slug);
  const global = readJson(path.join(ctx.cfg.brainDir, 'mcp', 'global.json'));
  const project = readJson(path.join(projectDir(ctx, slug), 'mcp.json'));
  return { global, project, merged: { mcpServers: { ...(global.mcpServers ?? {}), ...(project.mcpServers ?? {}) } } };
}
