-- A composer draft may target another project of the chat's group (NULL = the chat's project).
ALTER TABLE composer_drafts ADD COLUMN project_slug TEXT REFERENCES projects(slug);
