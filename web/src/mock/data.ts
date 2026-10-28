// Seed data for VITE_MOCK=1. Everything lives in memory and resets on reload.
import type { BrainEvent, Commit, Milestone, Project, Question, Run, Schedule, Task, TaskMessage } from '../api/types';

const now = Date.now();
export const ago = (min: number) => new Date(now - min * 60_000).toISOString();

export const projects: Project[] = [
  {
    slug: 'secondbrain',
    name: 'Second Brain',
    repo_path: '/Users/owner/Projects/SecondBrain',
    model: 'claude-opus-5-5',
    allowed_tools: ['Bash(pnpm test:*)', 'Bash(pnpm build:*)'],
    push_policy: 'after_merge',
    verify_command: 'pnpm -s typecheck && pnpm -s test',
    setup_command: 'pnpm install --frozen-lockfile',
    max_parallel: 2,
    auto_plan: true,
    status: 'active',
    created_at: ago(60 * 24 * 3),
    updated_at: ago(60 * 5),
  },
  {
    slug: 'website',
    name: 'Personal website',
    repo_path: '/Users/owner/Projects/website',
    model: null,
    allowed_tools: ['Bash(npm run lint:*)'],
    push_policy: 'never',
    verify_command: 'npm run lint',
    setup_command: null,
    max_parallel: 1,
    auto_plan: false,
    status: 'active',
    created_at: ago(60 * 24 * 20),
    updated_at: ago(60 * 24),
  },
  {
    slug: 'home-reno',
    name: 'Home renovation',
    repo_path: null,
    model: 'claude-sonnet-5-5',
    allowed_tools: [],
    push_policy: 'never',
    verify_command: null,
    setup_command: null,
    max_parallel: 1,
    auto_plan: false,
    status: 'active',
    created_at: ago(60 * 24 * 40),
    updated_at: ago(60 * 24 * 2),
  },
  {
    slug: 'old-blog',
    name: 'Old blog migration',
    repo_path: '/Users/owner/Projects/old-blog',
    model: null,
    allowed_tools: [],
    push_policy: 'never',
    verify_command: null,
    setup_command: null,
    max_parallel: 1,
    auto_plan: false,
    status: 'archived',
    created_at: ago(60 * 24 * 120),
    updated_at: ago(60 * 24 * 30),
  },
];

