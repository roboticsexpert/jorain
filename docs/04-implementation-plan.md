# Second Brain – Phase 1 & 2 implementation plan

## Context

The owner wants a personal "second brain". Scope for now, in order:

1. **Task manager + knowledge base** – projects, a simple board, global and per-project knowledge in Markdown.
2. **Agents that pick up tasks** – Claude works through tasks on its own, parks a task and asks the owner whenever it needs a decision, and hands finished work back for review.

Chat channels (Telegram / WhatsApp / iMessage) come later and are out of scope here; the design keeps a seam for them.

Decisions already made with the owner (2026-10-19):

| Decision | Value |
|---|---|
| Claude access | **Claude Code CLI with the owner's subscription login** (`claude -p`, headless). No API key. |
| Surface for step 1 | **Local web app**: board, questions inbox, knowledge browser. |
| Autonomy | Agents may **edit and commit on a task branch**, never push / merge / deploy. |
| UX language | English (code, docs, agent messages). |
| Stack | TypeScript / Node 25, pnpm (owner's other projects are Node/TS). |

The project folder is empty apart from `docs/` (vision, architecture proposal, decisions). It is not a git repo yet.

## Architecture (what gets built)

```
 web UI (Vite+React)  ──HTTP/SSE──►  server (Hono)  ──►  SQLite (node:sqlite)  state: projects, tasks, questions, runs
                                        │                 brain/   files: knowledge (md), project config
                                        ▼
                                   scheduler ──spawns──► `claude -p` (headless, owner's login)
                                                              │ MCP (stdio): brain tools
                                                              ▼
                                                      ask_human · search_knowledge · save_knowledge · create_task · finish_task
```

One Node process (`server`) hosts the HTTP API, serves the built UI, and runs the scheduler loop. A second entry point (`brain-mcp`) is the stdio MCP server that each Claude session gets. A `brain` CLI covers admin and scripting.

### Data

**SQLite** (`brain/state.sqlite`, via the built-in `node:sqlite`, plain SQL migrations in `src/db/migrations/*.sql`):

- `projects` – `slug`, `name`, `repo_path?`, `default_mode`, `allowed_tools` (JSON), `status`.
- `tasks` – `id`, `project_slug`, `title`, `body`, `mode` (`auto`|`assisted`), `status`, `priority`, `branch?`, `session_id?`, `result_summary?`, timestamps.
  Status machine: `inbox → todo → in_progress → waiting_for_human → in_progress → review → done`, plus `blocked`, `failed`.
- `questions` – `id`, `task_id`, `text`, `options` (JSON, optional), `answer?`, `asked_at`, `answered_at`.
- `runs` – one row per `claude -p` invocation: `task_id`, `session_id`, `started_at`, `ended_at`, `exit_code`, `cost/usage` from the final stream event, `log_path`.
- `events` – append-only audit log (task state changes, answers) used for the UI activity feed.
- `knowledge_fts` – FTS5 index of the Markdown files (rebuilt on change) for `search_knowledge`. Fallback to substring scan if FTS5 is unavailable in Node's SQLite build (check at startup).

**Files** (`brain/`, path configurable with `BRAIN_DIR`):

```
brain/
  knowledge/            global notes, *.md with YAML frontmatter (title, tags, updated)
    index.md            short map; injected into every session
  projects/<slug>/
    PROJECT.md          goal, constraints, links; injected into sessions of that project
    CLAUDE.md           extra instructions for the agent (optional)
    mcp.json            project MCP servers (optional)
    knowledge/*.md      project notes
  mcp/global.json       MCP servers for every project (optional)
  runs/<task-id>/<run-id>.jsonl   raw stream-json of each session (gitignored)
  state.sqlite          (gitignored)
```

Knowledge stays in Markdown so the owner can edit it in any editor; the DB only indexes it.

### Runner (how a task becomes a Claude session)

Verified against the Claude Code docs (headless, hooks, CLI reference) for the installed CLI (v2.1.296):

- Headless `claude -p` uses the `/login` subscription when no `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is set. The runner spawns with those two variables stripped from the env, and never uses `--bare` (it skips OAuth).
- `--session-id <uuid>` lets us choose the session id up front; `--resume <id>` continues it later from any directory.
- Hooks run in `-p` mode. A `PreToolUse` hook may answer `permissionDecision: "defer"`: the run exits with `stop_reason: "tool_deferred"` plus `deferred_tool_use` (name, id, input). On `--resume` the same tool fires `PreToolUse` again and the hook answers `allow` with `updatedInput`. This is documented "for integrations that run `claude -p` as a subprocess" and needs v2.1.246+. It only works when that turn has a single tool call.

Flow:

1. **Scheduler loop** (every 10 s): pick the highest-priority `todo` task with `mode = auto` whose project has no running task and while global concurrency (default 2) allows. `assisted` tasks start only when the owner presses **Start** in the UI. _(Superseded 2026-10-24: modes were removed; every `todo` task is runnable, see D20.)_
2. **Prepare**: if the project has `repo_path`, create/checkout branch `brain/<task-id>-<slug>` from the current HEAD (refuse to start if the working tree is dirty). Write to a per-run temp dir: a merged MCP config (`brain/mcp/global.json` + project `mcp.json` + the `brain` MCP server with `BRAIN_TASK_ID`, `BRAIN_DIR` in its env) and a settings file that registers the brain `PreToolUse` hook.
3. **Spawn** `claude -p <prompt>` in the project directory with: `--session-id <uuid>`, `--output-format stream-json --verbose`, `--mcp-config <file> --strict-mcp-config`, `--settings <file>`, `--permission-mode acceptEdits`, `--permission-prompts none`, `--allowedTools` from the project config (default: Read, Edit, Write, Glob, Grep, AskUserQuestion, `Bash(git add:*)`, `Bash(git commit:*)`, `Bash(git status:*)`, `Bash(git diff:*)`, `Bash(git log:*)`, `mcp__brain__*`), `--disallowedTools "Bash(git push:*)" "Bash(git merge:*)"`, `--append-system-prompt` (brain rules: ask with `AskUserQuestion` whenever a decision is the owner's, commit your work on the current branch, end with a short summary), `--max-turns`, `--model` from project config.
4. **Prompt** = task title + body + `PROJECT.md` + `knowledge/index.md` + the answer/feedback thread so far.
5. **Stream**: parse stream-json lines; append every line to `brain/runs/<task>/<run>.jsonl`; publish progress to the UI over SSE; the final `result` line gives usage and `stop_reason`.
6. **Asking the owner = `AskUserQuestion` + hook defer.** The brain hook (`src/hooks/pretooluse.ts`, invoked by the settings file) sees `AskUserQuestion`; if no stored answer exists for that `tool_use_id` it returns `defer`. The run exits with `tool_deferred`; the runner stores the question(s) and options from `deferred_tool_use.input` in `questions`, sets the task to `waiting_for_human`, and notifies the UI.
7. **Answer** (UI or CLI): store the answer keyed by `tool_use_id`, then `claude -p --resume <session_id>` with the same flags. The hook fires again, finds the answer, returns `allow` with `updatedInput` carrying the `answers` → the model receives it as the tool result → task back to `in_progress`.
   Fallback if an MCP/other tool ever needs the same treatment: the identical hook path works for any single tool call, so an `mcp__brain__ask_human` tool can be added later without changing the orchestrator.
8. **Done**: clean exit with `stop_reason: end_turn` → `review`; the UI shows the final summary text and, if a repo, the branch's commits and diff. **Approve** → `done`. **Request changes** (with a note) → `--resume` with the note. Non-zero exit / `max_turns` / `error_*` → `failed` with the log visible.
9. Limits per run: wall-clock timeout (default 30 min), `--max-turns` (default 60), max 5 questions per task before it parks itself as `blocked`.

Brain MCP tools (stdio server, `@modelcontextprotocol/sdk`): `search_knowledge(query, scope)`, `save_knowledge(scope, title, content)`, `create_task(project, title, body, mode)`, `get_task_context()`. No `ask_human`/`finish_task` tools in v1 – the hook path and the final summary cover both.

### Web app

Vite + React + TypeScript in `web/`, built to `web/dist`, served by the Hono server; dev mode proxies. Pages:

- **Board** – columns per status, per-project filter, task card → detail drawer (body, run log tail, commits, actions: start, approve, request changes, cancel, change mode/priority).
- **Inbox** – open questions and tasks in review, newest first; answer with free text or one of the offered options.
- **Knowledge** – tree of global/project notes, Markdown view/edit, search.
- **Projects** – list, create/edit (`repo_path`, allowed tools, model), per-project MCP config view.

Live updates via a single SSE endpoint (`/api/events`).

### CLI (`brain`)

`brain project add|list`, `brain task add|list|start|answer|approve`, `brain knowledge add|search`, `brain run <task-id>` (run one task in the foreground, for debugging). Thin wrappers over the same core modules the server uses.

## File layout

```
SecondBrain/
  package.json  tsconfig.json  pnpm-workspace.yaml? (no: single package)  .gitignore  .env.example
  src/
    config.ts                  BRAIN_DIR, port, concurrency, defaults
    db/  client.ts  migrate.ts  migrations/0001_init.sql
    core/  projects.ts  tasks.ts  questions.ts  knowledge.ts  events.ts  (pure functions over the DB + files)
    runner/  claude.ts (spawn + stream parse)  scheduler.ts  git.ts  prompt.ts  mcp-config.ts
    mcp/  server.ts            stdio MCP server exposing the brain tools (uses @modelcontextprotocol/sdk)
    hooks/  pretooluse.ts      PreToolUse hook: defer AskUserQuestion / allow with stored answer
    server/  app.ts  routes/{projects,tasks,questions,knowledge,runs}.ts  sse.ts
    cli/  index.ts
  web/  (Vite React app)
  brain/  knowledge/index.md  mcp/global.json  projects/.gitkeep
  docs/  (existing; updated at the end)
```

## Implementation steps

1. **Scaffold** – `git init`, package.json (tsx, typescript, hono, @modelcontextprotocol/sdk, zod, commander, vitest), tsconfig, `.gitignore`, `.env.example`, `brain/` skeleton.
2. **DB + core** – migrations, DB client, core modules with the state machine and validation, knowledge file read/write + FTS index. Unit tests for the state machine and knowledge indexing.
3. **CLI** – the commands above (gives a way to test before the UI exists).
4. **Runner** – spike the hook-defer round trip first (see Risks), then `claude.ts` (spawn with stripped env, stream-json parsing, log writing, `tool_deferred` handling), `hooks/pretooluse.ts`, `git.ts` (branch prep, dirty check, commit listing), `mcp-config.ts`, `settings.ts`, `prompt.ts`, `scheduler.ts`.
5. **Brain MCP server** – `search_knowledge`, `save_knowledge`, `create_task`, `get_task_context`; talks to the same SQLite file and `brain/` dir.
6. **Server** – Hono API + SSE + static serving; scheduler started with the server.
7. **Web UI** – Board, Inbox, Knowledge, Projects.
8. **Docs** – update `docs/02-architecture.md` to "as built", record decisions in `docs/03-decisions.md`, add `docs/04-running.md` (how to start, how a task flows, how to add a project). Optional launchd plist in `ops/`.

Steps 4–5 (runner + MCP) and 7 (web UI) are independent of each other once steps 1–3 exist.

## Risks and how the plan handles them

- **Hook `defer` with `AskUserQuestion` in `-p` mode is documented but not yet exercised here.** Step 4 starts with a 20-line spike script that runs `claude -p` with the hook, confirms `tool_deferred` + resume works, and records the exact JSON shapes as a test fixture. If it fails on this version, fall back to an `mcp__brain__ask_human` tool that records the question and instructs the model to stop; the orchestrator is the same either way.
- **Subscription rate limits** apply to every session the scheduler starts. Global concurrency defaults to 2 and is a config value; the UI shows usage from each run's `result` event.
- **Agent runs inside real repos.** Dirty-tree refusal, dedicated `brain/*` branch per task, and `git push`/`git merge` disallowed keep it reversible.
- **Node's bundled SQLite may lack FTS5.** Checked at startup; falls back to a substring scan over the indexed text.

## Verification (end to end)

1. `pnpm install && pnpm dev` → server on `http://localhost:3141`, UI loads, board empty.
2. Create a throwaway git repo in the scratchpad, register it as project `selftest`.
3. **Auto task**: "Add a line 'hello from brain' to README.md and commit." → scheduler starts it, a `brain/<id>-...` branch appears with one commit, task lands in `review` with a summary, Approve → `done`.
4. **Human-in-the-loop**: "Ask me which colour to use, then write it into colour.txt and commit." → task goes to `waiting_for_human`, the question shows in Inbox, answer "blue" → session resumes, file contains blue, task → `review`.
5. **Knowledge**: add a global note "Preferred commit style: conventional commits"; task "Check the knowledge base for the preferred commit style and use it." → agent calls `search_knowledge`, commit message follows the convention.
6. **Guardrails**: a task that tries `git push` is blocked by `--disallowedTools`; a task exceeding max turns ends `failed` with logs visible.
7. `pnpm test` passes (state machine, knowledge index, stream parser on a recorded fixture).
