import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Run } from '../api/types';
import { useReconnect, useSse } from '../live';
import { errorMessage, summarizeLogLine } from '../lib/util';

/** Log of one run: loads existing lines, then tails `run.log` events while the run is live. */
export function RunLog({ run }: { run: Run }) {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  // Lines are stored by index so overlapping fetches and SSE events can never duplicate a line.
  const linesRef = useRef<string[]>([]);

  const put = useCallback((from: number, more: string[]) => {
    const next = linesRef.current.slice();
    more.forEach((l, i) => (next[from + i] = l));
    linesRef.current = next;
    setLines(next);
  }, []);

  const contiguous = () => {
    const ls = linesRef.current;
    let n = 0;
    while (n < ls.length && ls[n] !== undefined) n++;
    return n;
  };

  const load = useCallback(async () => {
    const after = contiguous();
    try {
      const res = await api.runLog(run.id, after);
      put(after, res.lines);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [run.id, put]);

  useEffect(() => {
    linesRef.current = [];
    setLines([]);
    void load();
  }, [load]);

  useReconnect(load);
  useSse((type, data) => {
    if (type !== 'run.log') return;
    const ev = data as { run_id: string; index: number; line: string };
    if (ev.run_id !== run.id) return;
    const gap = ev.index > contiguous();
    put(ev.index, [ev.line]);
    if (gap) void load(); // missed lines: catch up from the server
  });

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  return (
    <div className="runlog">
      <div className="row small">
        <label>
          <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> raw JSON
        </label>
        <label>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
        </label>
        <span className="muted">
          {lines.filter(Boolean).length} lines{!run.ended_at && <span className="live-dot"> live</span>}
        </span>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="log" ref={box}>
        {lines.length === 0 && <div className="muted">No output yet.</div>}
        {lines.map((l, i) => {
          if (l === undefined) return null;
          if (raw) return <div key={i} className="logline raw">{l}</div>;
          const s = summarizeLogLine(l);
          return (
            <div key={i} className={`logline log-${s.kind}`}>
              <span className="log-kind">{KIND_GLYPH[s.kind]}</span>
              {s.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const KIND_GLYPH = { init: '◆', text: '›', tool: '→', tool_result: '←', result: '■', error: '!', other: '·' } as const;
