#!/usr/bin/env node
// Stand-in for `claude -p` in tests. Speaks the same stream-json shapes and, like the real CLI, runs the
// PreToolUse hook from --settings before a tool call. Scenario is picked from the prompt text:
//   ASK       ask_human → hook defers → tool_deferred; on --resume the hook allows with answers, then commit
//   MAXTURNS  ends with subtype error_max_turns (exit 1)
//   PUSH      tries `git push`; the hook must deny it; then finishes normally
//   DIRTY     writes notes.txt and ends without committing (the runner must commit the leftovers)
//   WAIT      wait_for_owner → hook defers → tool_deferred; on --resume the hook allows, the PostToolUse hook
//             hands over the owner's input, which is written to owner.txt and committed
//   SLOW      like default, but takes a second first (owner messages can arrive after the last tool call)
//   default   appends a line to README.md and commits (and "calls" search_knowledge when the prompt mentions the knowledge base)
// Keywords are also matched in natural prompts ("Ask me …", "one at a time", "git push"),
// so scripts/verify-e2e.mjs can dry-run against this fake.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const resume = flag('--resume');
const sid = resume ?? flag('--session-id');
const pIdx = argv.indexOf('-p');
const prompt = argv[pIdx + 1] && !argv[pIdx + 1].startsWith('--') ? argv[pIdx + 1] : undefined;
const stateFile = path.join(os.tmpdir(), `fake-claude-${sid}.json`);
const pick = (p = '') =>
  /ASK|\b[Aa]sk me\b/.test(p) ? 'ask' : /MAXTURNS|one at a time/.test(p) ? 'maxturns' : /PUSH|git push/.test(p) ? 'push' : /DIRTY/.test(p) ? 'dirty' : /\bWAIT\b/.test(p) ? 'wait' : /\bSLOW\b/.test(p) ? 'slow' : 'commit';
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { scenario: pick(prompt) };
writeFileSync(stateFile, JSON.stringify(state));

const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\n');
const settings = JSON.parse(readFileSync(flag('--settings'), 'utf8'));
const usage = { input_tokens: 10, output_tokens: 5 };

function hook(toolName, toolUseId, input) {
  for (const m of settings.hooks?.PreToolUse ?? []) {
    if (!new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
    for (const h of m.hooks) {
      const r = spawnSync('/bin/sh', ['-c', h.command], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sid, tool_name: toolName, tool_use_id: toolUseId, tool_input: input }), encoding: 'utf8', env: process.env });
      if (r.stdout.trim()) return JSON.parse(r.stdout).hookSpecificOutput;
    }
  }
  return null;
}
/** Runs the PostToolUse hooks like the CLI does and returns the additionalContext they hand back. */
function postHook(toolName, toolUseId, input) {
  const texts = [];
  for (const m of settings.hooks?.PostToolUse ?? []) {
    if (!new RegExp(`^(${m.matcher})$`).test(toolName)) continue;
    for (const h of m.hooks) {
      const r = spawnSync('/bin/sh', ['-c', h.command], { input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: toolName, tool_use_id: toolUseId, tool_input: input, tool_response: 'ok' }), encoding: 'utf8', env: process.env });
      if (r.stdout.trim()) texts.push(JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '');
    }
  }
  return texts.join('\n');
}
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });
const result = (text, extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', num_turns: 2, total_cost_usd: 0.001, usage, result: text, ...extra });

out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['Read', 'Edit', 'mcp__brain__ask_human'], model: 'fake' });

if (state.scenario === 'ask') {
  const id = `toolu_${sid.slice(0, 8)}`;
  const input = { questions: [{ question: 'Which colour should I use?', header: 'Colour', options: [{ label: 'red' }, { label: 'blue' }] }] };
  if (!resume) out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__brain__ask_human', input }] } });
  const d = hook('mcp__brain__ask_human', id, input);
  if (d?.permissionDecision === 'defer') {
    out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'tool_deferred', num_turns: 1, total_cost_usd: 0.001, usage, result: '', deferred_tool_use: { id, name: 'mcp__brain__ask_human', input } });
    process.exit(0);
  }
  const colour = d?.updatedInput?.answers?.[0]?.answer ?? 'unknown';
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `The owner answered: ${colour}` }] } });
  writeFileSync('colour.txt', `${colour}\n`);
  git('add', 'colour.txt');
  git('commit', '-q', '-m', `feat: use ${colour}`);
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Wrote ${colour} to colour.txt and committed.` }] } });
  result(`Wrote ${colour} to colour.txt and committed.`);
} else if (state.scenario === 'wait') {
  const id = `toolu_w${sid.slice(0, 7)}`;
  const input = { reason: 'I need the payment receipt' };
  if (!resume) out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__brain__wait_for_owner', input }] } });
  const d = hook('mcp__brain__wait_for_owner', id, input);
  if (d?.permissionDecision === 'defer') {
    out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'tool_deferred', num_turns: 1, total_cost_usd: 0.001, usage, result: '', deferred_tool_use: { id, name: 'mcp__brain__wait_for_owner', input } });
    process.exit(0);
  }
  const got = postHook('mcp__brain__wait_for_owner', id, input);
  writeFileSync('owner.txt', `${got}\n`);
  git('add', 'owner.txt');
  git('commit', '-q', '-m', 'docs: owner input');
  result('Wrote the owner input to owner.txt.');
} else if (state.scenario === 'maxturns') {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Still working…' }] } });
  out({ type: 'result', subtype: 'error_max_turns', is_error: true, stop_reason: 'tool_use', num_turns: 3, total_cost_usd: 0.002, usage });
  process.exit(1);
} else if (state.scenario === 'push') {
  const d = hook('Bash', 'toolu_push', { command: 'git push origin HEAD' });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_push', is_error: true, content: `${d?.permissionDecision}: ${d?.permissionDecisionReason}` }] } });
  result(d?.permissionDecision === 'deny' ? 'Push was blocked, as expected.' : 'PUSH WAS NOT BLOCKED');
} else if (state.scenario === 'dirty') {
  writeFileSync('notes.txt', 'left uncommitted\n');
  result('Wrote notes.txt.');
} else {
  if (state.scenario === 'slow') await new Promise((r) => setTimeout(r, 1000));
  if (/knowledge base/i.test(prompt ?? '')) out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_kb', name: 'mcp__brain__search_knowledge', input: { query: 'commit style' } }] } });
  appendFileSync('README.md', prompt && resume ? 'changes requested\n' : 'hello from brain\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'docs: hello');
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added the line and committed.' }] } });
  result('Added the line and committed.');
}
