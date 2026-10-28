-- Task composer (docs/08-task-composer.md): a chat per project that drafts tasks for the owner to create.
CREATE TABLE composer_chats (
  id           TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects(slug),
  title        TEXT NOT NULL DEFAULT '',
  -- The `claude -p` session the chat resumes; NULL until the first reply.
  session_id   TEXT,
  -- 'thinking' while a turn runs.
  status       TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','thinking')),
  cost_usd     REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX composer_chats_project ON composer_chats(project_slug, updated_at);

CREATE TABLE composer_messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES composer_chats(id),
  role       TEXT NOT NULL CHECK (role IN ('owner','assistant','error')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX composer_messages_chat ON composer_messages(chat_id, created_at);

CREATE TABLE composer_drafts (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES composer_chats(id),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  priority   INTEGER NOT NULL DEFAULT 2,
  -- Milestone id or title, resolved when the task is created.
  milestone  TEXT,
  -- JSON array of task ids and/or draft ids (d_...) of the same chat.
  depends_on TEXT NOT NULL DEFAULT '[]',
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','created','discarded')),
  task_id    TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX composer_drafts_chat ON composer_drafts(chat_id, created_at);
