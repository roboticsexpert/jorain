/**
 * Parser for `claude -p --output-format stream-json --verbose` output (one JSON object per line).
 * Fed line by line; `outcome()` classifies how the run ended.
 */

export interface DeferredToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface StreamOutcome {
  /** end_turn | tool_deferred | error_max_turns | error_<terminal_reason> | no_result ... */
  stopReason: string;
  ok: boolean;
  deferred: DeferredToolUse | null;
  resultText: string | null;
  usage: Record<string, unknown> | null;
  costUsd: number | null;
  numTurns: number | null;
  sessionId: string | null;
}

export class StreamParser {
  sessionId: string | null = null;
  result: Record<string, any> | null = null;
  lastAssistantText: string | null = null;
  /** Most recent tool_use blocks by id, used when a deferred result does not carry the input. */
  toolUses = new Map<string, DeferredToolUse>();
  lastToolUse: DeferredToolUse | null = null;
  parseErrors = 0;

  /** Returns the parsed object, or null for blank / non-JSON lines. */
  push(line: string): Record<string, any> | null {
    const s = line.trim();
    if (!s) return null;
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(s);
    } catch {
      this.parseErrors++;
      return null;
    }
    if (typeof msg.session_id === 'string') this.sessionId = msg.session_id;
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      const text = msg.message.content
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n')
        .trim();
      if (text) this.lastAssistantText = text;
      for (const b of msg.message.content) {
        if (b?.type === 'tool_use' && typeof b.id === 'string') {
          const tu = { id: b.id, name: String(b.name), input: b.input };
          this.toolUses.set(b.id, tu);
          this.lastToolUse = tu;
        }
      }
    }
    if (msg.type === 'result') this.result = msg;
    return msg;
  }

  outcome(): StreamOutcome {
    const r = this.result;
    const base = {
      usage: (r?.usage as Record<string, unknown>) ?? null,
      costUsd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null,
      numTurns: typeof r?.num_turns === 'number' ? r.num_turns : null,
      sessionId: this.sessionId,
    };
    if (!r) return { ...base, stopReason: 'no_result', ok: false, deferred: null, resultText: this.lastAssistantText };

    const resultText = typeof r.result === 'string' && r.result.trim() ? r.result.trim() : this.lastAssistantText;
    const d = r.deferred_tool_use;
    if (d || r.stop_reason === 'tool_deferred') {
      let deferred: DeferredToolUse | null = null;
      if (d && typeof d === 'object') {
        const id = String(d.id ?? d.tool_use_id ?? '');
        deferred = { id, name: String(d.name ?? d.tool_name ?? this.toolUses.get(id)?.name ?? ''), input: d.input ?? d.tool_input ?? this.toolUses.get(id)?.input };
      } else if (this.lastToolUse) {
        deferred = this.lastToolUse;
      }
      return { ...base, stopReason: 'tool_deferred', ok: true, deferred, resultText };
    }
    if (typeof r.subtype === 'string' && r.subtype.startsWith('error')) return { ...base, stopReason: r.subtype, ok: false, deferred: null, resultText };
    if (r.is_error) return { ...base, stopReason: `error_${r.terminal_reason ?? 'unknown'}`, ok: false, deferred: null, resultText };
    return { ...base, stopReason: String(r.stop_reason ?? 'end_turn'), ok: true, deferred: null, resultText };
  }
}
