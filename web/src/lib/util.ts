export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 86400 * 30) return `${Math.round(diff / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function fullDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '';
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

/** One-line human summary of a raw stream-json line from `claude -p --output-format stream-json`. */
export interface LogSummary {
  kind: 'init' | 'text' | 'tool' | 'result' | 'tool_result' | 'error' | 'other';
  text: string;
}

const short = (s: string, n = 160) => (s.length > n ? s.slice(0, n) + '…' : s);

export function summarizeLogLine(line: string): LogSummary {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return { kind: 'other', text: short(line) };
  }
  const type = o.type as string;
  if (type === 'system') {
    return { kind: 'init', text: `session ${String(o.subtype ?? '')}${o.model ? ` · ${String(o.model)}` : ''}` };
  }
  if (type === 'brain_stderr') {
    // Written by the backend runner: the CLI's stderr output.
    const text = String(o.text ?? '').trim();
    const firstError = text.split('\n').find((l) => /error/i.test(l)) ?? text.split('\n')[0] ?? '';
    return { kind: 'error', text: `stderr: ${short(firstError.trim(), 300)}` };
  }
  if (type === 'result') {
    const cost = typeof o.total_cost_usd === 'number' ? ` · $${o.total_cost_usd.toFixed(2)}` : '';
    const res = typeof o.result === 'string' && o.result ? ` — ${short(o.result, 120)}` : '';
    const label = o.subtype && o.subtype !== 'success' ? o.subtype : (o.stop_reason ?? o.subtype ?? '?');
    const failed = o.is_error === true || /^error/.test(String(label));
    return { kind: failed ? 'error' : 'result', text: `result: ${String(label)}${cost}${res}` };
  }
  const msg = o.message as { content?: unknown } | undefined;
  const content = Array.isArray(msg?.content) ? (msg!.content as Record<string, unknown>[]) : [];
  const parts: LogSummary[] = content.map((c) => {
    if (c.type === 'text') return { kind: 'text', text: short(String(c.text ?? ''), 400) };
    if (c.type === 'tool_use') {
      const input = c.input as Record<string, unknown> | undefined;
      const arg = input ? (input.command ?? input.file_path ?? input.pattern ?? input.query ?? JSON.stringify(input)) : '';
      return { kind: 'tool', text: `${String(c.name)}(${short(String(arg), 120)})` };
    }
    if (c.type === 'tool_result') {
      const r = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
      return { kind: 'tool_result', text: short(r.replace(/\s+/g, ' '), 140) };
    }
    return { kind: 'other', text: String(c.type) };
  });
  if (parts.length === 0) return { kind: 'other', text: type ?? short(line) };
  return { kind: parts[0].kind, text: parts.map((p) => p.text).join(' · ') };
}
