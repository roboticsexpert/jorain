import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { hasFts5 } from '../db/client.ts';
import type { Ctx } from './context.ts';
import { publish, recordEvent } from './events.ts';
import { badRequest, notFound, type Note } from './types.ts';

/**
 * Knowledge lives in Markdown files under BRAIN_DIR (`knowledge/**` global, `groups/<slug>/knowledge/**`
 * per project group, `projects/<slug>/knowledge/**` per project). The DB only mirrors them for search: `knowledge_docs` always, `knowledge_fts` when the
 * SQLite build has FTS5. The mirror is re-synced from file mtimes before every search, so edits made
 * in any editor are picked up without a watcher.
 */

export type Scope = Note['scope'];

const PROJECT_NOTE = /^projects\/([a-z0-9-]+)\/knowledge\/(.+\.md)$/;
const GROUP_NOTE = /^groups\/([a-z0-9-]+)\/knowledge\/(.+\.md)$/;
const GLOBAL_NOTE = /^knowledge\/(.+\.md)$/;

/** Validates a note path (relative to BRAIN_DIR, forward slashes) and returns its scope. */
export function scopeOfPath(p: string): Scope {
  if (typeof p !== 'string' || !p) throw badRequest('path is required');
  const norm = path.posix.normalize(p);
  if (norm !== p || p.startsWith('/') || p.split('/').includes('..')) throw badRequest(`invalid note path ${p}`);
  const m = PROJECT_NOTE.exec(p);
  if (m) return `project:${m[1]}`;
  const g = GROUP_NOTE.exec(p);
  if (g) return `group:${g[1]}`;
  if (GLOBAL_NOTE.test(p)) return 'global';
  throw badRequest('path must be under knowledge/, groups/<slug>/knowledge/ or projects/<slug>/knowledge/ and end in .md');
}

export function scopeDir(scope: Scope): string {
  if (scope === 'global') return 'knowledge';
  const group = scope.startsWith('group:');
  const slug = scope.slice(group ? 'group:'.length : 'project:'.length);
  if (!/^[a-z0-9-]+$/.test(slug)) throw badRequest(`invalid scope ${scope}`);
  return group ? `groups/${slug}/knowledge` : `projects/${slug}/knowledge`;
}

export function parseScope(s: string | undefined | null): Scope | undefined {
  if (!s) return undefined;
  if (s === 'global' || /^(project|group):[a-z0-9-]+$/.test(s)) return s as Scope;
  throw badRequest('scope must be global, group:<slug> or project:<slug>');
}

export function splitFrontmatter(src: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { frontmatter: {}, body: src };
  let fm: unknown;
  try {
    fm = YAML.parse(m[1]);
  } catch {
    fm = {};
  }
  return { frontmatter: fm && typeof fm === 'object' && !Array.isArray(fm) ? (fm as Record<string, unknown>) : {}, body: src.slice(m[0].length) };
}

const fmDate = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : v != null ? String(v) : null);

/**
 * Sets the `updated` frontmatter field to today's date (YYYY-MM-DD), editing only that line so the rest
 * of the frontmatter keeps its formatting. A value the writer changed on purpose (it differs from the
 * note on disk, or the note is new) is kept. Adds a frontmatter block when there is none.
 */
export function stampUpdated(ctx: Ctx, rel: string, content: string, today = new Date().toISOString().slice(0, 10)): string {
  scopeOfPath(rel);
  if (typeof content !== 'string') return content; // putNote rejects it
  const incoming = fmDate(splitFrontmatter(content).frontmatter.updated);
  if (incoming != null) {
    const abs = path.join(ctx.cfg.brainDir, rel);
    const before = existsSync(abs) ? fmDate(splitFrontmatter(readFileSync(abs, 'utf8')).frontmatter.updated) : null;
    if (!existsSync(abs) || incoming !== before) return content;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return `---\nupdated: ${today}\n---\n\n${content}`;
  const yaml = /^updated:.*$/m.test(m[1]) ? m[1].replace(/^updated:.*$/m, `updated: ${today}`) : `${m[1]}\nupdated: ${today}`;
  return content.replace(m[1], () => yaml);
}

function describe(rel: string, src: string): Omit<Note, 'path' | 'scope'> & { body: string } {
  const { frontmatter: fm, body } = splitFrontmatter(src);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim() : heading ?? path.posix.basename(rel, '.md');
  const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === 'string' ? fm.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const updated = fmDate(fm.updated);
  return { title, tags, updated, body };
}

function walk(absDir: string, relDir: string, out: string[]): void {
  if (!existsSync(absDir)) return;
  for (const e of readdirSync(absDir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) walk(path.join(absDir, e.name), rel, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(rel);
  }
}

/** All note paths on disk, relative to BRAIN_DIR. */
export function notePaths(ctx: Ctx): string[] {
  const out: string[] = [];
  walk(path.join(ctx.cfg.brainDir, 'knowledge'), 'knowledge', out);
  for (const kind of ['groups', 'projects']) {
    const root = path.join(ctx.cfg.brainDir, kind);
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && /^[a-z0-9-]+$/.test(e.name)) walk(path.join(root, e.name, 'knowledge'), `${kind}/${e.name}/knowledge`, out);
    }
  }
  return out.sort();
}

