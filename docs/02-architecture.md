# Architecture (v1, 2026-10-19)

Status: phases 1–2 of [04-implementation-plan.md](04-implementation-plan.md) are built (backend; the web UI is built separately in `web/`). The section **As built** below is authoritative. The original proposal follows it unchanged for context, and the as-built notes say where the build differs. How to run it: [04-running.md](04-running.md).

## As built

```
 web UI (web/, Vite+React) ──HTTP/SSE──► server (Hono, src/server) ──► SQLite brain/state.sqlite (node:sqlite, WAL)
 brain CLI (src/cli) ─────────── same core modules (src/core) ──────► brain/ files: knowledge md, PROJECT.md, mcp.json
 owner MCP server (src/mcp/owner.ts) ─ same core modules; session actions via the HTTP API (the owner's own Claude sessions, any project)
                                         │
                       scheduler + orchestrator (src/runner)
                                         │ spawns, one per active task
                                         ▼
                 claude -p  (owner's subscription login, stream-json)
                   ├─ --settings → PreToolUse hook (src/hooks/pretooluse.ts): defer/allow ask_human, deny git push/merge/rebase
                   │   (merge + push happen in the server on the owner's approve: src/runner/deliver.ts)
                   └─ --mcp-config → global + project MCP servers + brain MCP server (src/mcp/server.ts, stdio)
                                         ask_human · search_knowledge · save_knowledge · create_task · get_task_context
```

Where the build differs from the proposal below:

| Proposal | As built | Why |
|---|---|---|
| Claude Agent SDK `query()` in-process | Headless Claude Code CLI (`claude -p --output-format stream-json`), one child process per run | Uses the owner's subscription login; no API key (decided with the owner). |
| `ask_human` tool that stops the session | `mcp__brain__ask_human` (brain MCP server) + PreToolUse hook `defer` → run exits `tool_deferred` → answer → `claude -p --resume` with the hook returning `allow` + `updatedInput.answers` | The plan wanted `AskUserQuestion` + defer, but CLI 2.1.296 does not offer `AskUserQuestion` in `-p` mode at all (it is missing from the init tool list even when named in `--tools`). This is the plan's documented fallback. If the hook ever fails to pause the run, the tool records the question itself and tells the model to end its turn; the runner then parks the task the same way and resumes with the answer as the prompt. |
| better-sqlite3 | built-in `node:sqlite` | No native build; FTS5 is available in Node 25's SQLite (checked at startup, substring fallback otherwise). |
| `mcp/global.mcp.json`, project `.mcp.json` | `brain/mcp/global.json`, `brain/projects/<slug>/mcp.json` | As in the implementation plan. |
| Gateway + router + Telegram | Not built yet | Out of scope for phases 1–2; the CLI and web UI are the surface. |
| Separate orchestrator daemon | Scheduler runs inside the server process; `brain run` can run a task in the foreground | One process is enough on one Mac. Runs record their owner pid so a restart can tell orphaned runs from live CLI runs. |

Details of the build:

