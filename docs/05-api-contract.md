# HTTP API contract (v1)

Shared contract between the backend (Hono server, `src/server`) and the web UI (`web/`). Both sides build against this file; change it here first, then in code.

Base URL: `http://localhost:3141`. All bodies are JSON. Errors: `{ "error": { "code": string, "message": string } }` with 4xx/5xx.

## Types

```ts
type TaskStatus = 'inbox' | 'todo' | 'in_progress' | 'waiting_for_human' | 'review' | 'done' | 'blocked' | 'failed';
type Priority   = 1 | 2 | 3;            // 1 low, 2 normal, 3 high
type PushPolicy = 'never' | 'after_merge';
type TaskKind   = 'work' | 'plan';      // plan = a planner run (see "Planner")
type VerifyStatus = 'passed' | 'failed';

interface Project {
  slug: string;                          // [a-z0-9-]+, unique
  name: string;
  repo_path: string | null;              // absolute path to a git repo, or null for non-code projects
  model: string | null;                  // passed to `claude --model`; null = CLI default
  allowed_tools: string[];               // extra --allowedTools entries on top of the defaults
  push_policy: PushPolicy;               // after approve+merge: push the base branch to its upstream, or not (default never)
  verify_command: string | null;         // shell command run in the task worktree before review, e.g. "pnpm -s test"
  setup_command: string | null;          // prepares a fresh worktree, e.g. "pnpm install"; the agent runs it ($BRAIN_REPO = main checkout)
  max_parallel: number;                  // 1-10 tasks of this project running at once, each in its own worktree (default 1)
  auto_plan: boolean;                    // queue a planner task when the project runs out of open work
  group_slug: string | null;             // the group (product) this project belongs to
  status: 'active' | 'archived';
  created_at: string; updated_at: string;   // ISO 8601
}

interface Group {                        // several projects that make one product (docs/09-project-groups.md)
  slug: string;                          // [a-z0-9-]+, unique
  name: string;
  projects: string[];                    // member project slugs, by name (archived ones included)
  created_at: string; updated_at: string;
}

interface Task {
  id: string;                            // short id, e.g. "t_7f3k2q"
  project_slug: string;
  title: string;
  body: string;                          // markdown
  status: TaskStatus;
  priority: Priority;
  branch: string | null;                 // "brain/<id>-<slug>" when the project has a repo
  session_id: string | null;             // Claude session uuid
  result_summary: string | null;         // final assistant text of the last run
  question_count: number;
  // Delivery (commit → merge → push); see "Delivery" below. All null/0 for tasks without a repo.
  commit_count: number;                  // commits on the task branch since its base (refreshed after every run and on merge)
  merged_sha: string | null;             // squash commit on the base branch, set by approve
  merged_into: string | null;            // base branch name, e.g. "main"
  merged_at: string | null;
  pushed_at: string | null;              // when merged_into was pushed to its upstream
  push_error: string | null;             // last push failure (cleared by a successful push)
  // Dependencies; see "Dependencies" below.
  depends_on: string[];                  // task ids this task waits for
  waiting_on: string[];                  // the subset not yet met; the task is not started while non-empty
  milestone_id: string | null;
  kind: TaskKind;
  worktree: string | null;               // path of the task's git worktree while it has one (removed when done)
  verify_status: VerifyStatus | null;    // result of the project's verify_command after the last run
  schedule_id: string | null;            // the schedule that queued it (null after that schedule is deleted)
  // Task thread; see "Task thread" below.
  waiting_for: { tool_use_id: string; action_id: string | null; since: string } | null;  // set while parked on wait_for_owner
  open_actions: number;                  // agent to-dos for the owner still open
  unread_updates: number;                // agent updates the owner has not read
  created_at: string; updated_at: string;
}

interface TaskMessage {                  // one entry of a task's thread
  id: string;                            // "m_…"
  task_id: string; task_title: string; project_slug: string;
  author: 'agent' | 'owner';
  kind: 'update' | 'action' | 'message'; // update = material to look at · action = to-do for the owner · message = owner chat
  title: string;                         // updates and actions; '' for owner messages
  body: string;                          // markdown
  status: 'open' | 'done' | 'declined' | null;   // actions only
  note: string | null;                   // the owner's note when resolving an action
  created_at: string;
  read_at: string | null;                // agent messages: when the owner saw them
  delivered_at: string | null;           // when the agent got this row's latest owner input; null = pending
  resolved_at: string | null;
}

interface Schedule {                     // see "Schedules" below
  id: string;                            // "s_…"
  project_slug: string;
  title: string; body: string;           // template of the task it queues
  priority: Priority;
  kind: 'once' | 'recurring';
  run_at: string | null;                 // once: ISO time
  cron: string | null;                   // recurring: 5-field cron, server local time
  enabled: boolean;
  next_run_at: string | null;            // null when disabled, or a one-off that already ran
  last_run_at: string | null; last_task_id: string | null;
  run_count: number;
  created_at: string; updated_at: string;
}

interface Milestone {
  id: string;                            // "m_…"
  project_slug: string;
  title: string;                         // unique per project (case-insensitive)
  description: string;                   // what is true when it is done
  status: 'open' | 'done';
  position: number;                      // order within the project
  due: string | null;                    // YYYY-MM-DD
  counts: Partial<Record<TaskStatus, number>>;  // work tasks in it, by status (planner tasks excluded)
  total: number; done: number;
  created_at: string; updated_at: string;
}

interface ProjectSummary {               // one row of GET /api/portfolio
  project: Project;
  counts: Partial<Record<TaskStatus, number>>;  // work tasks by status
  open_questions: number;
  in_review: number;
  milestones: Milestone[];               // open ones, in order
  cost_usd: { total: number; last_7_days: number };
  runs: { total: number; last_7_days: number };
  last_activity: string | null;
  planning: boolean;                     // a planner task is queued, running or waiting on the owner
}

// One AskUserQuestion call = one Question row. `questions` mirrors the tool input.
interface Question {
  id: string;
  task_id: string;
  task_title: string;                    // denormalised for inbox lists
  project_slug: string;
  tool_use_id: string;
  questions: {
    question: string;
    header: string;
    multiSelect: boolean;
    options: { label: string; description: string }[];
  }[];
  answer: { question: string; answer: string }[] | null;
  asked_at: string; answered_at: string | null;
}

interface Run {
  id: string;
  task_id: string;
  session_id: string;
  kind: 'start' | 'resume';
  started_at: string; ended_at: string | null;
  exit_code: number | null;
  stop_reason: string | null;            // end_turn | tool_deferred | max_turns | error_* ...
  usage: Record<string, unknown> | null; // raw usage object from the stream-json `result` line
  cost_usd: number | null;
  log_path: string;
}

interface Event {
  id: number;
  task_id: string | null;
  type: string;                          // persisted activity types, see "Activity event types" below
  payload: Record<string, unknown>;
  created_at: string;
}

interface Commit { sha: string; message: string; author: string; date: string }

interface Note {
  path: string;                          // relative to BRAIN_DIR, e.g. "knowledge/git.md" or "projects/foo/knowledge/api.md"
  scope: 'global' | `project:${string}`;
  title: string;
  tags: string[];
  updated: string | null;
}
```

