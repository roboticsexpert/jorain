# Task composer: create tasks by talking to an AI (built 2026-10-28)

Status: **built.** Discussed with the owner on 2026-10-28; the owner chose a chat in the web UI. Open points are at the end.

## The need (owner's words, summarised)

The owner wants one session to **chat with** that turns a rough idea into well-formed tasks, and other
sessions (the normal agent runs) to **do** them. The "new task" form only takes title, details, priority,
column and milestone, and the owner writes every task by hand.

## What was built

A **Compose** page in the web UI (`/compose`, nav item 💬, and "💬 Compose with Claude" on the Board):
chats per project on the left, the conversation in the middle, draft tasks on the right.

- **Chat turns.** Each owner message is one `claude -p` turn (`src/runner/composer.ts`, class `Composer`). The
  first turn uses `--session-id`, later ones `--resume`, so the conversation continues. The system prompt
  (`composerPrompt` in `src/runner/prompt.ts`) is rebuilt every turn with PROJECT.md, GROUP.md, siblings,
  milestones and the board, so it is never stale. Turns time out after 10 minutes and get 40 turns at most. They can be stopped from the UI.
- **Read-only.** Built-in tools are `Read, Glob, Grep, WebSearch, WebFetch` only (Edit/Write/NotebookEdit/Bash
  are also on the deny list). cwd is the project's main checkout (or its brain folder); sibling repos come in via `--add-dir`.
  The project's own MCP servers are not loaded (`--strict-mcp-config` with only the composer server).
- **Composer MCP server** (`src/mcp/composer.ts`, exposed as `mcp__brain__*`): `propose_task`, `revise_draft`,
  `discard_draft`, `list_drafts`, `set_chat_title`, `project_board`, `search_knowledge`. It cannot create
  tasks, only drafts.
- **Drafts.** Title, Markdown body (with acceptance criteria), priority, milestone (validated) and depends_on
  (existing task ids or draft ids of the same chat). The owner edits, discards or **Creates** them, one at a time
  or with "Create all". The panel sets the column: Todo (Claude starts it) or Inbox. "Create all" creates
  dependencies first and maps draft ids to the new task ids. A dependency on a discarded draft is dropped.
- **Storage** (migration `0009_composer.sql`): `composer_chats` (session id, status idle/thinking, cost),
  `composer_messages` (owner/assistant/error), `composer_drafts`. Chats stuck in `thinking` after a server
  restart are reset with an error message.
- **Live.** SSE events `composer.chat`, `composer.message`, `composer.draft`, `composer.deleted`. Drafts are
  written by the MCP process, so they reach the UI through the events-table relay (`src/server/live.ts`).
- Logs: `brain/runs/composer/<chat-id>.jsonl`. API: see "Task composer" in `05-api-contract.md`.
- Tests: `tests/composer.test.ts` (drafts → tasks, dependency order, MCP tools, chat turns with `tests/fake-composer.mjs`).

Verified end to end on 2026-10-28 with the real CLI against a scratch BRAIN_DIR (`api-composer` / `web-composer`
in `.claude/launch.json`). A two-turn chat proposed tasks, revised a priority, added a third task, then "Create all" put
3 inbox tasks on the board with the right dependencies. One turn costs roughly $0.20–0.30 on this repo.

## Open points for the owner

1. Should the composer be able to start a task right away, or only create it (current behaviour)?
2. Should it also be reachable from the owner MCP (`secondbrain`), e.g. `compose(project, message)`?
3. Should a chat be able to propose tasks for sibling projects of a group (today: this project only)?
