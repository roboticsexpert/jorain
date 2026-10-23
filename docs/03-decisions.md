# Decisions and open questions

## Decided

With the owner (2026-10-19), see [04-implementation-plan.md](04-implementation-plan.md):

| # | Decision |
|---|---|
| D1 | Agents run through headless Claude Code (`claude -p`) with the owner's subscription login, never an API key. |
| D2 | First surface: local web app + `brain` CLI. Chat channels later. |
| D3 | Agents may edit and commit on a dedicated task branch; never push, merge or deploy. (Still true for agents; since D6 the server merges and pushes on the owner's approval.) |
| D4 | English for code, docs and agent-facing text. |
| D5 | Stack: TypeScript, Node 25, pnpm, `node:sqlite`, Hono, `@modelcontextprotocol/sdk`. Mac only for v1. |

Commit / merge / push in the task manager (with the owner, 2026-10-19):

| # | Decision |
|---|---|
| D6 | **Merge on Approve.** Approve squash-merges the task branch into its base branch; the server does it, not the agent. A conflict keeps the task in review. |
| D7 | **Push is a per-project setting** (`push_policy`: `never` default, or `after_merge`). Any merged task can also be pushed by hand. |
| D8 | **Squash** merge: one commit per task on the base branch. |
| D9 | **Board shows git state as badges** on the existing columns (commits · merged · pushed); no new statuses. |

Made while building it: a run that leaves uncommitted changes on its branch gets them committed by the runner (`WIP: …`), because a dirty tree would otherwise block every later task in the project. `PATCH status review → done` still exists and closes a task without merging. The task branch is kept after the merge.

Made while building (2026-10-19, backend session); the owner may revisit any of these:

| # | Decision | Reason |
|---|---|---|
| B1 | **Questions go through `mcp__brain__ask_human`, not `AskUserQuestion`.** The PreToolUse hook defers it; resume allows it with `updatedInput.answers`. If defer does not pause the run, the tool records the question and tells the model to stop. | CLI 2.1.296 does not offer `AskUserQuestion` in `-p` mode (checked from the init tool list, with and without `--tools`, clean env, stream-json input). The plan's Risks section names this fallback. `AskUserQuestion` stays handled by the hook in case a later CLI offers it. |
| B2 | Run TypeScript sources directly with Node's type stripping (`.ts` imports + `rewriteRelativeImportExtensions`); no tsx. `pnpm build` (tsc) emits `dist/` for `pnpm start`. | One fewer dependency; the hook and MCP server start faster. |
| B3 | `pnpm dev` does not use `--watch`. | A file-watch restart would kill running agent sessions. |
| B4 | Agent sessions load only `project,local` Claude settings (`BRAIN_SETTING_SOURCES`). | The owner's user-level hooks and plugins (e.g. command rewriters) shouldn't change agent behaviour; the project's own `.claude/settings.json` still applies. |
| B5 | Agents get a fixed built-in tool set (`--tools`), not the CLI default. | The default includes Cron, Workflow, subagents, web tools and others that don't need a permission prompt. Projects add tools via `allowed_tools`. |
| B6 | Strip `CLAUDECODE` / `CLAUDE_CODE_*` / `CLAUDE_AGENT_SDK_*` (and `ANTHROPIC_BASE_URL` when inside a Claude Code session) from the agent env, on top of the two API-key variables. | When started from a Claude Code session, the inherited variables break the child's login. |
| B7 | New task branches start from the current branch, unless it is a `brain/*` branch: then from that task's recorded base. The repo returns to the owner's branch after each run when clean. | Tasks don't stack on each other, and the owner's checkout isn't left on an agent branch. |
| B8 | Projects whose repo has uncommitted changes are skipped by the scheduler (logged once), not failed. A manual start gets 409. | A dirty tree may be the owner's own work in progress. |
| B9 | A manual start (`POST /tasks/:id/start`, `brain task start`) ignores the global concurrency limit; the one-session-per-project rule still applies. | The owner asked for it explicitly. |
| B10 | Restarting a `failed`/`blocked` task starts a fresh Claude session on the same branch. Earlier answers and review notes go into the prompt. | A failed session can be in a bad state; the branch keeps the work. |
| B11 | Shutting the server down cancels running sessions (tasks → `blocked`). After a crash, orphaned runs are closed as `interrupted` and their tasks marked `failed`. | Nothing stays silently `in_progress`. |
| B12 | The CLI goes through the HTTP API for session actions when the server is up, else runs them in the foreground. The scheduler also resumes answered-but-not-resumed tasks. | Works with or without the server, and an answer is never lost. |
| B13 | The owner's own Claude sessions reach Second Brain through a second MCP server, `secondbrain` (`src/mcp/owner.ts`), registered once at user scope. It is separate from the agents' `brain` server. Data actions work on `BRAIN_DIR` directly, like the CLI. Start, cancel, answer and request-changes need the running server and fail with a hint when it is down: an MCP process is too short-lived to host a 30-minute foreground session. The current project is the one whose repo or `brain/projects/<slug>/` folder contains the session's working directory. | Lets the owner manage tasks, questions, reviews and knowledge from any project without leaving the chat (2026-10-23). The agents' server only knows its own task, and agent runs use `--strict-mcp-config`, so they never load the owner server. |

Scaling to large projects (with the owner, 2026-10-23; see [06-scaling-roadmap.md](06-scaling-roadmap.md)):

| # | Decision | Reason |
|---|---|---|
| D10 | **Agents get full permissions** (`bypassPermissions`). Only `git push` stays denied; the server pushes per `push_policy`. Supersedes D3's "never merge" for agents: they may merge, rebase, cherry-pick and reset their own task branch. | Owner's request. Restricted Bash left agents unable to test, build, or bring their branch up to date; t_asddkg spent 5 runs asking the owner to run git commands. |
| D11 | **One git worktree per task** under `~/.secondbrain/worktrees`, `max_parallel` per project (default 1). Replaces B7's checkout switching and B8's dirty-tree skip. | Parallel work in big projects, and the owner's checkout is never touched. Outside every repo so no unrelated CLAUDE.md is loaded. |
| D12 | **The server syncs the task branch with its base before each start** (fast-forward, or merge); conflicts go to the agent. Resume after an answer only fast-forwards. | Branches cut before their dependencies merged were stuck (F8 only prevented new cases). |
| D13 | **Per-project `verify_command`**, run by the runner before review; failures go back to the agent up to 2 times. | Agents shipped unverified work; the owner was creating "verify" tasks by hand. |
| D14 | **Milestones** group tasks; **planner tasks** (`kind = 'plan'`) maintain PROJECT.md, milestones and the next tasks. Planner output lands in the **inbox** for the owner to triage; `auto_plan` is opt-in per project. | Large projects need structure above tasks, and Claude should move projects forward without the owner writing every task. Inbox (not todo) keeps the owner in control of what runs. |
| D15 | No Telegram/chat channel for now (roadmap step 6 dropped by the owner). Overview page + cost per project instead. | Owner's choice. |

Scheduled tasks (owner's request, 2026-10-23; built in the same session, defaults chosen by Claude, the owner may revisit):

| # | Decision | Reason |
|---|---|---|
| D16 | **Schedules queue ordinary tasks.** A schedule is a task template plus a time (`once` at `run_at`, or `recurring` by cron). When due it creates a `todo` task; the normal scheduler, review and Inbox handle the rest. | No second execution path; a check's result is the task's review summary, which already reaches the Inbox. |
| D17 | **Cron in the server's local time**, own small parser, plus a friendly picker in the UI (hourly / daily / weekdays / days of week / monthly / custom). | One Mac, one time zone; no dependency. |
| D18 | **Missed times are caught up once**; a recurring time is **skipped while the previous task is still queued or running** (inbox/todo/in_progress/waiting_for_human). A task in review does not block the next run. | Server restarts shouldn't flood the board; slow runs shouldn't pile up; an unread report shouldn't silence a check. |
| D19 | **A recurring task gets the previous run's result** in its prompt and is asked what changed. Default mode for schedules is `auto`. | "Check whether X happened" is only useful relative to last time. |

## Open questions for the owner

| # | Question | Why it matters | Proposed default |
|---|---|---|---|
| Q1 | Build the messaging gateway ourselves, or reuse an existing open-source assistant gateway (OpenClaw-style) for the channel layer? | Channels (esp. WhatsApp / iMessage) are the most fiddly, least interesting part. | Build Telegram ourselves first (small); evaluate reuse before iMessage/WhatsApp. |
| Q3 | Language of messages the brain sends **to you** on chat: English or Persian? | Code/docs are English regardless; this is the UX language. | Ask – not assumed. |
| Q6 | Which channel is "primary" for questions when you are reachable on several? | Avoids duplicate pings. | Telegram. |

Answered: Q2 (Mac only for v1), Q4 (both; `repo_path` optional), Q5 (commit on a branch, never push/deploy), Q7 (TypeScript + SQLite).

## Follow-ups (found during the web UI end-to-end test, 2026-10-19)

| # | Item | Notes |
|---|---|---|
| F1 | ~~SSE does not replay events missed while the browser was disconnected.~~ Done 2026-10-19: the web UI refetches the open view and the inbox count after a reconnect. No server replay, because `run.log`, `status` and `project.updated` are never stored. | 05-api-contract.md "Live events". |
| F2 | ~~`updated` on `PUT /api/knowledge/note` unspecified.~~ Done 2026-10-19: the server stamps today's date (`YYYY-MM-DD`) unless the client changed the value on purpose. | `stampUpdated` in src/core/knowledge.ts; mirrored in the web mock. |
| F3 | ~~Statuses accepted by `POST /api/tasks/:id/cancel` unspecified.~~ Done 2026-10-19: every status except `done` (409); `blocked` is a no-op. The UI shows Cancel only for the six statuses where it does something. | Documented in 05-api-contract.md. |
| F5 | ~~Let the agent resolve merge conflicts.~~ Done 2026-10-23: agents may run `git merge` now (D10). A conflict on approve: request changes and the agent merges and resolves; a sync conflict before a start is handed to the agent automatically (D12). | |
| F6 | `pnpm verify` against the real CLI has not been re-run since delivery was added (dry run with the fake claude only). | Step 3 now asserts the squash merge. |
| F7 | ~~Approved but not merged.~~ Fixed 2026-10-23. Between 08:55 and 09:01 UTC four tasks were approved while the server ran a stale `dist/` from before delivery existed: t_kq88zg, t_jgesd7 (shop), t_i9a3g2 and t_fxdh5c (website). They became `done` without being merged. | `pnpm start` builds first, and a `dist/` server refuses to start when `src/` is newer (`src/server/stale-build.ts`). `brain task merge` / `POST /tasks/:id/merge` / the drawer's "Merge into base" merges a done task that was never merged. All four were merged that way on 2026-10-23. t_i9a3g2 first needed `main` merged into its branch (the sitemap `ORDER` line was resolved by keeping both sides). Nothing was pushed. Note: after such a merge `commit_count` also counts the base commits brought in, but the squash only carries the task's own changes. |
| F8 | ~~Dependent tasks have no dependency model.~~ Done 2026-10-23. A task branched from `main` while the work it built on was unmerged. Agents can't merge, so they stopped and asked (t_asddkg, t_skd4p6). | Tasks have `depends_on`, and neither the scheduler nor `start` begins a task until each dependency is done and merged. Agent follow-ups depend on their parent by default. See 05-api-contract.md "Dependencies". |
| F4 | ~~Real-CLI pause/resume and `pnpm verify` with real runs not yet executed.~~ Done 2026-10-19: spike verdict positive, verify 8/8. | See 04-running.md "Verification status". |
| F9 | After the 2026-10-23 upgrade, still to do by the owner: restart the server (`pnpm start`) so migration 0004 and the new runner load; set `verify_command` / `setup_command` for shop (pnpm monorepo: `pnpm -r typecheck && pnpm -r test`, setup `pnpm install --frozen-lockfile`) and website (`pnpm test:int` + lint; setup `pnpm install --frozen-lockfile && cp "$BRAIN_REPO/.env" .`); fill PROJECT.md or run the planner for both. | Suggested, not applied: a wrong verify command would send every task back to the agent. |
| F10 | Two tasks ended without work because of the old permissions: t_asddkg (shop customer management, closed as done, nothing built) and t_skd4p6 (website /llms-full.txt, in review, nothing built). | t_skd4p6: Request changes → the new runner fast-forwards its branch to main and the agent can build. t_asddkg: needs a new task (or the planner will queue one). |