let seq = 100;
export const newId = (prefix: string) => `${prefix}_${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function task(p: Partial<Task> & Pick<Task, 'id' | 'project_slug' | 'title'>, minAgo: number): Task {
  return {
    body: '',
    status: 'inbox',
    priority: 2,
    branch: null,
    session_id: null,
    result_summary: null,
    question_count: 0,
    commit_count: 0,
    merged_sha: null,
    merged_into: null,
    merged_at: null,
    pushed_at: null,
    push_error: null,
    depends_on: [],
    waiting_on: [],
    milestone_id: null,
    kind: 'work',
    worktree: null,
    verify_status: null,
    schedule_id: null,
    waiting_for: null,
    open_actions: 0,
    unread_updates: 0,
    created_at: ago(minAgo),
    updated_at: ago(Math.max(1, minAgo - 30)),
    ...p,
  };
}

export const tasks: Task[] = [
  task(
    {
      id: 't_inb01a',
      project_slug: 'secondbrain',
      title: 'Telegram channel adapter',
      body: 'Sketch how a Telegram bot would map messages to tasks, notes and answers.\n\n- inbound: message → classify\n- outbound: question → message with buttons',
      priority: 1,
    },
    60 * 30,
  ),
  task(
    { id: 't_inb02b', project_slug: 'home-reno', title: 'Collect quotes for kitchen tiles', body: 'Three suppliers at least. Budget is in the project notes.' },
    60 * 20,
  ),
  task(
    {
      id: 't_todo1c',
      project_slug: 'secondbrain',
      title: 'Add FTS5 fallback test',
      body: 'Cover the substring-scan fallback used when `node:sqlite` lacks FTS5.',
      status: 'todo',
      priority: 3,
      milestone_id: 'm_search',
    },
    60 * 10,
  ),
  task(
    { id: 't_todo2d', project_slug: 'website', title: 'Fix dark-mode contrast on blog cards', status: 'todo', branch: null },
    60 * 8,
  ),
  task(
    {
      id: 't_prog1e',
      project_slug: 'secondbrain',
      title: 'Write knowledge index rebuild on file change',
      body: 'Watch `brain/knowledge` and project knowledge dirs, rebuild the FTS index for changed files only.',
      status: 'in_progress',
      priority: 3,
      milestone_id: 'm_search',
      worktree: '/Users/owner/.secondbrain/worktrees/secondbrain/t_prog1e',
      branch: 'brain/t_prog1e-knowledge-index-rebuild',
      session_id: '5b0c7a7e-2f1d-4f1e-9a1b-3a7d2c1e0f11',
    },
    90,
  ),
  task(
    {
      id: 't_adtg1z',
      project_slug: 'website',
      title: 'Advertise the website on Telegram channels',
      body: 'Find 3–5 Telegram channels our readers follow, write the ad, and get it posted. Budget: 150 USDT.',
      status: 'in_progress',
      session_id: '9d1e2c3b-4a5f-4e6d-8c7b-6a5f4e3d2c1b',
    },
    45,
  ),
  task(
    {
      id: 't_wait1f',
      project_slug: 'website',
      title: 'Redesign the about page',
      body: 'Make it shorter and add the new photo. Keep the tone casual.',
      status: 'waiting_for_human',
      branch: 'brain/t_wait1f-about-page',
      milestone_id: 'm_launch',
      session_id: '9e1f6c22-5d4a-4b8b-8c0e-7d1a2b3c4d5e',
      question_count: 1,
    },
    240,
  ),
  task(
    {
      id: 't_wait2g',
      project_slug: 'home-reno',
      title: 'Plan the bathroom schedule',
      body: 'Plumber and tiler availability, in the right order.',
      status: 'waiting_for_human',
      session_id: '1a2b3c4d-0000-4000-8000-aaaaaaaaaaaa',
      question_count: 2,
    },
    300,
  ),
  task(
    {
      id: 't_rev01h',
      project_slug: 'secondbrain',
      title: 'Add `brain task list --json` flag',
      body: 'Machine-readable output for scripts.',
      status: 'review',
      branch: 'brain/t_rev01h-task-list-json',
      commit_count: 1,
      milestone_id: 'm_cli',
      worktree: '/Users/owner/.secondbrain/worktrees/secondbrain/t_rev01h',
      verify_status: 'passed',
      session_id: '2c3d4e5f-1111-4111-8111-bbbbbbbbbbbb',
      result_summary:
        'Added a `--json` flag to `brain task list` that prints the task array as JSON. Covered by a new test in `cli.test.ts`. One commit on `brain/t_rev01h-task-list-json`.',
    },
    180,
  ),
  task(
    {
      id: 't_rev02i',
      project_slug: 'website',
      title: 'Update RSS feed to include full content',
      status: 'review',
      branch: 'brain/t_rev02i-rss-full-content',
      commit_count: 2,
      worktree: '/Users/owner/.secondbrain/worktrees/website/t_rev02i',
      milestone_id: 'm_launch',
      verify_status: 'failed',
      session_id: '3d4e5f60-2222-4222-8222-cccccccccccc',
      result_summary: 'The feed now embeds the full HTML of each post in `content:encoded`. Validated with the W3C feed validator locally.',
      question_count: 1,
    },
    600,
  ),
  task(
    {
      id: 't_done1j',
      project_slug: 'secondbrain',
      title: 'Initial SQLite migrations',
      status: 'done',
      milestone_id: 'm_cli',
      branch: 'brain/t_done1j-initial-migrations',
      commit_count: 1,
      merged_sha: 'e5f60718293a4b5c6d7e8f90123456789012345a',
      merged_into: 'main',
      merged_at: ago(60 * 25),
      pushed_at: ago(60 * 25),
      result_summary: 'Created 0001_init.sql with projects, tasks, questions, runs, events.',
    },
    60 * 26,
  ),
  task({ id: 't_done2k', project_slug: 'home-reno', title: 'Measure the kitchen', status: 'done' }, 60 * 24 * 5),
  task(
    {
      id: 't_blk01l',
      project_slug: 'website',
      title: 'Migrate hosting to the new provider',
      body: 'Blocked until DNS access is sorted.',
      status: 'blocked',
      priority: 1,
    },
    60 * 24 * 2,
  ),
  task(
    {
      id: 't_fail1m',
      project_slug: 'secondbrain',
      title: 'Benchmark scheduler with 50 tasks',
      status: 'failed',
      branch: 'brain/t_fail1m-bench-scheduler',
      session_id: '4e5f6071-3333-4333-8333-dddddddddddd',
      result_summary: null,
    },
    60 * 6,
  ),
];

export const milestones: Milestone[] = [
  {
    id: 'm_cli',
    project_slug: 'secondbrain',
    title: 'CLI parity',
    description: 'Everything the web UI can do also works from `brain`.',
    status: 'open',
    position: 1,
    due: '2026-11-15',
    counts: {},
    total: 0,
    done: 0,
    created_at: ago(60 * 24 * 3),
    updated_at: ago(60 * 24),
  },
  {
    id: 'm_search',
    project_slug: 'secondbrain',
    title: 'Fast knowledge search',
    description: 'Search results update within a second of a note changing.',
    status: 'open',
    position: 2,
    due: null,
    counts: {},
    total: 0,
    done: 0,
    created_at: ago(60 * 24 * 2),
    updated_at: ago(60 * 24 * 2),
  },
  {
    id: 'm_launch',
    project_slug: 'website',
    title: 'Relaunch',
    description: 'New about page and full-content RSS are live.',
    status: 'open',
    position: 1,
    due: '2026-12-01',
    counts: {},
    total: 0,
    done: 0,
    created_at: ago(60 * 24 * 5),
    updated_at: ago(60 * 24 * 5),
  },
];

/** PROJECT.md per project slug. */
const hourFromNow = (h: number) => new Date(now + h * 3_600_000).toISOString();

export const schedules: Schedule[] = [
  {
    id: 's_weekly1',
    project_slug: 'secondbrain',
    title: 'Check the error log',
    body: 'Read the server log for the past week and report new errors.',
    priority: 2,
    kind: 'recurring',
    run_at: null,
    cron: '0 9 * * 1',
    enabled: true,
    next_run_at: hourFromNow(60),
    last_run_at: ago(60 * 24 * 4),
    last_task_id: null,
    run_count: 3,
    created_at: ago(60 * 24 * 30),
    updated_at: ago(60 * 24 * 4),
  },
  {
    id: 's_once01',
    project_slug: 'home-reno',
    title: 'Did the tile supplier reply?',
    body: 'Check whether the supplier answered the quote request; if not, draft a follow-up.',
    priority: 2,
    kind: 'once',
    run_at: hourFromNow(30),
    cron: null,
    enabled: true,
    next_run_at: hourFromNow(30),
    last_run_at: null,
    last_task_id: null,
    run_count: 0,
    created_at: ago(60 * 5),
    updated_at: ago(60 * 5),
  },
];

export const docs: Record<string, string> = {
  secondbrain: `# Second Brain

