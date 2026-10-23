import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

/** Repository root (works from both src/ and dist/). */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Config {
  brainDir: string;
  dbPath: string;
  port: number;
  concurrency: number;
  tickMs: number;
  maxTurns: number;
  runTimeoutMs: number;
  maxQuestions: number;
  /** Times a failed verification is handed back to the agent before the task goes to review anyway. */
  maxVerifyFixes: number;
  verifyTimeoutMs: number;
  /** Where task worktrees live: <dir>/<project>/<task-id>. Outside every repo, so no stray CLAUDE.md is picked up. */
  worktreesDir: string;
  /** auto_plan waits this long after the last planner task before planning again. */
  planCooldownMs: number;
  claudeBin: string;
  settingSources: string;
  webDist: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const brainDir = path.resolve(env.BRAIN_DIR ?? path.join(APP_ROOT, 'brain'));
  return {
    brainDir,
    dbPath: path.join(brainDir, 'state.sqlite'),
    port: num(env.BRAIN_PORT, 3141),
    concurrency: num(env.BRAIN_CONCURRENCY, 2),
    tickMs: num(env.BRAIN_TICK_MS, 10_000),
    maxTurns: num(env.BRAIN_MAX_TURNS, 60),
    runTimeoutMs: num(env.BRAIN_RUN_TIMEOUT_MIN, 30) * 60_000,
    maxQuestions: num(env.BRAIN_MAX_QUESTIONS, 5),
    maxVerifyFixes: num(env.BRAIN_MAX_VERIFY_FIXES, 2),
    verifyTimeoutMs: num(env.BRAIN_VERIFY_TIMEOUT_MIN, 15) * 60_000,
    worktreesDir: path.resolve(env.BRAIN_WORKTREES_DIR ?? path.join(os.homedir(), '.secondbrain', 'worktrees')),
    planCooldownMs: num(env.BRAIN_PLAN_COOLDOWN_HOURS, 6) * 3_600_000,
    claudeBin: env.BRAIN_CLAUDE_BIN ?? 'claude',
    settingSources: env.BRAIN_SETTING_SOURCES ?? 'project,local',
    webDist: path.join(APP_ROOT, 'web', 'dist'),
  };
}

export const config = loadConfig();
