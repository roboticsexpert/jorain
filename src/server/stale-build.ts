import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * When the server runs from `dist/`, returns why that build is older than `src/` (a source file
 * changed after the last `pnpm build`), or null. An outdated build silently runs old behaviour:
 * on 2026-10-23 one approved tasks without merging them.
 */
export function staleBuild(entryUrl: string): string | null {
  const entry = fileURLToPath(entryUrl);
  const dist = path.resolve(path.dirname(entry), '..');
  if (path.basename(dist) !== 'dist') return null;
  const src = path.join(path.dirname(dist), 'src');
  let newest: { file: string; mtime: number } | null = null;
  try {
    for (const f of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
      if (!/\.(ts|sql)$/.test(f)) continue;
      const mtime = statSync(path.join(src, f)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file: f, mtime };
    }
  } catch {
    return null; // no src/ next to dist/: a deployed build
  }
  const built = statSync(entry).mtimeMs;
  return newest && newest.mtime > built ? `src/${newest.file} changed after the last build of ${path.relative(path.dirname(dist), entry)}` : null;
}
