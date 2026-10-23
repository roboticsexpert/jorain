import { readdirSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

const dir = new URL('./migrations/', import.meta.url);

/** Applies src/db/migrations/*.sql in name order, tracking them in schema_migrations. */
export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    const sql = readFileSync(new URL(name, dir), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      // Another process may have applied it while we waited for the lock.
      if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name)) {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