A personal task manager that hands work to Claude Code sessions and keeps a knowledge base.

## Goals
- Owner answers questions from one inbox.
- Every task of a repo project runs in its own worktree.
`,
  website: '# Personal website\n\nStatic site, deployed from `main`.\n',
  'home-reno': '',
  'old-blog': '',
};

export const questions: Question[] = [
  {
    id: 'q_001',
    task_id: 't_wait1f',
    task_title: 'Redesign the about page',
    project_slug: 'website',
    tool_use_id: 'toolu_01AboutPagePhoto',
    questions: [
      {
        question: 'Which photo should go at the top of the about page?',
        header: 'Photo',
        multiSelect: false,
        options: [
          { label: 'Mountain hike (2025)', description: 'Outdoor, casual, landscape crop' },
          { label: 'Conference talk', description: 'Professional, on stage' },
          { label: 'No photo', description: 'Text only, keeps the page lighter' },
        ],
      },
      {
        question: 'Which sections should stay on the page?',
        header: 'Sections',
        multiSelect: true,
        options: [
          { label: 'Now', description: 'What I am working on these days' },
          { label: 'Timeline', description: 'Career history by year' },
          { label: 'Contact', description: 'Email and socials' },
          { label: 'Uses', description: 'Tools and setup' },
        ],
      },
    ],
    answer: null,
    asked_at: ago(35),
    answered_at: null,
  },
  {
    id: 'q_002',
    task_id: 't_wait2g',
    task_title: 'Plan the bathroom schedule',
    project_slug: 'home-reno',
    tool_use_id: 'toolu_01BathroomOrder',
    questions: [
      {
        question: 'The plumber can come either week 45 or week 47. Which one?',
        header: 'Plumber',
        multiSelect: false,
        options: [
          { label: 'Week 45', description: 'Tiler would then start week 46' },
          { label: 'Week 47', description: 'Leaves a buffer for the tile delivery' },
        ],
      },
    ],
    answer: null,
    asked_at: ago(12),
    answered_at: null,
  },
  {
    id: 'q_000',
    task_id: 't_wait2g',
    task_title: 'Plan the bathroom schedule',
    project_slug: 'home-reno',
    tool_use_id: 'toolu_01BathroomBudget',
    questions: [
      {
        question: 'Is the €8,000 budget still the ceiling?',
        header: 'Budget',
        multiSelect: false,
        options: [
          { label: 'Yes', description: 'Hard ceiling' },
          { label: 'Up to €9,000', description: 'Some room for better tiles' },
        ],
      },
    ],
    answer: [{ question: 'Is the €8,000 budget still the ceiling?', answer: 'Up to €9,000' }],
    asked_at: ago(200),
    answered_at: ago(190),
  },
  {
    id: 'q_rss',
    task_id: 't_rev02i',
    task_title: 'Update RSS feed to include full content',
    project_slug: 'website',
    tool_use_id: 'toolu_01RssScope',
    questions: [
      {
        question: 'Should drafts ever appear in the feed?',
        header: 'Drafts',
        multiSelect: false,
        options: [
          { label: 'Never', description: '' },
          { label: 'Only with a flag', description: 'e.g. ?drafts=1 for preview' },
        ],
      },
    ],
    answer: [{ question: 'Should drafts ever appear in the feed?', answer: 'Never' }],
    asked_at: ago(560),
    answered_at: ago(550),
  },
];

const L = (o: unknown) => JSON.stringify(o);
export const sampleLog = (taskTitle: string, endWith: 'end_turn' | 'tool_deferred' | 'error' | 'running'): string[] => {
  const lines = [
    L({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'AskUserQuestion'] }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: `Starting on "${taskTitle}". Let me look at the relevant files first.` }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_a1', name: 'Glob', input: { pattern: 'src/**/*.ts' } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'src/core/knowledge.ts\nsrc/core/tasks.ts\nsrc/db/client.ts' }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_a2', name: 'Read', input: { file_path: 'src/core/knowledge.ts' } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a2', content: '(212 lines)' }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'The index is rebuilt as a whole today. I will add a per-file update path.' }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_a3', name: 'Edit', input: { file_path: 'src/core/knowledge.ts', old_string: '…', new_string: '…' } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a3', content: 'ok' }] } }),
  ];
  if (endWith === 'end_turn') {
    lines.push(
      L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_a4', name: 'Bash', input: { command: 'git commit -am "feat: incremental index"' } }] } }),
      L({ type: 'result', subtype: 'success', stop_reason: 'end_turn', total_cost_usd: 0.42, usage: { input_tokens: 18234, output_tokens: 2210 }, result: 'Done. One commit.' }),
    );
  } else if (endWith === 'tool_deferred') {
    lines.push(
      L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_q1', name: 'AskUserQuestion', input: { questions: [{ question: '…' }] } }] } }),
      L({ type: 'result', subtype: 'success', stop_reason: 'tool_deferred', total_cost_usd: 0.18, usage: { input_tokens: 9100, output_tokens: 640 } }),
    );
  } else if (endWith === 'error') {
    lines.push(
      L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Running the benchmark harness…' }] } }),
      L({ type: 'result', subtype: 'error_max_turns', stop_reason: 'max_turns', total_cost_usd: 1.91, usage: { input_tokens: 120034, output_tokens: 9020 } }),
    );
  }
  return lines;
};

function run(id: string, t: Task, kind: Run['kind'], startMin: number, end: Run['stop_reason'] | null, cost: number | null): Run {
  return {
    id,
    task_id: t.id,
    session_id: t.session_id ?? '00000000-0000-4000-8000-000000000000',
    kind,
    started_at: ago(startMin),
    ended_at: end ? ago(startMin - 4) : null,
    exit_code: end ? (end === 'max_turns' ? 1 : 0) : null,
    stop_reason: end,
    usage: end ? { input_tokens: 12000, output_tokens: 1500 } : null,
    cost_usd: cost,
    log_path: `brain/runs/${t.id}/${id}.jsonl`,
  };
}

const byId = (id: string) => tasks.find((t) => t.id === id)!;

export const runs: Run[] = [
  run('r_prog1', byId('t_prog1e'), 'start', 20, null, null),
  run('r_wait1', byId('t_wait1f'), 'start', 40, 'tool_deferred', 0.18),
  run('r_wait2a', byId('t_wait2g'), 'start', 210, 'tool_deferred', 0.09),
  run('r_wait2b', byId('t_wait2g'), 'resume', 185, 'tool_deferred', 0.07),
  run('r_rev1', byId('t_rev01h'), 'start', 170, 'end_turn', 0.42),
  run('r_rev2a', byId('t_rev02i'), 'start', 580, 'tool_deferred', 0.11),
  run('r_rev2b', byId('t_rev02i'), 'resume', 545, 'end_turn', 0.36),
  run('r_done1', byId('t_done1j'), 'start', 60 * 25, 'end_turn', 0.55),
  run('r_fail1', byId('t_fail1m'), 'start', 60 * 5, 'max_turns', 1.91),
];

export const runLogs: Record<string, string[]> = {
  r_prog1: sampleLog('Write knowledge index rebuild on file change', 'running').slice(0, 4),
  r_wait1: sampleLog('Redesign the about page', 'tool_deferred'),
  r_wait2a: sampleLog('Plan the bathroom schedule', 'tool_deferred'),
  r_wait2b: sampleLog('Plan the bathroom schedule', 'tool_deferred'),
  r_rev1: sampleLog('Add `brain task list --json` flag', 'end_turn'),
  r_rev2a: sampleLog('Update RSS feed', 'tool_deferred'),
  r_rev2b: sampleLog('Update RSS feed', 'end_turn'),
  r_done1: sampleLog('Initial SQLite migrations', 'end_turn'),
  r_fail1: sampleLog('Benchmark scheduler with 50 tasks', 'error'),
};

export const commits: Record<string, Commit[]> = {
  t_rev01h: [
    { sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', message: 'feat(cli): add --json flag to task list', author: 'Claude', date: ago(165) },
  ],
  t_rev02i: [
    { sha: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890', message: 'feat(rss): embed full post content', author: 'Claude', date: ago(548) },
    { sha: 'c3d4e5f60718293a4b5c6d7e8f90123456789012', message: 'test(rss): snapshot the feed output', author: 'Claude', date: ago(546) },
  ],
  t_done1j: [{ sha: 'd4e5f60718293a4b5c6d7e8f9012345678901234', message: 'feat(db): initial migrations', author: 'Claude', date: ago(60 * 25) }],
  t_prog1e: [],
};

export const diffs: Record<string, string> = {
  t_rev01h: `diff --git a/src/cli/index.ts b/src/cli/index.ts