- **State machine** (`src/core/tasks.ts`): `inbox → todo → in_progress → waiting_for_human → in_progress → review → done`, plus `blocked` (cancelled, too many questions) and `failed` (error, max turns, timeout, interrupted). Manual status edits are limited to `inbox`/`todo`/`blocked` and `review → done`.
- **Delivery** (`src/runner/deliver.ts`): commit → merge → push. Agents commit on the task branch; leftovers are committed by the runner after each run (`commit_count` is refreshed then). Approve squash-merges the branch into its base with `git merge-tree` + `git commit-tree` and a compare-and-swap `update-ref` (or a fast-forward when the base is checked out), so a merge never disturbs a running agent's checkout. Then, if the project's `push_policy` is `after_merge`, the base branch is pushed to its upstream; a push failure is stored on the task, not rolled back. Board cards show a git badge (commits · merged · pushed / push failed).
- **Git and worktrees** (`src/runner/workspace.ts`, since 2026-10-23): branch `brain/<task-id>-<slug>` from the owner's current branch (or from the base of the `brain/*` branch checked out, so tasks don't stack), created without a checkout, and checked out in a per-task worktree `BRAIN_WORKTREES_DIR/<project>/<task-id>` (default `~/.secondbrain/worktrees`, outside every repo so no stray CLAUDE.md is loaded). The owner's checkout is never switched; its uncommitted changes block nothing. Up to `max_parallel` tasks per project run at once. The worktree is removed when the task is done; the branch stays. Base sha stored per task for commits and diff.
- **Sync with base**: before a start (and on `POST /tasks/:id/sync`) the branch is fast-forwarded to its base when it has no own commits, else the base is merged in inside the worktree; `base_sha` moves to the base tip so commits/diff show only the task's own work. A conflict changes nothing and the agent's prompt starts with "merge and resolve". Resume after an answer only fast-forwards.
- **Verification**: a project's `verify_command` runs in the worktree after a work task's run ends normally; failures go back to the same session (`BRAIN_MAX_VERIFY_FIXES`, default 2), then the task goes to review marked `verify_status: failed`.
- **Milestones and planner**: `milestones` table, `tasks.milestone_id`. Planner tasks (`kind = 'plan'`) get a different prompt (`planPrompt` in `src/runner/prompt.ts`) and use the brain tools `update_project_doc`, `create_milestone`, `project_board`, `create_task`. `auto_plan` projects get one from the scheduler when they run out of open work (cooldown `BRAIN_PLAN_COOLDOWN_HOURS`). `GET /api/portfolio` (`src/core/portfolio.ts`) sums progress, questions and cost per project.
- **Agent permissions** (since 2026-10-23): `--permission-mode bypassPermissions --permission-prompts none`, `--tools` = Read, Edit, Write, Glob, Grep, Bash, NotebookEdit, WebSearch, WebFetch, Task, TodoWrite, Skill, ToolSearch, AskUserQuestion (+ names from project `allowed_tools`), `--disallowedTools` for `git push` only (the hook denies push in any Bash command as well), `--setting-sources project,local` (the owner's user-level hooks and plugins don't run in agent sessions), `--strict-mcp-config`. Before: acceptEdits with only git add/commit/status/diff/log allowed, which left agents unable to test, build, or merge (see 06-scaling-roadmap.md).
- **Environment**: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*` are stripped, plus `ANTHROPIC_BASE_URL` when the parent is a Claude Code session. A parent Claude Code session's variables (e.g. `CLAUDE_CODE_SIMPLE=1`) otherwise break the child's login.
- **Schedules** (since 2026-10-23, `src/core/schedules.ts`, `src/core/cron.ts`): `schedules` table of task templates with `kind` `once` (`run_at`) or `recurring` (5-field cron, server local time, own parser, no dependency). Each scheduler tick `fireDue` creates a `todo` task (`tasks.schedule_id`) for each due schedule, then moves `next_run_at` (one-offs turn off). One catch-up task for missed times; a recurring time is skipped while the previous task is queued or running; the previous `result_summary` goes into the next prompt. Surfaces: Schedules page, `/api/schedules`, `brain schedule`, owner MCP `*_schedule` tools.
- **Live updates**: an in-process event bus feeds SSE, and the server polls the `events` table so changes from other processes (CLI, the agents' MCP servers) also reach the UI.
- **Knowledge**: Markdown files are the source of truth. `knowledge_docs` + `knowledge_fts` mirror them and re-sync from file mtimes before each search or listing.

---

# Original proposal (2026-10-19)

## Guiding ideas

1. **Files are the source of truth for knowledge; a small database is the source of truth for state.**
   Knowledge (global + per project) lives as Markdown on disk so Claude reads it natively, it is git-diffable and Obsidian-compatible. Tasks, pending questions and session bookkeeping live in SQLite because they are a state machine that gets queried and updated concurrently.
2. **The chat channels are thin.** One gateway normalizes Telegram / WhatsApp / iMessage into `inbound message` and `send reply`. Nothing channel-specific leaks past it.
3. **Human-in-the-loop is a first-class task state, not an interrupt.** A running Claude session asks a question via a tool; the task flips to `waiting_for_human`; the question is delivered on a channel; the session is suspended; when the reply arrives the session is **resumed** with that answer. Nothing blocks a thread waiting for a person.
4. **Start with the hardest loop end-to-end** (message in → task → Claude session → question out → answer in → session resumes → done) before adding channels or polish.

## Components

```
                ┌──────────────┐
 Telegram ───►  │              │  ◄─── iMessage (BlueBubbles / chat.db)
 WhatsApp ───►  │   Gateway    │
                │ (normalize)  │
                └──────┬───────┘
                       │ inbound / outbound events
                ┌──────▼───────┐        ┌─────────────────┐
                │    Router    │ ─────► │  SQLite (state)  │
                │ (classify &  │        │ tasks, questions │
                │  dispatch)   │ ◄───── │ sessions, log    │
                └──────┬───────┘        └─────────────────┘
                       │
                ┌──────▼───────┐        ┌─────────────────┐
                │  Orchestrator│ ─────► │  brain/ (files)  │
                │ picks tasks, │        │ knowledge, proj. │
                │ runs Claude  │ ◄───── │ CLAUDE.md, .mcp  │
                └──────┬───────┘        └─────────────────┘
                       │ Claude Agent SDK session per task
                ┌──────▼───────┐
                │ Claude agent │  tools: built-ins + global MCP + project MCP
                │ + ask_human  │        + brain tools (search_knowledge, save_note, ask_human)
                └──────────────┘