## Endpoints

### Status
- `GET /api/status` → `{ running: number, concurrency: number, claude_version: string | null, fts5: boolean }`

### Projects
- `GET /api/projects` → `Project[]`
- `POST /api/projects` body `{ slug, name, repo_path?, model?, allowed_tools?, push_policy?, verify_command?, setup_command?, max_parallel?, auto_plan?, group_slug? }` → `Project` (201). An unknown `group_slug` is a 400. Creates `brain/projects/<slug>/PROJECT.md` + `knowledge/`.
- `GET /api/projects/:slug` → `Project`
- `PATCH /api/projects/:slug` body: any subset of `name, repo_path, model, allowed_tools, push_policy, verify_command, setup_command, max_parallel, auto_plan, group_slug, status` → `Project` (`""`/null clears a command)
- `GET /api/projects/:slug/doc` → `{ content: string }` (PROJECT.md; `""` when missing)
- `PUT /api/projects/:slug/doc` body `{ content }` → `{ content }`
- `POST /api/projects/:slug/plan` body `{ focus? }` → `Task` (201): creates a planner task (`kind: 'plan'`, auto, todo, priority 3) and starts it now if the project has room (else the scheduler does). 409 if the project already has a planner task that is not done.
- `GET /api/projects/:slug/mcp` → `{ global: object, project: object, merged: object }` (MCP configs as stored)

