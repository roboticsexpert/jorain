import { describe, expect, it, vi } from 'vitest';

// Simulate a Node build whose SQLite lacks FTS5: search must fall back to a substring scan.
vi.mock('../src/db/client.ts', async (orig) => ({ ...(await orig<typeof import('../src/db/client.ts')>()), hasFts5: () => false }));

const { saveNote, searchKnowledge } = await import('../src/core/knowledge.ts');
const { tempCtx } = await import('./helpers.ts');

describe('knowledge search without FTS5', () => {
  it('finds notes by substring and respects scope', () => {
    const ctx = tempCtx();
    saveNote(ctx, 'global', 'Commit style', 'Preferred commit style: conventional commits.');
    saveNote(ctx, 'project:a', 'Stack', 'Hono and SQLite.');
    expect(ctx.db.prepare("SELECT name FROM sqlite_master WHERE name = 'knowledge_fts'").get()).toBeUndefined();
    expect(searchKnowledge(ctx, 'Conventional')[0]?.path).toBe('knowledge/commit-style.md');
    expect(searchKnowledge(ctx, 'hono', ['global'])).toEqual([]);
    expect(searchKnowledge(ctx, 'hono sqlite', ['project:a'])[0]?.snippet).toContain('Hono');
  });
});