index 3f2a1b0..8c9d4e2 100644
--- a/src/cli/index.ts
+++ b/src/cli/index.ts
@@ -42,9 +42,14 @@ task
   .command('list')
   .option('-p, --project <slug>', 'filter by project')
+  .option('--json', 'print JSON instead of a table')
   .action(async (opts) => {
     const rows = listTasks(db, { project: opts.project });
-    printTable(rows);
+    if (opts.json) {
+      process.stdout.write(JSON.stringify(rows, null, 2) + '\\n');
+    } else {
+      printTable(rows);
+    }
   });
`,
  t_rev02i: `diff --git a/src/feed.ts b/src/feed.ts
index 1111111..2222222 100644
--- a/src/feed.ts
+++ b/src/feed.ts
@@ -10,7 +10,8 @@ export function item(post: Post) {
   return {
     title: post.title,
     link: post.url,
-    description: post.excerpt,
+    description: post.excerpt,
+    'content:encoded': post.html,
   };
 }
`,
};

export const events: BrainEvent[] = [
  { id: 1, task_id: 't_rev01h', type: 'task.status', payload: { from: 'todo', to: 'in_progress', action: 'scheduler' }, created_at: ago(170) },
  { id: 2, task_id: 't_rev01h', type: 'task.status', payload: { from: 'in_progress', to: 'review', run_id: 'r_rev1', stop_reason: 'end_turn' }, created_at: ago(165) },
  { id: 3, task_id: 't_wait2g', type: 'question.answered', payload: { question_id: 'q_000' }, created_at: ago(190) },
  { id: 4, task_id: 't_rev01h', type: 'task.worktree', payload: { path: '/Users/owner/.secondbrain/worktrees/secondbrain/t_rev01h', branch: 'brain/t_rev01h-task-list-json' }, created_at: ago(171) },
  { id: 5, task_id: 't_rev01h', type: 'task.synced', payload: { base: 'main', to: 'a1b2c3d', how: 'fast_forwarded' }, created_at: ago(170) },
  { id: 6, task_id: 't_rev01h', type: 'task.verify', payload: { ok: true, command: 'pnpm -s typecheck && pnpm -s test', exit_code: 0, output: '✓ tests/cli.test.ts (14)\n\nTest Files  1 passed (1)\n     Tests  14 passed (14)' }, created_at: ago(166) },
  { id: 7, task_id: 't_rev02i', type: 'task.sync_conflict', payload: { base: 'main', files: ['src/feed.ts'] }, created_at: ago(580) },
  { id: 8, task_id: 't_rev02i', type: 'task.verify', payload: { ok: false, command: 'npm run lint', exit_code: 1, output: "src/feed.ts\n  14:5  error  'post.html' is possibly undefined  @typescript-eslint/no-unsafe-member-access\n\n✖ 1 problem (1 error, 0 warnings)" }, created_at: ago(560) },
  { id: 9, task_id: 't_rev02i', type: 'task.verify_fix', payload: { attempt: 1 }, created_at: ago(559) },
  { id: 10, task_id: 't_rev02i', type: 'task.verify', payload: { ok: false, command: 'npm run lint', exit_code: 1, output: "src/feed.ts\n  14:5  error  'post.html' is possibly undefined\n\n✖ 1 problem (1 error, 0 warnings)" }, created_at: ago(546) },
];

export const notes: Record<string, string> = {
  'knowledge/index.md': `---
