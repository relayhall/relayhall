-- RH-P1.3: forward-only cleanup for the deployment-neutral core.
-- Historical migrations remain immutable; this migration moves existing
-- installations to the same target shape as database/init.sql.

-- Journal and image generation are plugin-owned features, not core tables.
DROP TABLE IF EXISTS journal_entries CASCADE;
DROP TABLE IF EXISTS image_generations CASCADE;

-- Genericize the persisted notebook link type without breaking upgrades from
-- databases whose immutable migration 008 admitted only `notebooklm`.
ALTER TABLE project_links DROP CONSTRAINT IF EXISTS project_links_type_check;
UPDATE project_links SET type = 'notebook' WHERE type = 'notebooklm';
ALTER TABLE project_links ADD CONSTRAINT project_links_type_check
  CHECK (type IN ('git', 'doc', 'url', 'api', 'project', 'dashboard', 'notebook', 'file'));

-- Preserve project tool instructions while moving the legacy key forward.
UPDATE projects
SET tool_instructions = (tool_instructions - 'notebookLM')
  || jsonb_build_object('notebook', tool_instructions -> 'notebookLM')
WHERE tool_instructions ? 'notebookLM'
  AND NOT (tool_instructions ? 'notebook');
UPDATE projects
SET tool_instructions = tool_instructions - 'notebookLM'
WHERE tool_instructions ? 'notebookLM';

-- Migration 063 is preserved but retired because it mutates the extracted
-- journal table. Reapply its core ownership substrate here without that edge.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS owner_principal_id UUID,
  ADD COLUMN IF NOT EXISTS creator_principal_id UUID,
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared', 'public'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_tasks_owner_principal' AND conrelid = 'tasks'::regclass
  ) THEN
    ALTER TABLE tasks ADD CONSTRAINT fk_tasks_owner_principal
      FOREIGN KEY (owner_principal_id) REFERENCES principals(id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_tasks_creator_principal' AND conrelid = 'tasks'::regclass
  ) THEN
    ALTER TABLE tasks ADD CONSTRAINT fk_tasks_creator_principal
      FOREIGN KEY (creator_principal_id) REFERENCES principals(id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
ALTER TABLE tasks VALIDATE CONSTRAINT fk_tasks_owner_principal;
ALTER TABLE tasks VALIDATE CONSTRAINT fk_tasks_creator_principal;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS owner_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared', 'public'));
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS principal_id UUID REFERENCES principals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS spawned_by_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL;
ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS author_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL;
ALTER TABLE task_history
  ADD COLUMN IF NOT EXISTS actor_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL;
ALTER TABLE task_timeline_events
  ADD COLUMN IF NOT EXISTS actor_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_tasks_owner_principal ON tasks(owner_principal_id);
CREATE INDEX IF NOT EXISTS ix_projects_owner_principal ON projects(owner_principal_id);
CREATE INDEX IF NOT EXISTS ix_reports_author_principal ON reports(author_principal_id);
CREATE INDEX IF NOT EXISTS ix_sessions_principal ON sessions(principal_id);

CREATE TABLE IF NOT EXISTS resource_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type VARCHAR(32) NOT NULL,
  resource_id VARCHAR(64) NOT NULL,
  grantee_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  permission VARCHAR(16) NOT NULL CHECK (permission IN ('read', 'write', 'admin')),
  granted_by_principal_id UUID REFERENCES principals(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_type, resource_id, grantee_principal_id)
);
ALTER TABLE resource_grants
  DROP CONSTRAINT IF EXISTS resource_grants_resource_type_check;
DELETE FROM resource_grants WHERE resource_type = 'journal';
ALTER TABLE resource_grants
  ADD CONSTRAINT resource_grants_resource_type_check
  CHECK (resource_type IN ('task', 'session', 'report', 'project'));
CREATE INDEX IF NOT EXISTS ix_grants_grantee ON resource_grants(grantee_principal_id);

INSERT INTO resource_grants (
  resource_type, resource_id, grantee_principal_id, permission, granted_by_principal_id
)
SELECT 'report', '*', reader.id, 'read', owner.id
FROM principals reader, principals owner
WHERE reader.handle = 'reports_reader' AND owner.handle = 'dashboard_user'
ON CONFLICT (resource_type, resource_id, grantee_principal_id) DO NOTHING;

DO $$
DECLARE trigger_row record;
BEGIN
  FOR trigger_row IN
    SELECT trigger.tgrelid::regclass AS table_name, trigger.tgname AS trigger_name
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    WHERE NOT trigger.tgisinternal
      AND relation.relnamespace = 'public'::regnamespace
      AND trigger.tgname IN ('update_tasks_updated_at', 'update_projects_updated_at')
  LOOP
    EXECUTE format(
      'ALTER TABLE %s DISABLE TRIGGER %I',
      trigger_row.table_name,
      trigger_row.trigger_name
    );
  END LOOP;
END $$;

UPDATE tasks
SET owner_principal_id = (SELECT id FROM principals WHERE handle = 'dashboard_user')
WHERE owner_principal_id IS NULL;
UPDATE projects
SET owner_principal_id = (SELECT id FROM principals WHERE handle = 'dashboard_user')
WHERE owner_principal_id IS NULL;
UPDATE reports report
SET author_principal_id = principal.id
FROM principals principal
WHERE report.author_principal_id IS NULL
  AND report.author_actor_id IS NOT NULL
  AND principal.handle = report.author_actor_id;

DO $$
DECLARE trigger_row record;
BEGIN
  FOR trigger_row IN
    SELECT trigger.tgrelid::regclass AS table_name, trigger.tgname AS trigger_name
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    WHERE NOT trigger.tgisinternal
      AND relation.relnamespace = 'public'::regnamespace
      AND trigger.tgname IN ('update_tasks_updated_at', 'update_projects_updated_at')
  LOOP
    EXECUTE format(
      'ALTER TABLE %s ENABLE TRIGGER %I',
      trigger_row.table_name,
      trigger_row.trigger_name
    );
  END LOOP;
END $$;

ALTER TABLE reports ALTER COLUMN author SET DEFAULT 'system';

-- Migration 049 assigned private-estate provenance to otherwise anonymous
-- legacy status rows. Keep the row but neutralize that synthetic attribution.
UPDATE bot_status
SET author = 'system', author_harness = 'unknown'
WHERE author = 'Nim'
  AND author_harness = 'openclaw'
  AND run_type = 'legacy';
