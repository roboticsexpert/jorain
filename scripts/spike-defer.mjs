#!/usr/bin/env node
// Spike: does a PreToolUse `defer` pause `claude -p` on a tool call, and does `--resume` with
// `allow` + `updatedInput` deliver the owner's answer to the model?
//
// Run from the repo root in a normal terminal (it uses your Claude subscription login; two tiny haiku runs):
//   node scripts/spike-defer.mjs            # tests mcp__brain__ask_human (what the runner uses)
//   node scripts/spike-defer.mjs AskUserQuestion
// Saves the raw stream-json of both runs to tests/fixtures/ and prints a verdict.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentEnv } from '../src/runner/env.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = process.argv[2] ?? 'mcp__brain__ask_human';
const tag = tool === 'AskUserQuestion' ? 'askuserquestion' : 'ask-human';
const dir = mkdtempSync(path.join(os.tmpdir(), 'brain-spike-'));
const work = path.join(dir, 'work');
mkdirSync(work);
mkdirSync(path.join(dir, 'brain'));

writeFileSync(
  path.join(dir, 'hook.mjs'),
  `import fs from 'node:fs';
let raw = ''; for await (const c of process.stdin) raw += c;
const ev = JSON.parse(raw);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'hook-inputs.jsonl'))}, raw.trim() + '\\n');
if (ev.tool_name !== ${JSON.stringify(tool)}) process.exit(0);
const f = ${JSON.stringify(path.join(dir, 'answer.json'))};
const out = fs.existsSync(f)
  ? { permissionDecision: 'allow', updatedInput: { ...ev.tool_input, answers: JSON.parse(fs.readFileSync(f, 'utf8')) } }
  : { permissionDecision: 'defer', permissionDecisionReason: 'waiting for the owner' };
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...out } }));
`,
);
const settings = path.join(dir, 'settings.json');
writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: tool, hooks: [{ type: 'command', command: `${process.execPath} ${path.join(dir, 'hook.mjs')}` }] }] } }));
const mcp = path.join(dir, 'mcp.json');
writeFileSync(
  mcp,
  JSON.stringify({
    mcpServers: {
      brain: { type: 'stdio', command: process.execPath, args: ['--disable-warning=ExperimentalWarning', path.join(root, 'src/mcp/server.ts')], env: { BRAIN_DIR: path.join(dir, 'brain') } },
    },
  }),
);

const sid = randomUUID();
const env = agentEnv(process.env, {});
const common = ['--output-format', 'stream-json', '--verbose', '--settings', settings, '--setting-sources', 'project,local', '--mcp-config', mcp, '--strict-mcp-config',
  '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--max-turns', '6', '--model', 'haiku', '--tools', 'Read,AskUserQuestion', '--allowedTools', tool, 'mcp__brain'];

function run(args, name) {
  const r = spawnSync('claude', args, { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const file = path.join(root, 'tests/fixtures', `${tag}-${name}.jsonl`);
  writeFileSync(file, r.stdout);
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const result = lines.findLast((l) => l.type === 'result');
  console.log(`\n== ${name}: exit ${r.status}, ${lines.length} lines → ${path.relative(root, file)}`);
  if (r.stderr.trim()) console.log('stderr:', r.stderr.trim().slice(-1000));
  const init = lines.find((l) => l.type === 'system' && l.subtype === 'init');
  console.log('tool offered:', init?.tools?.includes(tool), '| apiKeySource:', init?.apiKeySource);
  console.log('result:', JSON.stringify({ subtype: result?.subtype, stop_reason: result?.stop_reason, terminal_reason: result?.terminal_reason, is_error: result?.is_error, deferred_tool_use: result?.deferred_tool_use, result: result?.result }, null, 1));
  return { lines, result };
}

const prompt = `Call the ${tool} tool exactly once to ask me which colour to use, with the options "red" and "blue". After you get the answer, reply with only the chosen colour word.`;
const r1 = run(['-p', prompt, '--session-id', sid, ...common], 'run1');
const d = r1.result?.deferred_tool_use;
if (r1.result?.stop_reason !== 'tool_deferred' || !d) {
  console.log('\nVERDICT: defer did NOT pause the run. The runner falls back to ask_human recording the question itself.');
  process.exit(1);
}
const qs = d.input?.questions ?? [];
const answers = tool === 'AskUserQuestion' ? Object.fromEntries(qs.map((q) => [q.question, 'blue'])) : qs.map((q) => ({ question: q.question, answer: 'blue' }));
writeFileSync(path.join(dir, 'answer.json'), JSON.stringify(answers));

let r2 = run(['-p', '--resume', sid, ...common], 'run2');
if (!r2.result || r2.result.is_error) {
  console.log('\nResume without a prompt did not work; retrying with prompt "Continue."');
  r2 = run(['-p', 'Continue.', '--resume', sid, ...common], 'run2-with-prompt');
}
const toolResult = r2.lines.flatMap((l) => (l.type === 'user' ? l.message?.content ?? [] : [])).find((b) => b.type === 'tool_result' && b.tool_use_id === d.id);
console.log('\ntool_result for the deferred call:', JSON.stringify(toolResult)?.slice(0, 500));
copyFileSync(path.join(dir, 'hook-inputs.jsonl'), path.join(root, 'tests/fixtures', `${tag}-hook-inputs.jsonl`));
const ok = /blue/i.test(r2.result?.result ?? '') && toolResult && !toolResult.is_error;
console.log(`\nVERDICT: ${ok ? 'defer + resume works; the model received the answer.' : 'resume did not deliver the answer; see the fixtures.'}`);
console.log(`scratch dir: ${dir}`);
process.exit(ok ? 0 : 1);
