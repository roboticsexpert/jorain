import { execFile } from 'node:child_process';

let cached: Promise<string | null> | null = null;

/** `claude --version`, read once per process. */
export function claudeVersion(bin: string): Promise<string | null> {
  cached ??= new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 15_000 }, (err, stdout) => resolve(err ? null : stdout.trim().split(/\s+/)[0] || null));
  });
  return cached;
}
