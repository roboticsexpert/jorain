-- The task thread: non-blocking updates and to-dos from the agent, messages from the owner (docs/07-task-thread.md).
CREATE TABLE task_messages (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  author       TEXT NOT NULL CHECK (author IN ('agent','owner')),
  kind         TEXT NOT NULL CHECK (kind IN ('update','action','message')),
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  -- Actions only: open until the owner marks them done or declined (with an optional note).
  status       TEXT CHECK (status IN ('open','done','declined')),
  note         TEXT,
  created_at   TEXT NOT NULL,
  -- Agent messages: when the owner saw them.
  read_at      TEXT,
  -- When the agent got this row's latest owner input (an owner message, or an action's resolution); NULL = pending.
  delivered_at TEXT,
  resolved_at  TEXT
);
CREATE INDEX task_messages_task ON task_messages(task_id, created_at);
CREATE INDEX task_messages_pending ON task_messages(task_id) WHERE delivered_at IS NULL;

-- Set while the agent waits for the owner via wait_for_owner: JSON { tool_use_id, action_id, since }.
ALTER TABLE tasks ADD COLUMN waiting_for TEXT;
