-- 063_ownership_attribution.sql
-- Dormant ownership/attribution columns + grants table + backfill.
--
-- SELF-GUARD: the stock runner (db/migrate.ts) applies all pending migrations in ONE
-- invocation, so 062-seeds-before-063 ordering is enforced here, not by runbook ceremony.
-- Note there are two distinct abort paths: if 062 never ran at all, `principals` does not
-- exist and this block aborts with undefined_table (42P01) rather than the message below.
-- Both abort safely; the runbook should expect either text.
DO $$
BEGIN
  IF (SELECT count(*) FROM principals WHERE handle IN
      ('dashboard_user','system','service_account','journal_publisher','reports_reader',
       'hermes_task_agent','clawbeat_qa','clawbeat_reviewer','hermes_qa','hermes_qa_reviewer')) < 10 THEN
    RAISE EXCEPTION '063 aborted: 062 seed principals missing — apply/repair 062 first';
  END IF;
END $$;

-- tasks: hot table (5s updater) — add columns bare, then FK as NOT VALID + VALIDATE (053 pattern).
-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres: DO-block guards keep 063 re-runnable.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS owner_principal_id   UUID,
  ADD COLUMN IF NOT EXISTS creator_principal_id UUID,
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private','shared','public'));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_tasks_owner_principal' AND conrelid='tasks'::regclass) THEN
    ALTER TABLE tasks ADD CONSTRAINT fk_tasks_owner_principal FOREIGN KEY (owner_principal_id)
      REFERENCES principals(id) ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_tasks_creator_principal' AND conrelid='tasks'::regclass) THEN
    ALTER TABLE tasks ADD CONSTRAINT fk_tasks_creator_principal FOREIGN KEY (creator_principal_id)
      REFERENCES principals(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
ALTER TABLE tasks VALIDATE CONSTRAINT fk_tasks_owner_principal;
ALTER TABLE tasks VALIDATE CONSTRAINT fk_tasks_creator_principal;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS owner_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private','shared','public'));

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS principal_id            UUID REFERENCES principals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS spawned_by_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL;

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS author_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL;

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS author_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL;

ALTER TABLE task_history
  ADD COLUMN IF NOT EXISTS actor_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL;

ALTER TABLE task_timeline_events
  ADD COLUMN IF NOT EXISTS actor_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_tasks_owner_principal    ON tasks(owner_principal_id);
CREATE INDEX IF NOT EXISTS ix_projects_owner_principal ON projects(owner_principal_id);
CREATE INDEX IF NOT EXISTS ix_reports_author_principal ON reports(author_principal_id);
CREATE INDEX IF NOT EXISTS ix_sessions_principal       ON sessions(principal_id);

-- Sharing table (Phase-3 enforcement, but schema + pre-grant ship NOW so no visibility
-- tightening can ever precede the knowledge-fabric pre-grant by construction).
CREATE TABLE IF NOT EXISTS resource_grants (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type         VARCHAR(32) NOT NULL
                          CHECK (resource_type IN ('task','session','report','journal','project')),
  resource_id           VARCHAR(64) NOT NULL,        -- '*' = every resource of the type (wildcard pre-grant)
  grantee_principal_id  UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  permission            VARCHAR(16) NOT NULL CHECK (permission IN ('read','write','admin')),
  granted_by_principal_id UUID REFERENCES principals(id),
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_type, resource_id, grantee_principal_id)
);
CREATE INDEX IF NOT EXISTS ix_grants_grantee ON resource_grants(grantee_principal_id);

-- reports_reader pre-grant (locked requirement: pre-granted BEFORE any tightening).
INSERT INTO resource_grants (resource_type, resource_id, grantee_principal_id, permission, granted_by_principal_id)
SELECT 'report', '*', r.id, 'read', o.id
  FROM principals r, principals o
 WHERE r.handle = 'reports_reader' AND o.handle = 'dashboard_user'
ON CONFLICT (resource_type, resource_id, grantee_principal_id) DO NOTHING;
INSERT INTO resource_grants (resource_type, resource_id, grantee_principal_id, permission, granted_by_principal_id)
SELECT 'journal', '*', r.id, 'read', o.id
  FROM principals r, principals o
 WHERE r.handle = 'reports_reader' AND o.handle = 'dashboard_user'
