import { badRequest } from './types.ts';

/**
 * Five-field cron expressions (`minute hour day-of-month month day-of-week`), evaluated in the server's
 * local time zone. Each field takes `*`, numbers, ranges `a-b`, steps `*\/n` / `a-b/n` and lists `a,b`;
 * day-of-week is 0–7 (0 and 7 are Sunday). As in classic cron, when both day fields are restricted a day
 * matches if either does. Also `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`.
 */

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const;

function parseField(src: string, f: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  const int = (s: string) => {
    if (!/^\d+$/.test(s)) throw badRequest(`cron ${f.name}: "${s}" is not a number`);
    const n = Number(s);
    if (n < f.min || n > f.max) throw badRequest(`cron ${f.name}: ${n} is outside ${f.min}-${f.max}`);
    return n;
  };
  for (const part of src.split(',')) {
    const [range, stepSrc] = part.split('/');
    const step = stepSrc === undefined ? 1 : int(stepSrc);
    if (step < 1) throw badRequest(`cron ${f.name}: step must be at least 1`);
    let lo: number;
    let hi: number;
    if (range === '*') [lo, hi] = [f.min, f.max];
    else if (range.includes('-')) {
      const [a, b] = range.split('-');
      [lo, hi] = [int(a), int(b)];
      if (lo > hi) throw badRequest(`cron ${f.name}: range ${range} runs backwards`);
    } else {
      lo = int(range);
      hi = stepSrc === undefined ? lo : f.max;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  if (typeof expr !== 'string' || !expr.trim()) throw badRequest('cron expression is required');
  const src = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = src.split(/\s+/);
  if (parts.length !== 5) throw badRequest(`cron must have 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.delete(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function dayMatches(c: Cron, d: Date): boolean {
  if (!c.month.has(d.getMonth() + 1)) return false;
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

/** First time strictly after `after` that the expression matches (whole minutes, local time). */
export function nextCronTime(expr: string | Cron, after: Date): Date {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  // Five years covers every valid expression (Feb 29 included); anything left is impossible (e.g. 31 Feb).
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  throw badRequest(`cron "${typeof expr === 'string' ? expr : ''}" never matches`);
}

/** The next `n` times after `after`. */
export function nextCronTimes(expr: string, after: Date, n: number): Date[] {
  const c = parseCron(expr);
  const out: Date[] = [];
  let at = after;
  for (let i = 0; i < n; i++) out.push((at = nextCronTime(c, at)));
  return out;
}
