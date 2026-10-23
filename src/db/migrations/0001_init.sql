CREATE TABLE projects (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  repo_path     TEXT,
  default_mode  TEXT NOT NULL DEFAULT 'auto' CHECK (default_mode IN ('auto','assisted')),
  model         TEXT,
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  project_slug   TEXT NOT NULL REFERENCES projects(slug),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  mode           TEXT NOT NULL CHECK (mode IN ('auto','assisted')),
  status         TEXT NOT NULL CHECK (status IN ('inbox','todo','in_progress','waiting_for_human','review','done','blocked','failed')),
  priority       INTEGER NOT NULL DEFAULT 2 CHECK (priority IN (1,2,3)),
  branch         TEXT,
  base_branch    TEXT,
  base_sha       TEXT,
  session_id     TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX tasks_status ON tasks(status, priority);
CREATE INDEX tasks_project ON tasks(project_slug);

CREATE TABLE questions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  tool_use_id TEXT NOT NULL UNIQUE,
  questions   TEXT NOT NULL,
  answer      TEXT,
  asked_at    TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX questions_task ON questions(task_id);

CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('start','resume')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  exit_code   INTEGER,
  stop_reason TEXT,
  usage       TEXT,
  cost_usd    REAL,
  log_path    TEXT NOT NULL,
  pid         INTEGER
);
CREATE INDEX runs_task ON runs(task_id);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX events_task ON events(task_id);

-- Mirror of the Markdown knowledge files; knowledge_fts (FTS5) is created in code when available.
CREATE TABLE knowledge_docs (
  path   TEXT PRIMARY KEY,
  scope  TEXT NOT NULL,
  title  TEXT NOT NULL,
  tags   TEXT NOT NULL DEFAULT '[]',
  body   TEXT NOT NULL,
  mtime  REAL NOT NULL,
  updated TEXT
);