```

### 1. Store (`brain/`)

```
brain/
  knowledge/                 # global knowledge, markdown, free structure
    index.md                 # short map of what is where (loaded every session)
  projects/<slug>/
    PROJECT.md               # goal, status, constraints, links to repo(s)
    knowledge/               # project-specific knowledge
    CLAUDE.md                # project instructions for the agent
    .mcp.json                # project MCP servers (merged over global)
  mcp/global.mcp.json        # MCP servers available to every project
  state.sqlite               # tasks, questions, sessions, message log
```

A "project" in Second Brain may point at a code repo elsewhere on disk (`repo:` field in PROJECT.md). Non-code projects just have no repo.

### 2. Gateway

One process, one adapter per channel, common interface:
- `onInbound({channel, senderId, threadId, text, attachments, replyTo})`
- `send({channel, threadId, text, buttons?})`

| Channel | Approach | Notes |
|---|---|---|
| Telegram | Bot API (grammY) | Easiest, has inline buttons for approve / reject. **Start here.** |
| iMessage | BlueBubbles server on the Mac, or read `chat.db` + AppleScript send | Pins the system to an always-on Mac. |
| WhatsApp | Official Cloud API (needs business number) or unofficial web client (ban risk) | Do last; expect friction for a personal number. |

Security: allowlist of sender IDs per channel. Anything else is logged and dropped. This bot can run tools on your machine, so this is non-negotiable.

Alternative worth a look before building: open-source "personal assistant gateway" projects (OpenClaw and similar) already bridge WhatsApp/Telegram/iMessage to an agent. Evaluate once; if the security model is acceptable, reuse the gateway and keep our own orchestrator. (Open question Q1.)

### 3. Router (inbox classifier)

Every inbound message goes through one cheap Claude call (structured output) that decides:

- `answer` → it replies to a pending question (match by thread / quoted message / most recent open question on that channel) → resume that session.
- `task` → create a task: project (or `inbox` if unclear), title (lands in `inbox`).
- `note` → save to global or project knowledge.
- `chat` → one-off conversation with the brain (no task created).
- `command` → `/status`, `/projects`, `/pause <project>`, etc.

If the classifier is unsure about the project it asks back with buttons instead of guessing.

### 4. Task model and state machine

```
status:  inbox → todo → in_progress → waiting_for_human → in_progress → review → done
                                   ↘ blocked (external dependency)