title: Index
tags: [meta]
updated: 2026-10-19
---

# Knowledge index

Short map of what lives here.

- [Commit style](git.md) – conventional commits
- [Writing](writing.md) – tone and language rules
`,
  'knowledge/git.md': `---
title: Commit style
tags: [git, conventions]
updated: 2026-10-18
---

Preferred commit style: **conventional commits**.

\`\`\`
feat(scope): short summary
\`\`\`

Never push or merge from an agent session.
`,
  'knowledge/writing.md': `---
title: Writing
tags: [style]
updated: 2026-10-12
---

- Code, docs and commits are in English.
- Prefer short sentences. No marketing words.
`,
  'projects/secondbrain/knowledge/runner.md': `---
title: Runner notes
tags: [runner, claude]
updated: 2026-10-19
---

## Hook defer round trip

\`AskUserQuestion\` is deferred by the PreToolUse hook; the run exits with \`tool_deferred\` and is resumed with \`--resume\`.

| Limit | Default |
|---|---|
| wall clock | 30 min |
| max turns | 60 |
`,
  'projects/website/knowledge/design.md': `---
title: Design tokens
tags: [css, design]
updated: 2026-09-30
---

Accent colour is \`#3b6cf6\`. Dark mode follows the system setting.
`,
  'projects/home-reno/knowledge/budget.md': `---
title: Budget
tags: [money]
updated: 2026-10-01
---

Kitchen: €12,000. Bathroom: up to €9,000 (raised from €8,000).
`,
};

