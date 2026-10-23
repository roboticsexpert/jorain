import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config as defaultConfig, type Config } from '../config.ts';
import { openDb, type DB } from '../db/client.ts';

/** Everything the core modules need: the state DB and the brain/ directory. */
export interface Ctx {
  db: DB;
  cfg: Config;
}

export function createCtx(cfg: Config = defaultConfig): Ctx {
  for (const d of ['knowledge', 'projects', 'mcp', 'runs']) mkdirSync(path.join(cfg.brainDir, d), { recursive: true });
  return { db: openDb(cfg.dbPath), cfg };
}
