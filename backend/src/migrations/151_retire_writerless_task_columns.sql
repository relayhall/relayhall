-- E108 (3b), task 68f9dffe: retire the six writer-less Task columns.
-- Canonical stream/session/assignment records and immutable review history remain.
-- No CASCADE: an unexpected dependent object must stop the migration.
ALTER TABLE tasks
  DROP COLUMN completed_by,
  DROP COLUMN active_agent,
  DROP COLUMN acp_session_key,
  DROP COLUMN session_refs,
  DROP COLUMN last_checked,
  DROP COLUMN auto_created;