let ftsReady = new WeakSet<object>();

function ensureFts(ctx: Ctx): boolean {
  if (!hasFts5()) return false;
  if (!ftsReady.has(ctx.db)) {
    ctx.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(path UNINDEXED, scope UNINDEXED, title, tags, body, tokenize = 'porter unicode61')`,
    );
    ftsReady.add(ctx.db);
  }
  return true;
}

/** Brings knowledge_docs / knowledge_fts in line with the files on disk. Returns the number of changed docs. */
export function syncIndex(ctx: Ctx): number {
  const fts = ensureFts(ctx);
  const indexed = new Map(
    (ctx.db.prepare('SELECT path, mtime FROM knowledge_docs').all() as { path: string; mtime: number }[]).map((r) => [r.path, r.mtime]),
  );
  // If the FTS table was created after docs were indexed (or is out of step), rebuild it from scratch.
  if (fts) {
    const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM knowledge_fts').get() as { n: number }).n;
    if (n !== indexed.size) {
      indexed.clear();
      ctx.db.exec('DELETE FROM knowledge_docs; DELETE FROM knowledge_fts;');
    }
  }
  let changed = 0;
  const seen = new Set<string>();
  const upsertDoc = ctx.db.prepare(
    `INSERT INTO knowledge_docs (path, scope, title, tags, body, mtime, updated) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET scope = excluded.scope, title = excluded.title, tags = excluded.tags, body = excluded.body, mtime = excluded.mtime, updated = excluded.updated`,
  );
  const delFts = fts ? ctx.db.prepare('DELETE FROM knowledge_fts WHERE path = ?') : null;
  const insFts = fts ? ctx.db.prepare('INSERT INTO knowledge_fts (path, scope, title, tags, body) VALUES (?, ?, ?, ?, ?)') : null;
  ctx.db.exec('BEGIN');
  try {
    for (const rel of notePaths(ctx)) {
      seen.add(rel);
      const abs = path.join(ctx.cfg.brainDir, rel);
      const mtime = statSync(abs).mtimeMs;
      if (indexed.get(rel) === mtime) continue;
      const d = describe(rel, readFileSync(abs, 'utf8'));
      const scope = scopeOfPath(rel);
      upsertDoc.run(rel, scope, d.title, JSON.stringify(d.tags), d.body, mtime, d.updated);
      delFts?.run(rel);
      insFts?.run(rel, scope, d.title, d.tags.join(' '), d.body);
      changed++;
    }
    for (const rel of indexed.keys()) {
      if (seen.has(rel)) continue;
      ctx.db.prepare('DELETE FROM knowledge_docs WHERE path = ?').run(rel);
      delFts?.run(rel);
      changed++;
    }
    ctx.db.exec('COMMIT');
  } catch (err) {
    ctx.db.exec('ROLLBACK');
    throw err;
  }
  return changed;
}

export function listNotes(ctx: Ctx, scope?: Scope): Note[] {
  syncIndex(ctx);
  const rows = (scope
    ? ctx.db.prepare('SELECT path, scope, title, tags, updated FROM knowledge_docs WHERE scope = ? ORDER BY path').all(scope)
    : ctx.db.prepare('SELECT path, scope, title, tags, updated FROM knowledge_docs ORDER BY path').all()) as any[];
  return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags) }));
}

export function readNote(ctx: Ctx, rel: string): { path: string; scope: Scope; frontmatter: Record<string, unknown>; content: string } {
  const scope = scopeOfPath(rel);
  const abs = path.join(ctx.cfg.brainDir, rel);
  if (!existsSync(abs)) throw notFound(`note ${rel}`);
  const content = readFileSync(abs, 'utf8');
  return { path: rel, scope, frontmatter: splitFrontmatter(content).frontmatter, content };
}

export function noteInfo(ctx: Ctx, rel: string): Note {
  const d = describe(rel, readFileSync(path.join(ctx.cfg.brainDir, rel), 'utf8'));
  return { path: rel, scope: scopeOfPath(rel), title: d.title, tags: d.tags, updated: d.updated };
}

function changedNote(ctx: Ctx, rel: string, source: string): void {
  syncIndex(ctx);
  recordEvent(ctx, null, 'knowledge.changed', { path: rel, source });
  publish('knowledge.changed', { path: rel });
}

/** Creates or replaces a note with exactly `content`. */
export function putNote(ctx: Ctx, rel: string, content: string, source = 'owner'): Note {
  scopeOfPath(rel);
  if (typeof content !== 'string') throw badRequest('content must be a string');
  const abs = path.join(ctx.cfg.brainDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  changedNote(ctx, rel, source);
  return noteInfo(ctx, rel);
}

export function deleteNote(ctx: Ctx, rel: string, source = 'owner'): void {
  scopeOfPath(rel);
  const abs = path.join(ctx.cfg.brainDir, rel);
  if (!existsSync(abs)) throw notFound(`note ${rel}`);
  rmSync(abs);
  changedNote(ctx, rel, source);
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'note'
  );
}

/** Writes a note from a title + Markdown body (adds frontmatter). Same title in the same scope = same file. */
export function saveNote(ctx: Ctx, scope: Scope, title: string, content: string, opts: { tags?: string[]; source?: string } = {}): Note {
  if (!title?.trim()) throw badRequest('title is required');
  const rel = `${scopeDir(scope)}/${slugify(title)}.md`;
  const fm = YAML.stringify({ title: title.trim(), tags: opts.tags ?? [], updated: new Date().toISOString().slice(0, 10) }).trimEnd();
  const body = splitFrontmatter(content).body.trim();
  return putNote(ctx, rel, `---\n${fm}\n---\n\n${body}\n`, opts.source);
}

export interface SearchHit {
  path: string;
  title: string;
  scope: Scope;
  snippet: string;
}

const tokens = (q: string) => q.match(/[\p{L}\p{N}_]+/gu) ?? [];

/** Full-text search over notes. `scopes` limits the result (e.g. global + one project); omit for all. */
export function searchKnowledge(ctx: Ctx, q: string, scopes?: Scope[], limit = 10): SearchHit[] {
  const words = tokens(q ?? '');
  if (!words.length) return [];
  syncIndex(ctx);
  const scopeSql = scopes?.length ? ` AND scope IN (${scopes.map(() => '?').join(',')})` : '';
  const scopeVals = scopes ?? [];
  if (ensureFts(ctx)) {
    const run = (match: string) =>
      ctx.db
        .prepare(
          `SELECT path, title, scope, snippet(knowledge_fts, 4, '**', '**', '…', 16) AS snippet
           FROM knowledge_fts WHERE knowledge_fts MATCH ?${scopeSql}
           ORDER BY bm25(knowledge_fts, 0, 0, 5.0, 2.0, 1.0) LIMIT ?`,
        )
        .all(match, ...scopeVals, limit) as unknown as SearchHit[];
    const quoted = words.map((w) => `"${w.replace(/"/g, '')}"*`);
    const all = run(quoted.join(' '));
    return all.length ? all : run(quoted.join(' OR '));
  }
  // Fallback without FTS5: every word must appear (case-insensitive) in title, tags or body.
  const rows = ctx.db.prepare(`SELECT path, title, scope, tags, body FROM knowledge_docs WHERE 1 = 1${scopeSql}`).all(...scopeVals) as any[];
  const lw = words.map((w) => w.toLowerCase());
  return rows
    .map((r) => {
      const hay = `${r.title}\n${r.tags}\n${r.body}`.toLowerCase();
      const score = lw.filter((w) => hay.includes(w)).length;
      const at = Math.max(0, r.body.toLowerCase().indexOf(lw[0]));
      return { hit: { path: r.path, title: r.title, scope: r.scope, snippet: r.body.slice(Math.max(0, at - 60), at + 100).replace(/\s+/g, ' ').trim() }, score };
    })
    .filter((x) => x.score === lw.length || (x.score > 0 && lw.length > 1))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.hit);
}

/** Test hook: forget which DB handles already have the FTS table. */
export function _resetFtsCache(): void {
  ftsReady = new WeakSet();
}
