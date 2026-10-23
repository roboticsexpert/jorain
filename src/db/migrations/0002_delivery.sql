-- Commit / merge / push tracking. The server (never the agent) squash-merges a task branch on approve
-- and pushes the base branch when the project's push_policy says so.
ALTER TABLE projects ADD COLUMN push_policy TEXT NOT NULL DEFAULT 'never' CHECK (push_policy IN ('never','after_merge'));

ALTER TABLE tasks ADD COLUMN commit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN merged_sha   TEXT;
ALTER TABLE tasks ADD COLUMN merged_into  TEXT;
ALTER TABLE tasks ADD COLUMN merged_at    TEXT;
ALTER TABLE tasks ADD COLUMN pushed_at    TEXT;
ALTER TABLE tasks ADD COLUMN push_error   TEXT;