export const mcp: Record<string, { project: Record<string, unknown> }> = {
  secondbrain: { project: { mcpServers: { sqlite: { command: 'npx', args: ['-y', 'mcp-server-sqlite', 'brain/state.sqlite'] } } } },
  website: { project: { mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] } } } },
  'home-reno': { project: {} },
  'old-blog': { project: {} },
};

export const globalMcp: Record<string, unknown> = {
  mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } },
};

const msg = (p: Partial<TaskMessage> & Pick<TaskMessage, 'id' | 'task_id' | 'author' | 'kind'>, minAgo: number): TaskMessage => ({
  task_title: '',
  project_slug: '',
  title: '',
  body: '',
  status: null,
  note: null,
  created_at: ago(minAgo),
  read_at: null,
  delivered_at: ago(minAgo),
  resolved_at: null,
  ...p,
});

export const messages: TaskMessage[] = [
  msg(
    {
      id: 'm_ad001',
      task_id: 't_adtg1z',
      author: 'agent',
      kind: 'update',
      title: 'Candidate channels',
      body: '| Channel | Members | Price / post |\n|---|---|---|\n| @webdev_daily | 48k | 60 USDT |\n| @frontend_tips | 21k | 35 USDT |\n| @indiehackers_fa | 12k | 20 USDT |\n\nI am leaning towards the first two.',
      read_at: ago(30),
    },
    38,
  ),
  msg({ id: 'm_ad002', task_id: 't_adtg1z', author: 'owner', kind: 'message', body: 'Skip @indiehackers_fa, their audience is not ours.' }, 32),
  msg(
    {
      id: 'm_ad003',
      task_id: 't_adtg1z',
      author: 'agent',
      kind: 'update',
      title: 'Ad drafts (3)',
      body: '1. **Build faster sites** — our weekly guide to performance, free.\n2. **Your site is slow. Here is why.** A 5‑minute read every Friday.\n3. **Ship less JavaScript** — practical tips from real projects.',
    },
    12,
  ),
  msg(
    {
      id: 'm_ad004',
      task_id: 't_adtg1z',
      author: 'agent',
      kind: 'action',
      title: 'Pay @webdev_daily admin 60 USDT',
      body: 'The admin (@wd_admin) only accepts USDT (TRC20) to `TXy…9k`. Mark this done with the transaction id and I will book the slot.',
      status: 'open',
    },
    6,
  ),
];
