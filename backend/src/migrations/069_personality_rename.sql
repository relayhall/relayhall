-- RelayHall Personality rename (task 468faa10, RH-VOCAB.1; D-1, D-4, amendment A2).
--
-- "Agent type" and "persona" retire outright: the registry table, its
-- referencing columns, constraints and indexes take the single ratified word
-- Personality. Owner rulings 2026-08-08 (inventory report df72fe00, RESOLVED
-- addendum): in-place guarded renames (DP-2) — metadata-only, non-destructive,
-- idempotent against both upgrade (agent_types exists) and fresh-install
-- (init.sql already creates personalities) databases; the dormant
-- attempt_persona_links table renames in full (DP-4).
--
-- Deliberately untouched, per the same rulings: stored retired_reason strings
-- written by migration 042 stay byte-intact (DP-12, the 066/068 history
-- doctrine); the three historical migration filenames carrying the old words
-- remain ledger keys and never change (DP-13); built-in seed slugs carry no
-- retired words and stay (DP-11).

DO $$
BEGIN
  -- Registry table
  IF to_regclass('public.agent_types') IS NOT NULL THEN
    ALTER TABLE agent_types RENAME TO personalities;
  END IF;

  -- Dormant attempt-link table (055)
  IF to_regclass('public.attempt_persona_links') IS NOT NULL THEN
    ALTER TABLE attempt_persona_links RENAME TO attempt_personality_links;
  END IF;

  -- Referencing columns
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'agent_type_id') THEN
    ALTER TABLE tasks RENAME COLUMN agent_type_id TO personality_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'agent_type_id') THEN
    ALTER TABLE sessions RENAME COLUMN agent_type_id TO personality_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'principals' AND column_name = 'agent_type_id') THEN
    ALTER TABLE principals RENAME COLUMN agent_type_id TO personality_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'attempt_personality_links' AND column_name = 'agent_type_id') THEN
    ALTER TABLE attempt_personality_links RENAME COLUMN agent_type_id TO personality_id;
  END IF;
END $$;

-- Constraint renames (guarded individually: each may already carry the new
-- name on a fresh install, or be absent on a partially provisioned database).
DO $$
DECLARE
  pair RECORD;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('personalities',             'agent_types_pkey',                     'personalities_pkey'),
      ('personalities',             'agent_types_slug_key',                 'personalities_slug_key'),
      ('personalities',             'agent_types_source_check',             'personalities_source_check'),
      ('personalities',             'agent_types_retired_in_favor_of_fkey', 'personalities_retired_in_favor_of_fkey'),
      ('tasks',                     'tasks_agent_type_id_fkey',             'tasks_personality_id_fkey'),
      ('sessions',                  'sessions_agent_type_id_fkey',          'sessions_personality_id_fkey'),
      ('principals',                'principals_agent_type_id_fkey',        'principals_personality_id_fkey'),
      ('attempt_personality_links', 'attempt_persona_links_pkey',           'attempt_personality_links_pkey'),
      ('attempt_personality_links', 'attempt_persona_links_attempt_id_agent_type_id_source_valid_key', 'attempt_personality_links_attempt_id_personality_id_source_key'),
      ('attempt_personality_links', 'attempt_persona_links_attempt_id_agent_type_id_source_valid_f_key', 'attempt_personality_links_attempt_id_personality_id_source_key'),
      ('attempt_personality_links', 'attempt_persona_links_agent_type_id_fkey', 'attempt_personality_links_personality_id_fkey'),
      ('attempt_personality_links', 'attempt_persona_links_attempt_id_fkey',    'attempt_personality_links_attempt_id_fkey'),
      ('attempt_personality_links', 'attempt_persona_links_check',              'attempt_personality_links_check')
    ) AS t(table_name, old_name, new_name)
  LOOP
    IF to_regclass('public.' || pair.table_name) IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_constraint c
                   JOIN pg_class r ON r.oid = c.conrelid
                   WHERE r.relname = pair.table_name AND c.conname = pair.old_name)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c
                       JOIN pg_class r ON r.oid = c.conrelid
                       WHERE r.relname = pair.table_name AND c.conname = pair.new_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
                     pair.table_name, pair.old_name, pair.new_name);
    END IF;
  END LOOP;
END $$;

-- Index renames (no-ops where init.sql already created the new names).
ALTER INDEX IF EXISTS idx_agent_types_slug        RENAME TO idx_personalities_slug;
ALTER INDEX IF EXISTS idx_agent_types_category    RENAME TO idx_personalities_category;
ALTER INDEX IF EXISTS idx_agent_types_live        RENAME TO idx_personalities_live;
ALTER INDEX IF EXISTS idx_tasks_agent_type_id     RENAME TO idx_tasks_personality_id;
ALTER INDEX IF EXISTS idx_sessions_agent_type_id  RENAME TO idx_sessions_personality_id;