fields:  id, project, title, body, status, priority,
         session_id (for resume), open_question_id, created_at, updated_at,
         result_summary
```

- `inbox`: waits for the owner to read it; nothing starts it.
- `todo`: the orchestrator starts it without asking (as soon as dependencies and capacity allow). It may still end up in `waiting_for_human` if the agent hits something it cannot decide. There is no per-task mode (removed 2026-10-24, see D20).
- `review`: agent finished, you get a summary with ✅ / ❌ / 💬 buttons. ✅ → done. ❌ or 💬 → back to `in_progress` with your note.

Per-project stages come later as a per-project override of this list.

### 5. Orchestrator

A long-running daemon (launchd on the Mac):

1. Pull next runnable task (priority, project concurrency limit = 1 per project to start).
2. Build the session: cwd = project repo or project folder; system context = global `knowledge/index.md` + `PROJECT.md` + project `CLAUDE.md`; MCP = global merged with project; brain tools attached.
3. Run via **Claude Agent SDK** (`query(prompt, options)`), capture the session id.
4. On `ask_human` tool call: persist question, set task to `waiting_for_human`, send on the owner's preferred channel, stop the session.
5. On reply: resume the session with the answer and continue.
6. On completion: write `result_summary`, move to `review`, notify.
7. Hard limits per task: wall-clock, token budget, max questions before it parks itself.

Brain tools exposed to the agent (as an in-process MCP server):
- `ask_human(question, options?)` – the HITL primitive.
- `search_knowledge(query, scope: global|project)` – grep/ripgrep over markdown first; embeddings only if that proves insufficient.
- `save_knowledge(scope, title, content)` – write-back of learnings.
- `create_task(project, title, body)` – agent can spawn follow-ups into inbox.
- `project_status()` – read the board.

### 6. Knowledge retrieval

v1: structure + grep. The agent always sees `knowledge/index.md` and the project's `PROJECT.md`; it searches the rest on demand. Keep files small and titled well; that beats a vector store at this scale. Revisit embeddings only when searching gets slow or misses.

### 7. Engine choice: Agent SDK on the Mac vs Managed Agents

| | Claude Agent SDK (local) | Managed Agents (Anthropic-hosted) |
|---|---|---|
| Where tools run | your Mac, your repos, local MCPs, iMessage DB | Anthropic sandbox; local-only MCPs and iMessage not reachable |
| Scheduling | you run a daemon | built-in scheduled deployments |
| HITL | you implement (ask_human + resume) | tool_confirmation / pause built in |
| Fit for this project | **high** – projects and iMessage are on the Mac | medium – good for cloud-only projects later |

Recommendation: Agent SDK locally for v1. Keep the orchestrator interface narrow so a project could later be run on Managed Agents if it lives entirely in the cloud.

## Suggested stack

- TypeScript / Node (Agent SDK has a TS package; Telegram and BlueBubbles clients are TS-friendly).
- SQLite via better-sqlite3 (or Drizzle on top).
- One repo, three processes: `gateway`, `orchestrator`, `cli` (for local admin: add project, add task, list board).
- Runs on the Mac under launchd. Move gateway + orchestrator to a small server later if iMessage is dropped or proxied.

## Phases

**Phase 1 – the loop (prove it)**
- `brain/` layout, SQLite schema, CLI: create project, add task, show board.
- Orchestrator runs one `auto` task through the Agent SDK with project CLAUDE.md + merged MCP.
- Telegram adapter + allowlist. `ask_human` round trip: question on Telegram → reply → session resumes → task to review → ✅ on Telegram → done.

**Phase 2 – make it a brain**
- Router/classifier for inbound messages (task / note / answer / chat).
- Knowledge tools (search, save), knowledge write-back at end of task.
- Review flow with buttons, `/status` commands, daily digest.
- Per-task limits, retries, logging you can read.

**Phase 3 – reach and shape**
- iMessage adapter, then WhatsApp.
- Per-project custom stages.
- Optional read-only web board.
