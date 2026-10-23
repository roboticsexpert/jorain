import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.ts';

export type DB = DatabaseSync;

const cache = new Map<string, DatabaseSync>();

/** Opens (and migrates) the state database. One connection per path per process. */
export function openDb(dbPath: string): DatabaseSync {
  const hit = cache.get(dbPath);
  if (hit) return hit;
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Server, CLI, MCP servers and hooks all share this file.
  db.exec('PRAGMA busy_timeout = 5000');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  if (dbPath !== ':memory:') cache.set(dbPath, db);
  return db;
}

export function closeDb(dbPath: string): void {
  cache.get(dbPath)?.close();
  cache.delete(dbPath);
}

let fts5: boolean | undefined;

/** Whether this Node build's SQLite has FTS5 (checked once). */
export function hasFts5(): boolean {
  if (fts5 === undefined) {
    const probe = new DatabaseSync(':memory:');
    try {
      probe.exec('CREATE VIRTUAL TABLE t USING fts5(a)');
      fts5 = true;
    } catch {
      fts5 = false;
    } finally {
      probe.close();
    }
  }
  return fts5;
}

export const now = () => new Date().toISOString();

export function newId(prefix: string, len = 6): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return `${prefix}_${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
}
