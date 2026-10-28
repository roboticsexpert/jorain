import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { now } from '../db/client.ts';
import type { Ctx } from './context.ts';
import { publish, recordEvent } from './events.ts';
import { findProject, getProject, listProjects } from './projects.ts';
import { badRequest, BrainError, notFound, type Group, type Project } from './types.ts';

/**
 * Groups tie several projects into one product (backend + frontend). Each project keeps its own repo,
 * branches and delivery; the group adds a shared GROUP.md and knowledge scope, read-only access to the
 * sibling repos in agent runs, and tasks that agents may file on each other (docs/09-project-groups.md).
 */

const SLUG = /^[a-z0-9-]+$/;

type GroupRow = Omit<Group, 'projects'>;

function withProjects(ctx: Ctx, r: GroupRow): Group {
  const projects = (ctx.db.prepare('SELECT slug FROM projects WHERE group_slug = ? ORDER BY name').all(r.slug) as { slug: string }[]).map((x) => x.slug);
  return { ...r, projects };
}

export function groupDir(ctx: Ctx, slug: string): string {
  return path.join(ctx.cfg.brainDir, 'groups', slug);
}

export function listGroups(ctx: Ctx): Group[] {
  return (ctx.db.prepare('SELECT * FROM project_groups ORDER BY name').all() as unknown as GroupRow[]).map((r) => withProjects(ctx, r));
}

export function findGroup(ctx: Ctx, slug: string): Group | undefined {
  const r = ctx.db.prepare('SELECT * FROM project_groups WHERE slug = ?').get(slug) as unknown as GroupRow | undefined;
  return r ? withProjects(ctx, r) : undefined;
}

export function getGroup(ctx: Ctx, slug: string): Group {
  const g = findGroup(ctx, slug);
  if (!g) throw notFound(`group ${slug}`);
  return g;
}

export interface GroupInput {
  slug: string;
  name: string;
  /** Projects to put in the group (moved out of any other group). */
  projects?: string[];
}

function checkProjects(ctx: Ctx, projects: unknown): string[] {
  if (!Array.isArray(projects) || projects.some((p) => typeof p !== 'string')) throw badRequest('projects must be a list of project slugs');
  for (const p of projects) getProject(ctx, p);
  return [...new Set(projects as string[])];
}

/** Sets exactly this list of projects as the group's members. */
function setMembers(ctx: Ctx, slug: string, projects: string[]): void {
  const ts = now();
  ctx.db.prepare('UPDATE projects SET group_slug = NULL, updated_at = ? WHERE group_slug = ?').run(ts, slug);
  const put = ctx.db.prepare('UPDATE projects SET group_slug = ?, updated_at = ? WHERE slug = ?');
  for (const p of projects) put.run(slug, ts, p);
}

function publishMembers(ctx: Ctx, slugs: Iterable<string>): void {
  for (const s of new Set(slugs)) {
    const p = findProject(ctx, s);
    if (p) publish('project.updated', p);
  }
}

export function createGroup(ctx: Ctx, input: GroupInput): Group {
  if (!input.slug || !SLUG.test(input.slug)) throw badRequest('slug must match [a-z0-9-]+');
  if (typeof input.name !== 'string' || !input.name.trim()) throw badRequest('name is required');
  if (findGroup(ctx, input.slug)) throw new BrainError(409, 'conflict', `group ${input.slug} already exists`);
  const projects = input.projects !== undefined ? checkProjects(ctx, input.projects) : [];
  const ts = now();
  ctx.db.prepare('INSERT INTO project_groups (slug, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(input.slug, input.name.trim(), ts, ts);
  setMembers(ctx, input.slug, projects);

  const dir = groupDir(ctx, input.slug);
  mkdirSync(path.join(dir, 'knowledge'), { recursive: true });
  const doc = path.join(dir, 'GROUP.md');
  if (!existsSync(doc)) {
    writeFileSync(
      doc,
      `# ${input.name.trim()}\n\n## What the product is\n\n_(one paragraph)_\n\n## Parts\n\n_(one line per project: what it does, what it owns)_\n\n## How the parts talk\n\n_(API base URLs, contracts, shared types, env variables)_\n`,
    );
  }
  recordEvent(ctx, null, 'group.created', { slug: input.slug, projects });
  const g = getGroup(ctx, input.slug);
  publish('group.updated', g);
  publishMembers(ctx, projects);
  return g;
}

export function updateGroup(ctx: Ctx, slug: string, patch: { name?: string; projects?: string[] }): Group {
  const before = getGroup(ctx, slug);
  if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim())) throw badRequest('name is required');
  const projects = patch.projects !== undefined ? checkProjects(ctx, patch.projects) : undefined;
  if (patch.name !== undefined) ctx.db.prepare('UPDATE project_groups SET name = ?, updated_at = ? WHERE slug = ?').run(patch.name.trim(), now(), slug);
  if (projects) {
    setMembers(ctx, slug, projects);
    recordEvent(ctx, null, 'group.members', { slug, projects });
  }
  const g = getGroup(ctx, slug);
  publish('group.updated', g);
  if (projects) publishMembers(ctx, [...before.projects, ...projects]);
  return g;
}

/** Removes the group; its projects stay and become standalone. GROUP.md and group knowledge stay on disk. */
export function deleteGroup(ctx: Ctx, slug: string): void {
  const g = getGroup(ctx, slug);
  setMembers(ctx, slug, []);
  ctx.db.prepare('DELETE FROM project_groups WHERE slug = ?').run(slug);
  recordEvent(ctx, null, 'group.deleted', { slug });
  publish('group.deleted', { slug });
  publishMembers(ctx, g.projects);
}

export function readGroupDoc(ctx: Ctx, slug: string): string {
  getGroup(ctx, slug);
  const f = path.join(groupDir(ctx, slug), 'GROUP.md');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

export function writeGroupDoc(ctx: Ctx, slug: string, content: string, source = 'owner'): string {
  const g = getGroup(ctx, slug);
  if (typeof content !== 'string') throw badRequest('content must be a string');
  const dir = groupDir(ctx, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'GROUP.md'), content.endsWith('\n') ? content : `${content}\n`);
  recordEvent(ctx, null, 'group.doc_updated', { slug, source });
  publish('group.updated', g);
  return readGroupDoc(ctx, slug);
}

/** The other active projects in the same group as `project` (none when it has no group). */
export function siblings(ctx: Ctx, project: Project | string): Project[] {
  const p = typeof project === 'string' ? getProject(ctx, project) : project;
  if (!p.group_slug) return [];
  return listProjects(ctx).filter((x) => x.group_slug === p.group_slug && x.slug !== p.slug && x.status === 'active');
}

/** Repo paths of the siblings: agents of `project` may read them but not write to them. */
export function siblingRepos(ctx: Ctx, project: Project | string): string[] {
  return siblings(ctx, project)
    .map((s) => s.repo_path)
    .filter((r): r is string => !!r);
}
