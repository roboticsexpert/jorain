-- Large projects: per-project verify/setup commands and parallelism, milestones, planner tasks,
-- one git worktree per task, and the result of the last verification.
ALTER TABLE projects ADD COLUMN verify_command TEXT;
ALTER TABLE projects ADD COLUMN setup_command  TEXT;
ALTER TABLE projects ADD COLUMN max_parallel   INTEGER NOT NULL DEFAULT 1 CHECK (max_parallel BETWEEN 1 AND 10);
ALTER TABLE projects ADD COLUMN auto_plan      INTEGER NOT NULL DEFAULT 0 CHECK (auto_plan IN (0,1));

CREATE TABLE milestones (
  id           TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects(slug),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  position     INTEGER NOT NULL DEFAULT 0,
  due          TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX milestones_project ON milestones(project_slug, position);

ALTER TABLE tasks ADD COLUMN milestone_id  TEXT REFERENCES milestones(id);
ALTER TABLE tasks ADD COLUMN kind          TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work','plan'));
ALTER TABLE tasks ADD COLUMN worktree      TEXT;
ALTER TABLE tasks ADD COLUMN verify_status TEXT CHECK (verify_status IN ('passed','failed'));
CREATE INDEX tasks_milestone ON tasks(milestone_id);
