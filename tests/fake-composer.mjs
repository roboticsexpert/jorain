#!/usr/bin/env node
// Stand-in for a composer turn of `claude -p`: echoes the prompt and the flags the test checks.
//   FAIL in the prompt → ends with error_max_turns.
const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const sid = flag('--resume') ?? flag('--session-id');
const prompt = argv[argv.indexOf('-p') + 1];
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\n');
out({ type: 'system', subtype: 'init' });
if (/FAIL/.test(prompt)) {
  out({ type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.002 });
  process.exit(1);
}
const reply = `echo: ${prompt} | resume=${!!flag('--resume')} | tools=${flag('--tools')}`;
out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
out({ type: 'result', subtype: 'success', stop_reason: 'end_turn', result: reply, total_cost_usd: 0.001, num_turns: 1 });