ON CONFLICT (resource_type, resource_id, grantee_principal_id) DO NOTHING;

-- ============ BACKFILL (ownership = tenant fact; provenance = confident-only) ============

-- tasks, projects and reports each carry a BEFORE UPDATE trigger that sets
-- updated_at = CURRENT_TIMESTAMP. A backfill is not a content edit, so letting
-- those fire would rewrite every row's updated_at to the migration timestamp —
-- irreversibly, since rollback restores the image and not the data. That matters
-- beyond cosmetics: board ordering reads updated_at, and the knowledge-fabric
-- connector polls reports with updated_since, so it would re-pull every
-- backfilled report. Suppress only these three named triggers, and only for the
-- duration of the backfill. The journal integrity trigger is deliberately left
-- armed. All of this is inside the migration's single implicit transaction, so
-- an abort restores the catalog with the triggers enabled.
DO $$
DECLARE tg record;
BEGIN
  -- Select and address the table by oid, not by bare name: an identically named
  -- trigger in another schema would otherwise either abort the migration or,
  -- worse, resolve through search_path and disable public's trigger twice while
  -- silently leaving the other armed.
  FOR tg IN SELECT t.tgrelid::regclass AS tbl, t.tgname AS trg
              FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
             WHERE NOT t.tgisinternal
               AND c.relnamespace = 'public'::regnamespace
               AND t.tgname IN ('update_tasks_updated_at',
                                'update_projects_updated_at',
                                'update_reports_updated_at')
  LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', tg.tbl, tg.trg);
  END LOOP;
END $$;

-- (a) OWNERSHIP baseline: single-tenant fact, not provenance laundering.
UPDATE tasks    SET owner_principal_id = (SELECT id FROM principals WHERE handle='dashboard_user')
 WHERE owner_principal_id IS NULL;
UPDATE projects SET owner_principal_id = (SELECT id FROM principals WHERE handle='dashboard_user')
 WHERE owner_principal_id IS NULL;

-- (b) PROVENANCE, confident-only:
-- reports: author_actor_id (058) is server-verified — join by handle; NULLs STAY NULL (058 rule).
UPDATE reports r SET author_principal_id = p.id
  FROM principals p
 WHERE r.author_principal_id IS NULL
   AND r.author_actor_id IS NOT NULL
   AND p.handle = r.author_actor_id;

-- journal: entries written by the publish service carry server-written provenance JSONB
-- ({executor:'Hermes', operation, run_id, idempotency_key, ...}) and were authenticated as
-- journal_publisher — confident.
-- NOTE: migration 045 made provenance NOT NULL DEFAULT '{}' and entry_type NOT NULL DEFAULT
-- 'narrative', so "provenance IS NOT NULL" is true for EVERY row — match provenance CONTENT:
UPDATE journal_entries j SET author_principal_id = (SELECT id FROM principals WHERE handle='journal_publisher')
 WHERE j.author_principal_id IS NULL
   AND j.provenance ? 'run_id'
   AND j.provenance->>'executor' = 'Hermes';

DO $$
DECLARE tg record;
BEGIN
  FOR tg IN SELECT t.tgrelid::regclass AS tbl, t.tgname AS trg
              FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
             WHERE NOT t.tgisinternal
               AND c.relnamespace = 'public'::regnamespace
               AND t.tgname IN ('update_tasks_updated_at',
                                'update_projects_updated_at',
                                'update_reports_updated_at')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER %I', tg.tbl, tg.trg);
  END LOOP;
END $$;

-- Everything else stays NULL deliberately (no provenance laundering):
--   tasks.creator_principal_id           — no creator provenance was ever recorded.
--   sessions.principal_id / spawned_by   — go-forward only; historical runtime identity is free text.
--   task_history.actor_principal_id      — changed_by='user'/'system' are hardcoded constants,
--                                          NOT the real caller.
--   task_timeline_events.actor_principal_id — 'sub-agent'/'interactive-agent'/'user' free text.
--   journal pre-publish-service entries, reports with NULL author_actor_id.
--   active_agent/completed_by JSONB principalId — additive field written go-forward only.