### Groups
- `GET /api/groups` → `Group[]`
- `POST /api/groups` body `{ slug, name, projects? }` → `Group` (201). Creates `brain/groups/<slug>/GROUP.md` + `knowledge/`; listed projects move into the group.
- `GET /api/groups/:slug` → `Group`
- `PATCH /api/groups/:slug` body `{ name?, projects? }` → `Group` (`projects` replaces the member list)
- `DELETE /api/groups/:slug` → 204 (projects stay, ungrouped; GROUP.md and group notes stay on disk)
- `GET /api/groups/:slug/doc` → `{ content }` (GROUP.md); `PUT /api/groups/:slug/doc` body `{ content }` → `{ content }`

### Milestones
- `GET /api/projects/:slug/milestones` → `Milestone[]` (ordered by `position`, done ones included)
- `POST /api/projects/:slug/milestones` body `{ title, description?, due?, position? }` → `Milestone` (201). 400 on a duplicate title.
- `GET /api/milestones/:id` → `Milestone`
- `PATCH /api/milestones/:id` body: subset of `title, description, due, position, status` → `Milestone`
- `DELETE /api/milestones/:id` → 204 (its tasks stay, without a milestone)

### Schedules
- `GET /api/schedules?project=<slug>` → `Schedule[]` (enabled first, then by next run)
- `POST /api/schedules` body `{ project_slug, title, body?, priority?, kind, run_at? (once), cron? (recurring), enabled? }` → `Schedule` (201). 400 for a bad time or cron, or a cron that never matches.
- `GET /api/schedules/preview?cron=<expr>` → `{ next: string[] }` (next 3 times; 400 with the parse error)
- `GET /api/schedules/:id` → `Schedule`
- `PATCH /api/schedules/:id` body: subset of `title, body, priority, kind, run_at, cron, enabled` → `Schedule`. A new `run_at` re-arms a one-off that already ran.
- `DELETE /api/schedules/:id` → 204 (tasks it queued stay, with `schedule_id` null)
- `POST /api/schedules/:id/run` → `Task` (201): queues the task now and starts it when it is auto and there is room. The schedule's next run does not move. 409 while its previous task is still queued or running.

