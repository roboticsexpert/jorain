import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createCtx, type Ctx } from '../src/core/context.ts';

export function tempCtx(env: Record<string, string> = {}): Ctx {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'brain-test-'));
  return createCtx(loadConfig({ BRAIN_DIR: dir, BRAIN_WORKTREES_DIR: path.join(dir, 'worktrees'), ...env }));
}

export function tempRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'brain-repo-'));
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

export const gitOut = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
