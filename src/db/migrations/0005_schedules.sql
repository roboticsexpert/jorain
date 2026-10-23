-- Scheduled tasks: a task template that is queued once at run_at, or every time a cron expression matches.
CREATE TABLE schedules (
  id           TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects(slug),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  mode         TEXT NOT NULL CHECK (mode IN ('auto','assisted')),
  priority     INTEGER NOT NULL DEFAULT 2 CHECK (priority IN (1,2,3)),
  kind         TEXT NOT NULL CHECK (kind IN ('once','recurring')),
  run_at       TEXT,
  cron         TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  next_run_at  TEXT,
  last_run_at  TEXT,
  last_task_id TEXT,
  run_count    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK ((kind = 'once' AND run_at IS NOT NULL) OR (kind = 'recurring' AND cron IS NOT NULL))
);
CREATE INDEX schedules_due ON schedules(enabled, next_run_at);

ALTER TABLE tasks ADD COLUMN schedule_id TEXT REFERENCES schedules(id);
CREATE INDEX tasks_schedule ON tasks(schedule_id);
