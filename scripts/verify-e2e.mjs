#!/usr/bin/env node
// End-to-end verification (steps 2-7 of docs/04-implementation-plan.md) against a throwaway git repo
// and a throwaway BRAIN_DIR. Starts its own server on a spare port, drives it with the `brain` CLI and
// the HTTP API, and prints PASS/FAIL per step.
//
//   pnpm verify                     # real claude -p runs on your subscription (~5 small sessions)
//   pnpm verify -- --keep           # keep the scratch dir for inspection
//   BRAIN_CLAUDE_BIN=$PWD/tests/fake-claude.mjs pnpm verify    # dry run of the harness, no Claude usage
//
// Run it from a normal terminal: inside a Claude Code sandbox `claude -p` cannot reach the login keychain.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentEnv } from '../src/runner/env.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const fake = Boolean(process.env.BRAIN_CLAUDE_BIN);
const port = Number(process.env.VERIFY_PORT ?? 3199);
const base = `http://127.0.0.1:${port}`;
const scratch = mkdtempSync(path.join(os.tmpdir(), 'brain-verify-'));
const repo = path.join(scratch, 'repo');
const remote = path.join(scratch, 'remote.git');
const brainDir = path.join(scratch, 'brain');
const env = { ...process.env, BRAIN_DIR: brainDir, BRAIN_PORT: String(port), BRAIN_TICK_MS: '2000', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' };
const RUN_TIMEOUT = Number(process.env.VERIFY_TIMEOUT_S ?? (fake ? 30 : 600)) * 1000;

const results = [];
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const brain = (args, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [path.join(root, 'bin/brain.mjs'), ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`brain ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
async function api(method, p, body, attempt = 0) {
  const init = { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined };
  let r;
  try {
    r = await fetch(`${base}/api${p}`, init);
  } catch (err) {
    // A kept-alive socket the server closed (5 s idle timeout) while we were busy with a long step
    // surfaces as TypeError('fetch failed'); one retry on a fresh connection is enough.
    if (attempt === 0 && err instanceof TypeError) return api(method, p, body, 1);
    throw err;
  }
  const ct = r.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
async function waitFor(id, statuses, timeout = RUN_TIMEOUT) {
  const until = Date.now() + timeout;
  let t;
  while (Date.now() < until) {
    t = (await api('GET', `/tasks/${id}`)).task;
    if (statuses.includes(t.status)) return t;
    await sleep(1500);
  }
  throw new Error(`task ${id} still ${t?.status} after ${timeout / 1000}s (wanted ${statuses.join('/')})`);
}
const addTask = (title, extra = []) => brain(['task', 'add', 'selftest', title, ...extra]).split(/\s+/)[0];
const runLog = (taskId) => brain(['task', 'log', taskId, '--raw']);
const allLogs = (taskId) => api('GET', `/tasks/${taskId}`).then((d) => d.runs.map((r) => (existsSync(r.log_path) ? readFileSync(r.log_path, 'utf8') : '')).join('\n'));

async function step(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    log(`PASS  ${name}${note ? `  (${note})` : ''}  [${Math.round((Date.now() - started) / 1000)}s]`);
  } catch (err) {
    results.push({ name, ok: false });
    log(`FAIL  ${name}\n      ${String(err.message ?? err).split('\n').join('\n      ')}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---- setup
log(`scratch: ${scratch}${fake ? `\nusing fake claude: ${process.env.BRAIN_CLAUDE_BIN}` : ''}\n`);
if (!fake) {
  const r = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', env: agentEnv(process.env, {}) });
  if (!/"loggedIn":\s*true/.test(r.stdout ?? '')) {
    log('claude is not logged in here (claude auth status). Log in with `claude` → /login, and run this from a normal terminal, not a sandbox.');
    process.exit(2);
  }
}
mkdirSync(repo, { recursive: true });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'verify@example.com');
git('config', 'user.name', 'Brain Verify');
git('config', 'commit.gpgsign', 'false');
writeFileSync(path.join(repo, 'README.md'), '# selftest\n\nThrowaway repo for Second Brain verification.\n');
git('add', '.');
git('commit', '-q', '-m', 'init');
execFileSync('git', ['init', '-q', '--bare', remote]);
git('remote', 'add', 'origin', remote);
git('push', '-q', 'origin', 'main');

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'src/server/index.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const serverLog = [];
server.stdout.on('data', (c) => serverLog.push(String(c)));
server.stderr.on('data', (c) => serverLog.push(String(c)));
const stop = async () => {
  server.kill('SIGTERM');
  await sleep(500);
};

try {
  await step('1. server up on a spare port, scheduler running', async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const s = await api('GET', '/status');
        return `claude ${s.claude_version}, fts5 ${s.fts5}`;
      } catch {
        await sleep(250);
      }
    }
    throw new Error(`server did not start:\n${serverLog.join('')}`);
  });

  await step('2. register throwaway repo as project selftest (CLI)', async () => {
    brain(['project', 'add', 'selftest', '-n', 'Self test', '-r', repo]);
    const p = await api('GET', '/projects/selftest');
    assert(p.repo_path === repo, `repo_path is ${p.repo_path}`);
  });

  await step('3. auto task → brain/<id>-… branch with a commit → review → approve → squash-merged into main → done', async () => {
    const id = addTask("Add a line 'hello from brain' to README.md and commit.", ['--todo']);
    const t = await waitFor(id, ['review', 'failed', 'blocked', 'waiting_for_human']);
    assert(t.status === 'review', `ended ${t.status}: ${t.result_summary}`);
    assert(new RegExp(`^brain/${id}-`).test(t.branch ?? ''), `branch ${t.branch}`);
    const d = await api('GET', `/tasks/${id}`);
    assert(d.commits.length >= 1, 'no commits on the task branch');
    assert(git('show', `${t.branch}:README.md`).includes('hello from brain'), 'README.md on the branch lacks the line');
    const diff = await api('GET', `/tasks/${id}/diff`);
    assert(diff.includes('+hello from brain') || diff.toLowerCase().includes('hello from brain'), 'diff does not show the line');
    const approved = await api('POST', `/tasks/${id}/approve`);
    assert(approved.status === 'done', 'approve did not give done');
    assert(git('branch', '--show-current') === 'main', 'repo was not switched back to main');
    assert(approved.merged_sha && git('rev-parse', 'main') === approved.merged_sha, 'main is not at the squash-merge commit');
    assert(!approved.pushed_at, 'pushed although the project push policy is never');
    return `${d.commits.length} commit(s) on ${t.branch}, squash-merged as ${approved.merged_sha.slice(0, 7)}`;
  });

  await step('4. question → waiting_for_human → `brain task answer` → resume → colour.txt = blue → review', async () => {
    const id = addTask('Ask me which colour to use, then write it into colour.txt and commit.', ['--todo']);
    const t = await waitFor(id, ['waiting_for_human', 'review', 'failed', 'blocked']);
    assert(t.status === 'waiting_for_human', `ended ${t.status} without asking: ${t.result_summary}`);
    const open = await api('GET', '/questions?open=true');
    const q = open.find((x) => x.task_id === id);
    assert(q, 'no open question in the inbox');
    const parts = q.questions.length;
    brain(['task', 'answer', id, ...Array(parts).fill('blue')]);
    const after = await waitFor(id, ['review', 'failed', 'blocked', 'waiting_for_human']);
    assert(after.status === 'review', `after the answer it ended ${after.status}: ${after.result_summary}`);
    const colour = git('show', `${after.branch}:colour.txt`).toLowerCase();
    assert(colour.includes('blue'), `colour.txt is "${colour}"`);
    const runs = (await api('GET', `/tasks/${id}`)).runs.map((r) => r.stop_reason);
    return `runs: ${runs.join(' → ')}; question tool_use_id ${q.tool_use_id.startsWith('mcp_') ? 'recorded by ask_human (no hook pause)' : 'paused by the hook'}`;
  });

  await step('5. knowledge: agent calls search_knowledge and follows the commit style', async () => {
    brain(['knowledge', 'add', 'global', 'Commit style', '-c', 'Preferred commit style: conventional commits (e.g. "feat: …", "docs: …").']);
    const hits = await api('GET', '/knowledge/search?q=commit%20style');
    assert(hits.some((h) => h.path === 'knowledge/commit-style.md'), 'note not found via the API');
    const id = addTask('Check the knowledge base for the preferred commit style and use it: add a CHANGELOG.md with one line "- initial changelog" and commit.', ['--todo']);
    const t = await waitFor(id, ['review', 'failed', 'blocked', 'waiting_for_human']);
    assert(t.status === 'review', `ended ${t.status}: ${t.result_summary}`);
    const logs = await allLogs(id);
    assert(logs.includes('mcp__brain__search_knowledge'), 'the agent never called mcp__brain__search_knowledge');
    const msgs = (await api('GET', `/tasks/${id}`)).commits.map((c) => c.message);
    assert(msgs.length && msgs.every((m) => /^[a-z]+(\([^)]+\))?!?: /.test(m)), `commit messages not conventional: ${JSON.stringify(msgs)}`);
    return msgs.join(' | ');
  });

  await step('6a. guardrail: git push is blocked', async () => {
    const id = addTask('Commit nothing; just run `git push origin HEAD` to publish the current branch and report what happened.', ['--todo']);
    const t = await waitFor(id, ['review', 'failed', 'blocked', 'waiting_for_human']);
    const remoteBranches = execFileSync('git', ['branch', '--list'], { cwd: remote, encoding: 'utf8' });
    assert(!remoteBranches.includes('brain/'), `a brain branch reached the remote:\n${remoteBranches}`);
    const logs = await allLogs(id);
    const denied = /may not push|permission|denied|not allowed|blocked/i.test(logs);
    assert(denied, 'no sign of the push being denied in the log');
    return `task ended ${t.status}; remote has only: ${remoteBranches.trim().replace(/\s+/g, ' ')}`;
  });

  await step('6b. guardrail: max turns ends failed with the log readable', async () => {
    const id = addTask('Read every file in this repository one at a time, then write a SUMMARY.md describing each, then commit.');
    // Foreground run with a tiny turn budget (point the CLI at a port with no server).
    spawnSync(process.execPath, [path.join(root, 'bin/brain.mjs'), 'run', id], { env: { ...env, BRAIN_MAX_TURNS: '1', BRAIN_PORT: String(port + 1) }, encoding: 'utf8', timeout: RUN_TIMEOUT });
    const d = await api('GET', `/tasks/${id}`);
    assert(d.task.status === 'failed', `ended ${d.task.status}: ${d.task.result_summary}`);
    const run = d.runs[d.runs.length - 1];
    assert(run.stop_reason === 'error_max_turns', `stop_reason ${run.stop_reason}`);
    const { lines } = await api('GET', `/runs/${run.id}/log`);
    assert(lines.length > 1, 'log is empty');
    assert(runLog(id).includes('error_max_turns'), '`brain task log` does not show the result');
    return `${lines.length} log lines, summary: ${d.task.result_summary.split('\n')[0]}`;
  });

  await step('7. pnpm test', async () => {
    const r = spawnSync('pnpm', ['-s', 'test'], { cwd: root, encoding: 'utf8' });
    assert(r.status === 0, (r.stdout + r.stderr).split('\n').slice(-25).join('\n'));
    return /Tests\s+(.*)/.exec(r.stdout)?.[1]?.trim();
  });
} finally {
  await stop();
}

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name.split(' ')[0]).join(', ')}` : ''}`);
if (keep || failed.length) log(`scratch kept at ${scratch} (server log below)\n\n${serverLog.join('').split('\n').slice(-30).join('\n')}`);
else rmSync(scratch, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
