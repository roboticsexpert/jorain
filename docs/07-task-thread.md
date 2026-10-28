# Task thread: updates and feedback while a task runs (2026-10-28)

Status: **built 2026-10-28** (owner: "build it", with Claude's defaults for the open points; see D21–D23 in 03-decisions.md).
The proposal below is kept; **As built** at the end is authoritative where they differ.

## The need (owner's words, summarised)

Example: a task "post an ad on Telegram". While it works, the session should be able to hand the owner
things that are not questions: the ad drafts, the channels it found and their prices, the reach numbers.
The owner reviews them and wants to reply (feedback, "use the second draft", "also try channel X"),
or add context to the session at any time without being asked. Some of what comes back is **work for the owner**
(pay the channel admin, send the post from my own account, give access). It is not just review.

Today there are only two channels between a session and the owner:

| Today | Limitation |
|---|---|
| `ask_human`: defer, task → `waiting_for_human`, resume with the answer | Blocking, and only a question. The session stops. |
| `result_summary` at `review` + request changes | Only at the end. |
| The runner spawns `claude -p` with `stdin: 'ignore'` (`src/runner/claude.ts`) | Nothing can reach a running session. |

## Proposal: one conversation per task ("thread")

A `task_messages` table: the history of the task as a chat, shown in the task drawer and in the Inbox.

```
task_messages: id, task_id, author ('agent' | 'owner'), kind, title, body (markdown),
               status, delivered_at, created_at, resolved_at
kind:   'update'  – FYI / material to look at (drafts, findings, numbers). Non-blocking.
        'action'  – something the owner has to do. Non-blocking until the agent says it needs it.
        'message' – a plain chat message (mostly from the owner).
status (action only): open → done | declined   (owner can attach a note)
```

### Agent → owner (new brain MCP tools, `src/mcp/server.ts`)

- `post_update(title, body)`: appears in the thread and Inbox; the session keeps working.
- `request_action(title, body)`: an item on the owner's to-do list for this task; returns an id; the session keeps working.
- `wait_for(action_id | "reply")`: only when the agent cannot continue without it. Pauses the run exactly like
  `ask_human` (PreToolUse defer → `waiting_for_human` → resume), so there is no new pause mechanism.

The prompt (`src/runner/prompt.ts`) tells the agent: share material with `post_update` instead of asking.
Use `request_action` for things only the owner can do. Use `ask_human` only for real decisions.

### Owner → agent

A message box in the task drawer (and on Inbox cards), plus "Done / Declined + note" on action items.
How a message gets into the session depends on the task's state:

| Task state | Delivery |
|---|---|
| `in_progress` (session running) | **Injected at the agent's next tool call**: a PostToolUse hook (next to the existing PreToolUse hook) reads undelivered owner messages from the DB and returns them as `additionalContext`, then marks them delivered. No change to how the CLI is spawned. |
| `waiting_for_human` | Goes in with the resume, the same way an answer does. |
| `review` | Works like "request changes": the task goes back to `in_progress` with the messages as the prompt. |
| `todo` / not started | Added to the first prompt. |

Alternative to the hook: start `claude -p --input-format stream-json` with a stdin pipe and write user messages
into it. It reacts faster, but it changes the runner's core loop and how resume works. Start with the hook.

### Example: the Telegram ad task

1. The agent researches channels → `post_update("Candidate channels", table of 5 channels + price + members)`.
2. It writes copy → `post_update("Ad drafts", 3 drafts)`. It keeps working on the image brief.
3. The owner replies in the thread: "Draft 2, shorter, drop channel C". This reaches the agent at its next tool call.
4. The agent → `request_action("Pay @admin_x 40 USDT and send me the receipt")`, then `wait_for(that id)`.
5. The owner marks it done with a note ("paid, post goes live at 18:00") → the session resumes and schedules the follow-up check.

### Surfaces

- Task drawer: the thread replaces the bare run log as the main view (the run log stays as a tab).
- Inbox: unread agent updates and open action items, next to questions. Badge count = questions + open actions.
- Owner MCP (`src/mcp/owner.ts`): `task_thread(task_id)`, `send_message(task_id, text)`, `resolve_action(id, done|declined, note)`.
- Live: new `task.message` SSE event.

## Open points (defaults applied, the owner may revisit)

1. A message to a task in `review` **wakes it right away** (it works like request changes). → D21
2. An open action **does not block** review or approve; it just stays on the owner's list. → D22
3. No Telegram mirror for now (D15). → D23

## As built

| Piece | Where |
|---|---|
| Table `task_messages` + `tasks.waiting_for` | `src/db/migrations/0007_task_messages.sql` |
| Core: post, owner message, resolve, read, pending/deliver, wait checks | `src/core/messages.ts` |
| Agent tools `post_update`, `request_action`, `wait_for_owner`; `get_task_context` includes the thread | `src/mcp/server.ts` |
| PreToolUse: `wait_for_owner` defers until ready | `src/hooks/pretooluse.ts` |
| PostToolUse (every tool): hands pending owner input to the session as `additionalContext` | `src/hooks/posttooluse.ts`, registered in `src/runner/session-files.ts` |
| Rules in the system prompt; delivered thread in `threadSoFar` (fresh sessions see it) | `src/runner/prompt.ts` |
| Delivery by state, resume after a wait, continue when input arrives after the last tool call | `src/runner/orchestrator.ts` (`message`, `resolveAction`, `resumeAfterWait`, `finish`); the scheduler retries satisfied waits |
| HTTP API + `task.message` SSE | `src/server/app.ts`, `src/server/live.ts`; contract in 05-api-contract.md "Task thread" |
| Owner MCP: `task_thread`, `send_message`, `resolve_action`; `overview` lists to-dos and unread updates | `src/mcp/owner.ts` |
| Web: "Conversation" section in the task drawer (updates, to-dos with Done/Decline + note, composer), Inbox section "To-dos & updates", board badges 📌/📣, "Waiting for you" chip | `web/src/components/Thread.tsx`, `TaskDrawer.tsx`, `pages/Inbox.tsx`, `pages/Board.tsx`; mock backend seeds the Telegram ad example (task `t_adtg1z`) |

Details learned while building:

- **Spike (CLI 2.1.310, 2026-10-28):** PostToolUse `hookSpecificOutput.additionalContext` reaches the model in `claude -p`. But the model treats it as possibly injected text and won't act on it unless told to. So the system prompt says owner input arrives this way and starts with "Second Brain: new input from the owner on this task."
- A row is pending for the agent while `delivered_at` is NULL: an owner message, or an action the owner resolved (resolving clears `delivered_at`). The agent's own posts are delivered at creation.
- `wait_for_owner` is ready when its action is resolved (or unknown), or when there is any pending owner input. A message always unblocks, so the owner can redirect a waiting agent.
- Waits and questions are exclusive. `answer()` and the scheduler never resume a task through the question path while `waiting_for` is set.
- If the hook could not pause the run, the tool records the wait itself (`tool_use_id` starts with `mcp_`) and tells the model to stop. The resume then gets the input as its prompt, the same fallback `ask_human` uses.
- The PostToolUse hook is one extra Node process per tool call, which adds roughly 100 ms. If that becomes a problem, the alternative is `--input-format stream-json` with a stdin pipe.
- Tests: `tests/messages.test.ts` and the "task thread" block in `tests/orchestrator.test.ts`. The fake CLI's `WAIT` and `SLOW` scenarios run hooks the way the real CLI does.
