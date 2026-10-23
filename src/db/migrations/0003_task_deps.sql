-- Task dependencies: a task waits (the scheduler does not start it) until every task it depends on is
-- done and its work is in the base branch (merged, or approved with nothing to merge).
CREATE TABLE task_deps (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  depends_on TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id <> depends_on)
);
CREATE INDEX task_deps_on ON task_deps(depends_on);
