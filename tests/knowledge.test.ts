import { readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteNote, listNotes, putNote, readNote, saveNote, scopeOfPath, searchKnowledge, slugify, splitFrontmatter, stampUpdated, syncIndex } from '../src/core/knowledge.ts';
import { hasFts5 } from '../src/db/client.ts';
import { tempCtx } from './helpers.ts';

describe('knowledge paths and frontmatter', () => {
  it('maps paths to scopes and rejects anything outside the knowledge folders', () => {
    expect(scopeOfPath('knowledge/git.md')).toBe('global');
    expect(scopeOfPath('knowledge/sub/dir/x.md')).toBe('global');
    expect(scopeOfPath('projects/foo/knowledge/api.md')).toBe('project:foo');
    for (const bad of ['../etc/passwd.md', 'knowledge/../state.md', '/knowledge/x.md', 'projects/foo/PROJECT.md', 'knowledge/x.txt', 'runs/x.md']) {
      expect(() => scopeOfPath(bad), bad).toThrow();
    }
  });

  it('parses frontmatter and slugifies titles', () => {
    const { frontmatter, body } = splitFrontmatter('---\ntitle: Hi\ntags: [a, b]\n---\n\nBody');
    expect(frontmatter).toEqual({ title: 'Hi', tags: ['a', 'b'] });
    expect(body.trim()).toBe('Body');
    expect(splitFrontmatter('no fm').frontmatter).toEqual({});
    expect(slugify('Preferred Commit Style!')).toBe('preferred-commit-style');
  });
});

describe('stampUpdated (PUT /api/knowledge/note)', () => {
  const day = '2026-10-19';
  it('sets updated to today, editing only that line, and adds frontmatter when missing', () => {
    const ctx = tempCtx();
    const rel = 'knowledge/a.md';
    putNote(ctx, rel, '---\ntitle: A # keep\nupdated: 2026-01-01\n---\n\nBody\n');
    expect(stampUpdated(ctx, rel, '---\ntitle: A # keep\nupdated: 2026-01-01\n---\n\nBody v2\n', day)).toBe('---\ntitle: A # keep\nupdated: 2026-10-19\n---\n\nBody v2\n');
    expect(stampUpdated(ctx, rel, '---\ntitle: A\n---\nBody', day)).toBe('---\ntitle: A\nupdated: 2026-10-19\n---\nBody');
    expect(stampUpdated(ctx, rel, '# Plain', day)).toBe('---\nupdated: 2026-10-19\n---\n\n# Plain');
  });

  it('keeps an updated value the writer changed on purpose', () => {
    const ctx = tempCtx();
    putNote(ctx, 'knowledge/a.md', '---\nupdated: 2026-01-01\n---\nx');
    const edited = '---\nupdated: 2025-12-31\n---\nx';
    expect(stampUpdated(ctx, 'knowledge/a.md', edited, day)).toBe(edited);
    const fresh = '---\nupdated: 2025-05-05\n---\nnew';
    expect(stampUpdated(ctx, 'knowledge/new.md', fresh, day)).toBe(fresh);
    expect(() => stampUpdated(ctx, '../x.md', fresh, day)).toThrow();
  });
});

describe('knowledge index and search', () => {
  it('reports FTS5 availability', () => {
    expect(typeof hasFts5()).toBe('boolean');
  });

  it('indexes saved notes and finds them, with scope filtering', () => {
    const ctx = tempCtx();
    const g = saveNote(ctx, 'global', 'Commit style', 'Preferred commit style: conventional commits.', { tags: ['git'] });
    expect(g).toMatchObject({ path: 'knowledge/commit-style.md', scope: 'global', title: 'Commit style', tags: ['git'] });
    saveNote(ctx, 'project:shop', 'Payments', 'We use Stripe for payments and commits are squashed.');
    expect(listNotes(ctx).map((n) => n.path)).toEqual(['knowledge/commit-style.md', 'projects/shop/knowledge/payments.md']);
    expect(listNotes(ctx, 'project:shop')).toHaveLength(1);

    const hits = searchKnowledge(ctx, 'conventional commit');
    expect(hits[0]).toMatchObject({ path: 'knowledge/commit-style.md', title: 'Commit style', scope: 'global' });
    expect(hits[0].snippet.toLowerCase()).toContain('conventional');
    expect(searchKnowledge(ctx, 'stripe', ['global'])).toEqual([]);
    expect(searchKnowledge(ctx, 'stripe', ['global', 'project:shop'])[0].path).toBe('projects/shop/knowledge/payments.md');
    // prefix matching and OR fallback when not every word matches
    expect(searchKnowledge(ctx, 'payme')[0]?.path).toBe('projects/shop/knowledge/payments.md');
    expect(searchKnowledge(ctx, 'stripe nonexistentword')[0]?.path).toBe('projects/shop/knowledge/payments.md');
    expect(searchKnowledge(ctx, '   ')).toEqual([]);
  });

  it('picks up edits, new files and deletions made outside the app', () => {
    const ctx = tempCtx();
    saveNote(ctx, 'global', 'Editor', 'I use vim.');
    const file = path.join(ctx.cfg.brainDir, 'knowledge/editor.md');
    writeFileSync(file, '---\ntitle: Editor\n---\nI use helix now.\n');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(searchKnowledge(ctx, 'helix')[0]?.path).toBe('knowledge/editor.md');
    expect(searchKnowledge(ctx, 'vim')).toEqual([]);

    mkdirSync(path.join(ctx.cfg.brainDir, 'projects/x/knowledge'), { recursive: true });
    writeFileSync(path.join(ctx.cfg.brainDir, 'projects/x/knowledge/deploy.md'), '# Deploy notes\n\nShip with fly.io\n');
    expect(searchKnowledge(ctx, 'fly')[0]).toMatchObject({ path: 'projects/x/knowledge/deploy.md', title: 'Deploy notes', scope: 'project:x' });

    rmSync(file);
    expect(syncIndex(ctx)).toBe(1);
    expect(searchKnowledge(ctx, 'helix')).toEqual([]);
  });

  it('put / read / delete round trip', () => {
    const ctx = tempCtx();
    const n = putNote(ctx, 'knowledge/a/b.md', '---\ntitle: Nested\ntags: x, y\nupdated: 2026-10-19\n---\nhello');
    expect(n).toEqual({ path: 'knowledge/a/b.md', scope: 'global', title: 'Nested', tags: ['x', 'y'], updated: '2026-10-19' });
    const r = readNote(ctx, 'knowledge/a/b.md');
    expect(r.frontmatter.title).toBe('Nested');
    expect(r.content).toBe(readFileSync(path.join(ctx.cfg.brainDir, 'knowledge/a/b.md'), 'utf8'));
    deleteNote(ctx, 'knowledge/a/b.md');
    expect(() => readNote(ctx, 'knowledge/a/b.md')).toThrow(/not found/);
    expect(() => putNote(ctx, 'projects/p/PROJECT.md', 'x')).toThrow();
  });
});
