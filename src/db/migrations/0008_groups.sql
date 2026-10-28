-- Project groups: several projects (e.g. a backend and a frontend repo) that make one product (docs/09-project-groups.md).
-- The table is project_groups because GROUPS is an SQL keyword.
CREATE TABLE project_groups (
  slug       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE projects ADD COLUMN group_slug TEXT REFERENCES project_groups(slug);
CREATE INDEX projects_group ON projects(group_slug);
