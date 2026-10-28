# Running Second Brain

Everything runs locally on the owner's Mac: one Node process (HTTP API, web UI, scheduler) plus one headless `claude -p` per active task.

## Requirements

- Node 25+ (TypeScript runs natively, `node:sqlite` is built in), pnpm 10.
- Claude Code CLI on `PATH` (tested with 2.1.296), **logged in with your subscription** (`claude` → `/login`). Check it with `claude auth status`; it should say `"loggedIn": true`.
- Do **not** set `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. The runner strips both anyway, along with any `CLAUDE_CODE_*` variables inherited from a parent Claude Code session.
- Start the server from a normal terminal (or launchd), **not from inside a Claude Code session's sandbox**. A sandbox cannot reach the login keychain, so every agent run would fail with "OAuth session expired".
  This only affects development. In production the server is an ordinary user process (your terminal, or a launchd agent in your login session) with normal keychain access, and that is the setup the runner is designed for.

## Start

```bash
pnpm install
pnpm dev          # runs src/ directly (no build), http://localhost:3141, scheduler on
```

or, compiled:

```bash
pnpm build && pnpm start
```

`pnpm start` builds first, then runs `dist/`. A server started from `dist/` refuses to start when a file in `src/` is newer than its build (`BRAIN_ALLOW_STALE_BUILD=1` skips the check). This guard exists because a stale build fails silently. On 2026-10-23 one dropped a new project field, and another approved four tasks without merging them. A running server still keeps its old code until you restart it.

The server serves `web/dist` at `/` when it exists. Otherwise `/` shows a short notice; the web dev server (`web/`, port 5173) proxies `/api` here. Stop it with Ctrl-C: running sessions are cancelled and their tasks park as `blocked`.

`pnpm test` runs the suite (state machine, knowledge index, stream parser, hook, and the orchestrator against a fake `claude`).

### Configuration (env, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `BRAIN_DIR` | `./brain` | knowledge, project folders, run logs, `state.sqlite` |
| `BRAIN_PORT` | `3141` | HTTP port (binds 127.0.0.1) |
| `BRAIN_CONCURRENCY` | `2` | max Claude sessions at once (subscription rate limits) |
| `BRAIN_TICK_MS` | `10000` | scheduler interval |
| `BRAIN_MAX_TURNS` | `60` | `--max-turns` per run |
| `BRAIN_RUN_TIMEOUT_MIN` | `30` | wall-clock limit per run |
| `BRAIN_MAX_QUESTIONS` | `5` | questions per task before it parks as `blocked` |
| `BRAIN_CLAUDE_BIN` | `claude` | CLI to spawn (tests point this at `tests/fake-claude.mjs`) |
| `BRAIN_SETTING_SOURCES` | `project,local` | Claude settings sources for agent runs; your user settings (hooks, plugins) are left out so runs are predictable |
| `BRAIN_WORKTREES_DIR` | `~/.secondbrain/worktrees` | one git worktree per task: `<dir>/<project>/<task-id>` |
| `BRAIN_MAX_VERIFY_FIXES` | `2` | failed `verify_command` → the agent gets the output and fixes, this many times in a row |
| `BRAIN_VERIFY_TIMEOUT_MIN` | `15` | limit for one `verify_command` run |
| `BRAIN_PLAN_COOLDOWN_HOURS` | `6` | `auto_plan`: minimum gap between planner tasks of a project |

## The `brain` CLI

Run it as `pnpm brain …`, or `pnpm link --global` once and then just `brain …`. It reads `BRAIN_DIR` like the server. Commands that start or resume a session (`task start`, `task answer`, `task request-changes`, `task cancel`) go through the server when it is up; without a server they run the session in the foreground.

### Add a project

```bash
brain project add shop -n "Shop backend" -r /Users/me/Projects/shop          # code project (git repo)
brain project add reading -n "Reading list"                                    # no repo: agent works in brain/projects/reading/
brain project add shop2 -n "Shop 2" -r /path --model sonnet -t "Bash(pnpm test *)"
brain project list
```

This creates `brain/projects/<slug>/PROJECT.md` (fill in goal and constraints, or let the planner do it; every session of that project sees it) and `knowledge/`.

Settings for large projects:

```bash
brain project set shop --verify "pnpm -s check && pnpm -s test"   # run before review; failures go back to the agent
brain project set shop --setup "pnpm install --frozen-lockfile && cp \"\$BRAIN_REPO/.env\" ."   # how to prepare a fresh worktree
brain project set shop --parallel 3                                # tasks running at once, each in its own worktree
brain project set shop --auto-plan on                              # plan by itself when the board runs dry
brain project plan shop "customer management first"                # planner: PROJECT.md, milestones, next tasks into the inbox
brain milestone add shop "Backoffice v1" -d "Staff can find and edit customers" --due 2026-11-30
brain milestone list shop
brain task add shop "Customer search" -M "Backoffice v1"
brain task milestone <id> "Backoffice v1"
brain overview                                                     # every project: progress, questions, cost
brain group add shop shop-api shop-web -n "Shop"                   # backend + frontend as one product
brain project set shop-web --group shop                            # or move one project in ("" removes it)
brain task list -G shop                                            # tasks of every project in the group
```

Groups: agents of a grouped project read GROUP.md (`brain/groups/<slug>/GROUP.md`, describe the product and how its parts talk there) and the group knowledge, can read the other projects' repos (writes there are blocked), and can file tasks on them (into the inbox). See [09-project-groups.md](09-project-groups.md). Optional per project: `CLAUDE.md` (extra agent instructions) and `mcp.json` (`{ "mcpServers": { … } }`, merged over `brain/mcp/global.json`).

### Add a task

```bash
brain task add shop "Add a health-check endpoint" --todo            # todo: the scheduler picks it up
brain task add shop "Redesign checkout" -b "Talk to me first"   # inbox: waits for you (move to todo or `brain task start`)
echo "long description" | brain task add shop "Title" -b - -p 3     # body from stdin, high priority
brain task list                     # newest first; -P <project> -s todo,review
brain task show <id>                # status, open question, summary, runs with log paths
brain task start <id>               # start now (from inbox/todo/blocked/failed)
```

Without `--todo` a task lands in `inbox` and is not started.

### Answer a question

When an agent needs you, its task goes to `waiting_for_human`:

```bash
brain questions                     # all open questions with their options
brain task answer <task-id> 2       # a number picks that option…
brain task answer <task-id> "blue, but darker"   # …anything else is free text
brain task answer <task-id> "1,3"   # multi-select
brain task answer <task-id> red large   # one answer per sub-question when it asked several
```

The session resumes right away (or on the next scheduler tick) and the agent gets your answer as the tool result.

### Review

```bash
brain task show <id>                          # summary of what the agent did
git -C <repo> log main..brain/<id>-…          # or GET /api/tasks/<id>/diff
brain task approve <id>                       # squash-merge the branch into its base → done (+ push if the project says so)
brain task push <id>                          # push the base branch an approved task was merged into
brain task merge <id>                         # merge a done task whose branch never reached its base
brain task request-changes <id> "Also add a test"   # resumes the same session with your note
brain task cancel <id>                        # stop and park as blocked
```

### Dependencies

```bash
brain task add <project> "Customer list" --after t_abc,t_def   # waits until both are approved and merged
brain task deps <id> t_abc                                      # replace the list (no ids clears it)
```

A task with unmet dependencies stays in todo, marked "⏳ waiting on" on the board. Start is disabled until each dependency is approved and merged. Follow-ups an agent creates depend on the agent's task by default. A done task that shows "⑂ not merged" holds its dependents back: use "Merge into base" in its drawer, or `brain task merge <id>`.

Approve squash-merges `brain/<id>-…` into the branch it was cut from (usually `main`) without checking anything out; if you have that branch checked out it is fast-forwarded, which only fails when your uncommitted changes touch the same files. A conflict leaves the task in review with the files listed in its activity: request changes ("merge main and resolve the conflicts"); the agent can do it now. Push is per project: `brain project add … --push after_merge` or `brain project set-push <slug> after_merge|never` (default `never`); it pushes the base branch to its configured upstream.

### Schedules

```bash
brain schedule add life "Did the transfer arrive?" --at "2026-11-01 09:00" -b "Check the bank page and report."   # one-off
brain schedule add shop "Error log check" --cron "0 9 * * 1" -b "Read last week's errors and report new ones."      # every Monday 09:00
brain schedule list [-P shop]
brain schedule run <id>         # queue its task now (the schedule keeps its next run)
brain schedule off <id> / on <id> / rm <id>
```

A schedule is a task template plus a time. When it is due the scheduler creates a `todo` task from it; it runs by itself and lands in review with the agent's report, so checks show up in the Inbox. One-offs turn themselves off after firing. Recurring ones use cron in the server's local time (`min hour day month weekday`, or `@daily`/`@weekly`/…), skip a time while the previous task is still queued or running, and get the previous run's result in their prompt. Missed times while the server was down are caught up with one task. In the web UI: **Schedules** page (friendly repeat picker, or custom cron with a preview of the next runs). For checks that don't touch code, a project without a repo works fine.

### Knowledge

```bash
brain knowledge add global "Commit style" -c "Preferred commit style: conventional commits."
brain knowledge add project:shop "Payments" < notes.md
brain knowledge search commit style [-s global|project:shop]
```

Notes are plain Markdown under `brain/knowledge/` and `brain/projects/<slug>/knowledge/`. Edit them in any editor; the search index re-syncs from file mtimes on every search. `brain/knowledge/index.md` is injected into every session, so keep it a short map.

### Debugging

```bash
brain run <id>                  # run one task in the foreground, no server needed
brain task log <id>             # readable digest of the last run (--raw for stream-json, -r <run-id>)
pnpm spike                      # check that hook defer/resume works with your CLI version (2 tiny haiku runs)
```

### End-to-end check

```bash
pnpm verify                     # plan verification steps 2-7 with real claude -p runs (~5 small sessions)
pnpm verify -- --keep           # keep the scratch dir (repo, BRAIN_DIR, logs) for inspection
BRAIN_CLAUDE_BIN=$PWD/tests/fake-claude.mjs pnpm verify    # dry run of the harness, no Claude usage
```

`scripts/verify-e2e.mjs` creates a throwaway git repo (with a local bare `origin`, so a push that slipped through would show up) and a throwaway `BRAIN_DIR`, and starts its own server on port 3199. It drives the server with the CLI and the API and prints PASS/FAIL per step: auto task to review to done, question to answer to resume, knowledge-guided commit style, `git push` blocked, max turns to `failed` with a readable log, then `pnpm test`. It refuses to start if `claude auth status` is not logged in.

## From any Claude session: the `secondbrain` MCP server

`src/mcp/owner.ts` gives your own interactive Claude sessions (desktop app, terminal, IDE) the same powers as the CLI, as `mcp__secondbrain__*` tools. Register it once at user scope so every project gets it:

```bash
claude mcp add -s user secondbrain -- /opt/homebrew/bin/node --disable-warning=ExperimentalWarning /path/to/SecondBrain/src/mcp/owner.ts
```

(Registered on the owner's Mac on 2026-10-23. Use an absolute Node 25 path: MCP servers do not get nvm's PATH. Open a new session after adding it.)

Tools: `overview` (start here), `list_projects`, `add_project`, `list_tasks`, `get_task`, `add_task`, `update_task`, `start_task`, `cancel_task`, `list_questions`, `answer_question`, `task_diff`, `task_log`, `approve_task`, `push_task`, `request_changes`, `list_schedules`, `add_schedule`, `update_schedule`, `delete_schedule`, `run_schedule`, `search_knowledge`, `read_note`, `save_note`. So from any session: "every Monday at 9 check X" → `add_schedule` with a cron; the tool descriptions carry the server's time zone.

- The current project is the one whose `repo_path` (or `brain/projects/<slug>/`) contains the session's working directory. `add_task` and `save_note` default to it, and `list_tasks` takes `project: "current"`.
- `start_task`, `cancel_task`, `answer_question` and `request_changes` go through the running server (`pnpm dev`). When the server is down they return an error with the start command. Everything else works without the server.
- `approve_task` merges, and pushes when the project's push policy is `after_merge`. Claude Code asks before each MCP tool call unless you allow it.
- Agent sessions never see this server: they run with `--strict-mcp-config`.
- Optional env: `BRAIN_DIR`, `BRAIN_PORT` as for the server. `BRAIN_CWD` overrides the working directory used to find the current project.

## Compose tasks by chatting

Web UI → **Compose** (or "💬 Compose with Claude" on the Board). Pick the project, describe what you want, and Claude
(read-only: it reads the repo, PROJECT.md and the board) asks what is unclear and proposes draft tasks next to the chat.
Edit or discard drafts, or ask for changes in the chat, then **Create** them one by one or with **Create all**. They
always go to the inbox. In a group, Claude can also propose tasks for the other projects of the group (shown with a 🧩 chip). Each reply is a `claude -p` turn on your subscription; logs are in
`brain/runs/composer/<chat-id>.jsonl`. Details: docs/08-task-composer.md.

## How a task flows

0. A due schedule (see "Schedules") creates a `todo` task from its template.
1. `todo` + `auto` → the scheduler (every 10 s) starts it, at most `BRAIN_CONCURRENCY` sessions overall and the project's `max_parallel` (default 1) per project.
2. For a repo project the runner creates `brain/<task-id>-<slug>` from your current branch (or from the base of the brain branch you are on) and checks it out in the task's own worktree under `BRAIN_WORKTREES_DIR`; your checkout is not touched. If the base moved on since the branch was cut, the branch is fast-forwarded or the base is merged in (a conflict is left to the agent, with instructions). Then `claude -p` runs in the worktree with the task, its milestone, `PROJECT.md`, the knowledge index and the conversation so far.
3. The agent asks you with `mcp__brain__ask_human`. The brain PreToolUse hook answers `defer`, so the run exits with `stop_reason: tool_deferred`. The question is stored and the task becomes `waiting_for_human`.
4. You answer. The runner runs `claude -p --resume <session>`, the hook now answers `allow` with your answers in `updatedInput`, the tool returns them to the model, and the task is back to `in_progress`.
5. A clean finish runs the project's `verify_command` (if any) in the worktree. Failing checks go back to the same session with the output (up to 2 times); then, or right away when they pass, the task is in `review` with the agent's final summary and a checks badge. Max turns, timeouts and errors put it in `failed`.
6. Approve squash-merges the branch and removes the worktree.

Guardrails: agents run with full permissions (`bypassPermissions`): any command, including installs, tests, builds and git merge/rebase/reset in their worktree. Only `git push` is denied (`--disallowedTools` and the hook); pushing happens in the server after you approve, per `push_policy`. Your user-level Claude settings, hooks and plugins don't load in agent runs.

A task whose branch was cut before the work it needs landed: press "Update from base" in its drawer, or `brain task sync <id>` (a start does it too).

## Where things live

| What | Where |
|---|---|
| State (projects, tasks, questions, runs, events) | `brain/state.sqlite` (WAL; gitignored) |
| Raw run logs (stream-json, one line per event; stderr appended as a `brain_stderr` line) | `brain/runs/<task-id>/<run-id>.jsonl` (gitignored); also `GET /api/runs/:id/log` and `brain task log` |
| Knowledge | `brain/knowledge/**.md`, `brain/groups/<slug>/knowledge/**.md`, `brain/projects/<slug>/knowledge/**.md` |
| Project context | `brain/projects/<slug>/PROJECT.md`, `CLAUDE.md`, `mcp.json` |
| Group context | `brain/groups/<slug>/GROUP.md` |
| Global MCP servers | `brain/mcp/global.json` |
| Task worktrees | `~/.secondbrain/worktrees/<project>/<task-id>` (`BRAIN_WORKTREES_DIR`), removed when the task is done |
| Per-run Claude config (merged MCP config, hook settings) | a temp dir `$TMPDIR/brain-<task-id>-*`, deleted when the run ends |
| Claude's own session transcripts | `~/.claude/projects/…` (managed by the CLI; used by `--resume`) |
| Server log | stdout of `pnpm dev` |

## Verification status (2026-10-19)

- Verified against a fake `claude` (`tests/fake-claude.mjs`, which runs the real hook and speaks stream-json), through the real server, CLI and curl, and with `pnpm verify` in dry-run mode (8/8): auto task → `brain/<id>-…` branch with a commit → `review` → approve → `done`; question → `waiting_for_human` → `brain task answer` → resume → `review`; request changes; max turns → `failed` with the log readable; `git push` denied by the hook; SSE relay of CLI changes; knowledge search.
- Verified against the real CLI 2.1.296: the spawned session starts with the brain MCP server connected and the tool set restricted; auth errors land in `failed` with a readable summary; `AskUserQuestion` is not offered in `-p` mode.
- **Verified against the real CLI 2.1.296 with the owner's subscription login (2026-10-19, from a normal terminal):** `pnpm spike` confirmed that the PreToolUse hook pauses the run on `mcp__brain__ask_human` (`stop_reason: tool_deferred`) and that `--resume` delivers the answer as the tool result (fixtures in `tests/fixtures/ask-human-run*.jsonl`). `pnpm verify` passed 8/8 with real sessions: auto task to review to done, question to answer to resume, knowledge-guided commit style, `git push` blocked, max turns to `failed` with a readable log, `pnpm test`.
- The CLI must be logged in on this Mac (`claude auth status` shows `"loggedIn": true`). The desktop app's own sign-in does not count; run `claude` and `/login` once if it says `loggedIn: false`.
