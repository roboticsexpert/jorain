# Vision (requirements as stated by the owner, 2026-10-19)

## One-line
A personal "second brain" that stores my knowledge, lets me talk to it from the chat apps I already use, and uses Claude to push my projects forward with me in the loop only where needed.

## Requirements

### Channels
- Reachable over iMessage, WhatsApp and Telegram (and similar later).
- I send a message there and it can turn into a task, a note, an answer to a pending question, or a conversation with a running session.

### Projects and tasks
- I define projects. Each project has a task list (a task manager).
- Claude tries to move projects forward on its own.
- When it needs me (read something, approve/reject, answer a question, or talk inside the session), it asks me on a channel and **waits** until I reply.
- The column decides who acts: a task in **Inbox** waits for me to read it; a task in **Todo** gets done by Claude without asking. (There used to be an auto/assisted mode; it was removed on 2026-10-24.)
- Each project will eventually have its own stages, but to start every project uses one simple board: Inbox → Todo → In Progress → Done (plus whatever is needed for "waiting on me").

### Knowledge base
- Global knowledge (things true across everything I do).
- Per-project knowledge that Claude loads when working on that project.
- Claude should be able to use this knowledge while working, and ideally write back what it learns.

### Tools (MCP)
- A global set of MCP servers available everywhere.
- Per-project MCP servers on top of the global set.

## Non-goals for v1
- A polished web UI. The chat channels are the UI at first; a dashboard can come later.
- Per-project custom workflow stages. One shared board first.