How they fire (`src/core/schedules.ts`, every scheduler tick):
- A due schedule creates a `todo` task from its template with `schedule_id` set; a footer in the body says which schedule queued it. It is then started like any other todo task; they land in `review` with the agent's report.
- `once`: fires at `run_at`, then turns itself off. `recurring`: `next_run_at` moves to the next cron match after now. Missed times (server down) are caught up with **one** task.
- Overlap: a recurring time is skipped (event `schedule.skipped`) while the previous task is in `inbox`, `todo`, `in_progress` or `waiting_for_human`. A previous task in `review` (unread report) does not hold the next one back.
- A recurring task's body includes the previous run's `result_summary` and asks what changed.
- Cron: `minute hour day-of-month month day-of-week`, `*`, `a-b`, `*/n`, lists; day-of-week 0–7 (0 and 7 Sunday); both day fields set = either matches; `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. Evaluated in the server's local time zone.
- Archived projects' schedules don't fire.

### Overview
- `GET /api/portfolio` → `{ projects: ProjectSummary[], groups: Group[], totals: { cost_usd, cost_last_7_days, open_questions, in_review, running } }` (active projects only)

### Tasks
- `GET /api/tasks?project=<slug>&group=<slug>&status=<status,status>` → `Task[]` (newest first; all filters optional; `group` = every project of the group)
- `POST /api/tasks` body `{ project_slug, title, body?, priority?, status?, depends_on?, milestone? }` → `Task` (201). `status` may only be `inbox` (default, waits for the owner) or `todo` (the scheduler starts it). `milestone` is a milestone id or title of that project.
- `GET /api/tasks/:id` → `{ task: Task, questions: Question[], runs: Run[], commits: Commit[], events: Event[], messages: TaskMessage[] }` (messages oldest first)
- `PATCH /api/tasks/:id` body: subset of `title, body, priority, status, depends_on, milestone` (`milestone`: id, title or null; `depends_on` replaces the list; 400 for an unknown task, the task itself, or a cycle) → `Task`. Manual `status` changes allowed only between `inbox`, `todo`, `blocked` (and `done` from `review`, which closes the task **without** merging); anything else → 409.
- `POST /api/tasks/:id/start` → `Task` (from `inbox`/`todo`/`blocked`/`failed`; starts a run now). 409 while `waiting_on` is not empty.
- `POST /api/tasks/:id/approve` → `Task` (`review` → `done`). For a task with commits on its branch this first squash-merges the branch into its base branch, then pushes when the project's `push_policy` is `after_merge` (see "Delivery"). 409 (task stays in `review`) on a merge conflict, when the base branch is checked out with uncommitted changes to files the task changes, or when the task or base branch is gone. The response comes back as soon as the merge is done (the returned task has neither `pushed_at` nor `push_error` yet). Removing the worktree and the push run afterwards, and their result arrives as `task.updated` (`worktree: null`, then `pushed_at` or `push_error`). A failed push leaves the task `done` and merged, with `push_error` set. (Until 2026-10-30 the request waited for both, up to 75 s on an unreachable remote, and the synchronous worktree removal froze the whole server for 10–20 s.) The CLI and the owner MCP `approve_task` still wait for the push.
- `POST /api/tasks/:id/merge` → `Task`. Squash-merges a `done` task whose branch never reached its base (closed with `PATCH status → done`, or approved by an outdated server), exactly as approve would. The task stays `done`. When there is nothing left to merge, it records `task.merge_skipped` instead. 409 if the task is not `done`, is already merged, or conflicts with its base.
- `POST /api/tasks/:id/push` → `Task`. Pushes `merged_into` to its upstream, whatever the project's policy (retry after a failure, or push by hand under `never`). 409 if the task was not merged or was already pushed. A push failure returns 200 with `push_error` set.
- `POST /api/tasks/:id/request-changes` body `{ note }` → `Task` (`review` → `in_progress`, resumes the session with the note)
- `POST /api/tasks/:id/cancel` → `Task` (kills a running session if any; status → `blocked`). Accepted from `inbox`, `todo`, `in_progress`, `waiting_for_human`, `review` and `failed`. From `blocked` it is a no-op that returns the task unchanged (any session still running is killed). From `done` → 409. The UI shows Cancel only for the six accepted statuses.
- `POST /api/tasks/:id/sync` → `{ result: SyncResult, task: Task }`: brings the task branch up to date with its base branch (see "Worktrees and sync"). `SyncResult` is `{ status: 'up_to_date' | 'fast_forwarded' | 'merged' | 'no_branch', base? }` or `{ status: 'conflict', base, conflicts: string[] }` (nothing changed; request changes so the agent merges and resolves). 409 while the task is running, when it is done, or has no branch yet.
- `GET /api/tasks/:id/diff` → `text/plain` unified diff of the task branch against its base (empty when no repo)

### Delivery (commit → merge → push)

- **Commit**: agents commit on `brain/<task-id>-<slug>`. When a run ends with changes left uncommitted on that branch, the runner commits them (`WIP: changes the agent left uncommitted`, event `task.autocommit`) so the tree is clean for the next task.
- **Merge**: on approve, the server (never the agent) squash-merges the branch into the base branch it was cut from: one commit on the base whose subject is the task title, body the result summary plus `Task: <id>` / `Branch: <branch>`. Built with `git merge-tree` + `git commit-tree`, so nothing is checked out; if the owner has the base branch checked out, it is fast-forwarded (needs a clean tree). The task branch is kept.
- **Push**: `push_policy: after_merge` pushes the base branch to its configured upstream (`branch.<base>.remote/merge`) right after the merge; no upstream counts as a push failure. `never` leaves it to the owner (Push button / `brain task push`).
- Nothing to merge (no commits, or the changes are already in the base) → approve just marks the task `done`.

### Worktrees and sync
- Every task of a repo project runs in its own git worktree, `BRAIN_WORKTREES_DIR/<project>/<task-id>` (default `~/.secondbrain/worktrees`), on its branch. The owner's checkout is never switched, and its uncommitted changes no longer block anything. Up to `max_parallel` tasks of a project run at once. The worktree is removed when the task is done (approve, merge, or the scheduler's cleanup); the branch stays.
- Before each start the server brings the branch up to date with its base: fast-forward when the branch has no commits of its own, else it merges the base in. On a conflict nothing changes and the agent's prompt starts with an instruction to merge and resolve. Resuming after an answer only fast-forwards. Events: `task.synced { base, to, how }`, `task.sync_conflict { base, files }`.
- Agents run with full permissions (any command, git merge/rebase/reset included); only `git push` is denied. Pushing stays with the server (`push_policy`).

### Verification
- When the project has a `verify_command`, the runner runs it in the worktree after a work task's run ends normally. Pass → `review` with `verify_status: 'passed'`. Fail → the output goes back to the same session (`task.verify_fix`), up to `BRAIN_MAX_VERIFY_FIXES` (2) times in a row; after that the task goes to `review` with `verify_status: 'failed'` and a warning in `result_summary`. Each check records `task.verify { ok, command, exit_code, output }` (last 6000 characters).

### Planner
- A planner task (`kind: 'plan'`) is an agent run that shapes the project instead of changing code: it asks the owner what is unclear, rewrites PROJECT.md, adds milestones and queues the next tasks in the inbox (with milestone and dependencies). It goes to `review` like any task; approve closes it.
- Started by `POST /projects/:slug/plan`, or by the scheduler for `auto_plan` projects with no open work (no task in inbox/todo/in_progress/waiting_for_human/review), at most once per `BRAIN_PLAN_COOLDOWN_HOURS` (6).
- Agent tools it uses: `update_project_doc`, `create_milestone`, `project_board`, `update_task` (dependencies, milestone, priority of inbox/todo tasks), `create_task` (`milestone`, `priority`; from a planner task follow-ups have no dependency by default).
- **Milestone check**: a planner task with `milestone_id` set (title `Check milestone "<title>"`). The scheduler queues one (status `todo`, priority 3, every active project, `auto_plan` or not) when every work task of an open milestone is `done`, no check of it is unfinished, and no check was created since the newest task of the milestone. The agent compares the milestone description with the repository: if something is missing it queues tasks in the milestone (inbox); if it is met it asks the owner (`ask_human`) and, on yes, calls `close_milestone({ milestone })`. A check does not block a project planner (409 only for another project planner) and is not counted in `portfolio.planning`.

### Dependencies

- A task can depend on other tasks (`depends_on`, stored in `task_deps`). A dependency is **met** once it is `done` and its work is in the base branch: it was merged, it had no branch (no repo), or it was approved or merged with nothing to merge. A `done` task whose branch was never merged keeps its dependents waiting until `POST /tasks/:id/merge`.
- The scheduler never starts a task with an unmet dependency, and neither does `start`. Once its dependencies are merged, the task branches from the current branch as usual, so it sees their work.
- A follow-up an agent creates with `create_task` depends on the agent's own task by default. The agent passes `depends_on: []` for independent work.

### Task thread
Non-blocking traffic between a running agent and the owner (docs/07-task-thread.md). Agents post with the brain tools `post_update`, `request_action` and `wait_for_owner`.
- `GET /api/tasks/:id/messages` → `TaskMessage[]` (oldest first)
- `POST /api/tasks/:id/messages` body `{ body }` → `{ message, task }` (201). What happens depends on the task: `in_progress` → delivered at the agent's next tool call by the PostToolUse hook (or the run continues with it if it ends first, event `task.owner_input_continue`); `waiting_for_human` on `wait_for_owner` → resumes; `review` → resumes the session with the message (like request changes); `inbox`/`todo`/`blocked`/`failed` → goes into the next start's prompt; a question pause → delivered after the answer. 409 for a `done` task.
- `POST /api/tasks/:id/messages/read` → `{ marked }` (the owner has seen the agent's messages)
- `GET /api/messages` → `TaskMessage[]` for the Inbox: open actions and unread updates across tasks, newest first
- `POST /api/messages/:id/resolve` body `{ status: 'done' | 'declined', note? }` → `{ message, task }`. The resolution is pending for the agent like a message; a task waiting for it resumes. 409 if already resolved, 400 if not an action.
- Open actions do not block review or approve.

### Task composer
A chat per project that drafts tasks (docs/08-task-composer.md). `ComposerChat { id, project_slug, title, session_id, status: 'idle'|'thinking', cost_usd, created_at, updated_at }`, `ComposerMessage { id, chat_id, role: 'owner'|'assistant'|'error', body, created_at }`, `ComposerDraft { id, chat_id, project_slug (another project of the group, null = the chat's), title, body, priority, milestone (id or title), depends_on (task ids and/or draft ids of the chat), status: 'draft'|'created'|'discarded', task_id, created_at, updated_at }`.
- `GET /api/composer/chats?project=<slug>` → `ComposerChat[]` (newest first)
- `POST /api/composer/chats` body `{ project, title?, message? }` → `{ chat, messages, drafts }` (201). With `message`, the first turn starts right away.
- `GET /api/composer/chats/:id` → `{ chat, messages, drafts }`
- `DELETE /api/composer/chats/:id` → 204 (409 while it is thinking). Created tasks stay.
- `POST /api/composer/chats/:id/messages` body `{ body }` → `{ chat, message }` (201). Starts a turn in the background; the reply arrives as a `composer.message` event. 409 while the previous turn runs.
- `POST /api/composer/chats/:id/stop` → `ComposerChat` (kills the running turn; an `error` message "Stopped." follows)
- `POST /api/composer/chats/:id/create-all` → `{ tasks, drafts }`: every open draft as an inbox task in its project, dependencies first
- `PATCH /api/composer/drafts/:id` body any of `{ project, title, body, priority, milestone, depends_on }` → `ComposerDraft` (409 unless open; 400 for a project outside the group; changing project drops the milestone unless one is given)
- `POST /api/composer/drafts/:id/create` → `{ draft, task }` (an inbox task in the draft's project). 409 if it depends on a draft not created yet. A dependency on a discarded draft is dropped.
- `POST /api/composer/drafts/:id/discard` → `ComposerDraft`

### Questions
- `GET /api/questions?open=true` → `Question[]` (open = unanswered; newest first)
- `POST /api/questions/:id/answer` body `{ answers: { question: string; answer: string }[] }` → `Question` (stores the answer, resumes the session). 409 if already answered.

### Runs
- `GET /api/runs/:id` → `Run`
- `GET /api/runs/:id/log?after=<n>` → `{ lines: string[], next: number }` (raw stream-json lines from index `n`)

### Knowledge
- `GET /api/knowledge?scope=global|group:<slug>|project:<slug>` → `Note[]` (no scope = all)
- `GET /api/knowledge/note?path=<path>` → `{ path, scope, frontmatter: Record<string, unknown>, content: string }` (content = full file including frontmatter)
- `PUT /api/knowledge/note` body `{ path, content }` → `Note` (creates or replaces; path must be under `knowledge/`, `groups/<slug>/knowledge/` or `projects/<slug>/knowledge/`)
  - The server sets the frontmatter field `updated` to today's date (`YYYY-MM-DD`, UTC), the same format agents' `save_note` writes. Only that line changes; a note without frontmatter gets a block holding just `updated`. Exception: if the client changed `updated` on purpose (its value differs from the note on disk, or the note is new and carries one), the client's value is kept. So the UI can send the content back as loaded and the date still moves forward.
- `DELETE /api/knowledge/note?path=<path>` → 204
- `GET /api/knowledge/search?q=<q>&scope=<scope>` → `{ path, title, scope, snippet: string }[]`

### Live events
- `GET /api/events` → `text/event-stream`. Each message: `event: <type>` + `data: <json>`.

| type | data |
|---|---|
| `task.updated` | `Task` |
| `question.created` | `Question` |
| `question.answered` | `Question` |
| `task.message` | `TaskMessage` (created, resolved, or delivered) |
| `run.started` | `Run` |
| `run.log` | `{ run_id, index, line }` |
| `run.ended` | `Run` |
| `knowledge.changed` | `{ path }` |
| `status` | same as `GET /api/status` |

| `project.updated` | `Project` (sent when a project is created or edited, or its PROJECT.md changes) |
| `milestone.updated` | `Milestone` (created or edited, or one of its tasks changed, so progress moved) |
| `milestone.deleted` | `{ id, project_slug }` |
| `group.updated` | `Group` (created, renamed, members or GROUP.md changed; member projects also get `project.updated`) |
| `group.deleted` | `{ slug }` |
| `schedule.updated` | `Schedule` (created, edited, fired or skipped) |
| `schedule.deleted` | `{ id, project_slug }` |
| `composer.chat` | `ComposerChat` (created, title/status/cost changed) |
| `composer.message` | `ComposerMessage` |
| `composer.draft` | `ComposerDraft` (proposed, edited, created or discarded) |
| `composer.deleted` | `{ id, project_slug }` |

Missed events are not replayed: messages carry no `id`, and the server ignores `Last-Event-ID` (`run.log`, `status` and `project.updated` are never stored, so a full replay would not be possible). Clients refetch instead. The server sends `status` as the first message of every connection. After the browser's `EventSource` reconnects, the web UI refetches the inbox count and whatever the open view shows (board, inbox, knowledge tree and note, projects, task drawer, run log), through `useReconnect` in `web/src/live.tsx`.

A heartbeat comment (`: ping`) every 25 s. Changes made by other processes (the `brain` CLI, agents' brain MCP server) reach the stream within ~2 s.

### Activity event types (`Event.type` in `GET /api/tasks/:id`)

| type | payload |
|---|---|
| `task.created` | `{ source: 'owner' \| 'agent:<task-id>' \| 'schedule:<schedule-id>', status }` |
| `schedule.fired` | `{ id, manual }` (on the task the schedule queued) |
| `task.status` | `{ from, to, action?, by?, run_id?, stop_reason?, reason?, via? }` (`via`: `hook_defer` or `ask_human_tool` when parked for a question, `wait_for_owner` / `wait_for_owner_tool` when parked on the owner; `action`: `owner_input` / `owner_message` when the owner's input resumed it) |
| `task.edited` | the changed fields |
| `task.changes_requested` | `{ note }` |
| `task.autocommit` | `{ run_id, sha }` (leftover changes committed after a run) |
| `task.worktree` / `task.worktree_removed` | `{ path, branch? }` |
| `task.synced` | `{ base, to, how: 'fast_forwarded' \| 'merged' }` |
| `task.sync_conflict` | `{ base, files: string[] }` |
| `task.verify` | `{ ok, command, exit_code, output }` |
| `task.verify_fix` | `{ attempt }` (failed checks handed back to the agent) |
| `task.merged` | `{ sha, into }` |
| `task.merge_conflict` | `{ into, files: string[] }` (approve refused; task stays in review) |
| `task.pushed` | `{ branch, remote }` |
| `task.push_failed` | `{ branch, error }` |
| `question.created` / `question.answered` | `{ question_id }` |
| `message.created` / `message.updated` | `{ message_id, kind, author }` |
| `message.delivered` | `{ message_id }` (the agent got it) |
| `message.read` | `{ count }` |
| `task.owner_input_continue` | `{ run_id }` (a message arrived after the agent's last tool call; the run continued with it) |
| `run.started` | `{ run_id, kind }` |
| `run.ended` | `{ run_id, stop_reason, exit_code, cost_usd }` |

Notes for the UI
- Agents ask through the brain MCP tool `mcp__brain__ask_human` (headless Claude Code does not offer `AskUserQuestion`), whose input mirrors `AskUserQuestion`; `options[].description` may be `""` and `header` may be `""`. A `Question.tool_use_id` starting with `mcp_` was recorded by the tool itself rather than paused by the hook; answering works the same.
- `stop_reason` values seen in runs: `end_turn`, `tool_deferred`, `error_max_turns`, `error_<terminal_reason>` (e.g. `error_api_error`), `timeout`, `cancelled`, `interrupted`, `no_result`.

## Dev setup

- Backend listens on `3141`. The web dev server (Vite, port `5173`) proxies `/api` to `http://localhost:3141`.
- In production the backend serves `web/dist` at `/` with an SPA fallback.
