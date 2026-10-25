-- No more auto/assisted: a todo task is always started by the scheduler; inbox is where tasks wait for the owner.
-- Assisted tasks already in todo were parked there for the owner, so they go back to the inbox instead of starting.
UPDATE tasks SET status = 'inbox' WHERE mode = 'assisted' AND status = 'todo';
ALTER TABLE tasks DROP COLUMN mode;
ALTER TABLE schedules DROP COLUMN mode;
ALTER TABLE projects DROP COLUMN default_mode;
