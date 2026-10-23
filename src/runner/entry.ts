import { fileURLToPath } from 'node:url';

/**
 * Command line for one of our own entry points (hook, MCP server) that `claude` spawns.
 * From src/ we run the .ts file directly (Node strips types); from dist/ the compiled .js.
 */
export function selfEntry(relFromSrc: string): { command: string; args: string[] } {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const file = fileURLToPath(new URL(`../${relFromSrc}${ext}`, import.meta.url));
  return { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', file] };
}

/** POSIX-shell quoting for hook commands (settings hooks are run through a shell). */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
