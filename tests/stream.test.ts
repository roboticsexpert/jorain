import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { StreamParser } from '../src/runner/stream.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const parse = (src: string) => {
  const p = new StreamParser();
  for (const l of src.split('\n')) p.push(l);
  return p;
};

describe('stream-json parser', () => {
  it('classifies a real auth failure (recorded from CLI 2.1.296) as an error', () => {
    const p = parse(fixture('auth-error.jsonl'));
    const o = p.outcome();
    expect(o.sessionId).toBe('45903871-726b-46d5-b868-c737754d2df8');
    expect(o.ok).toBe(false);
    expect(o.stopReason).toBe('error_api_error');
    expect(o.resultText).toMatch(/Failed to authenticate/);
    expect(o.costUsd).toBe(0);
  });

  it('extracts deferred_tool_use from a tool_deferred result', () => {
    const p = new StreamParser();
    p.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }));
    p.push(JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__brain__ask_human', input: { questions: [{ question: 'Colour?' }] } }] } }));
    p.push(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', stop_reason: 'tool_deferred', deferred_tool_use: { id: 'toolu_1', name: 'mcp__brain__ask_human', input: { questions: [{ question: 'Colour?' }] } }, usage: { input_tokens: 1 }, total_cost_usd: 0.01 }));
    const o = p.outcome();
    expect(o).toMatchObject({ stopReason: 'tool_deferred', ok: true, deferred: { id: 'toolu_1', name: 'mcp__brain__ask_human' }, costUsd: 0.01, usage: { input_tokens: 1 } });
  });

  it('falls back to the last tool_use when tool_deferred carries no object', () => {
    const p = new StreamParser();
    p.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'AskUserQuestion', input: { questions: [] } }] } }));
    p.push(JSON.stringify({ type: 'result', subtype: 'success', stop_reason: 'tool_deferred' }));
    expect(p.outcome().deferred).toEqual({ id: 'toolu_9', name: 'AskUserQuestion', input: { questions: [] } });
  });

  it('handles end_turn, max turns, missing result and junk lines', () => {
    const ok = new StreamParser();
    ok.push('not json');
    ok.push('');
    ok.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Summary here' }] } }));
    ok.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '' }));
    expect(ok.outcome()).toMatchObject({ ok: true, stopReason: 'end_turn', resultText: 'Summary here' });
    expect(ok.parseErrors).toBe(1);

    const max = new StreamParser();
    max.push(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 60 }));
    expect(max.outcome()).toMatchObject({ ok: false, stopReason: 'error_max_turns', numTurns: 60 });

    expect(new StreamParser().outcome()).toMatchObject({ ok: false, stopReason: 'no_result' });
  });

  // Recorded by scripts/spike-defer.mjs against the real CLI, when present.
  const recorded = readdirSync(new URL('./fixtures/', import.meta.url)).filter((f) => /^ask-human-run1\.jsonl$/.test(f));
  it.runIf(recorded.length > 0)('parses the recorded defer → resume round trip', () => {
    const o1 = parse(fixture('ask-human-run1.jsonl')).outcome();
    expect(o1.stopReason).toBe('tool_deferred');
    expect(o1.deferred?.name).toBe('mcp__brain__ask_human');
    const run2 = readdirSync(new URL('./fixtures/', import.meta.url)).find((f) => f.startsWith('ask-human-run2'))!;
    const o2 = parse(fixture(run2)).outcome();
    expect(o2.ok).toBe(true);
    expect(o2.resultText?.toLowerCase()).toContain('blue');
  });
});
