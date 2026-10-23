/**
 * Small HTTP client for a running Second Brain server. Used by the CLI and the owner MCP server for
 * actions that start or resume sessions, so the server's scheduler and the UI see them.
 */
import type { Config } from '../config.ts';
import { BrainError } from '../core/types.ts';

export const serverBase = (cfg: Config) => `http://127.0.0.1:${cfg.port}`;

export async function serverUp(cfg: Config): Promise<boolean> {
  try {
    const r = await fetch(`${serverBase(cfg)}/api/status`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function api(cfg: Config, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${serverBase(cfg)}/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = r.status === 204 ? null : await r.json();
  if (!r.ok) throw new BrainError(r.status, data?.error?.code ?? 'error', data?.error?.message ?? r.statusText);
  return data;
}
