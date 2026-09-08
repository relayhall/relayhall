-- RelayHall Skill/Tool split (task daefcdf6, RH-VOCAB.3; D-2, D-3, amendments A1, A14).
--
-- The instruction registry takes the ratified word: every row in the old
-- tools table is instruction text, so the registry becomes Skills; "Tool"
-- is reserved for the Phase-2 concept (one callable operation a Service
-- exposes). In-place guarded renames in the 069 style — idempotent against
-- both an upgrade database (tools exists) and a fresh install (init.sql
-- deliberately keeps the pre-rename names so historical migrations 065/070/
-- 071, which UPDATE tools, replay correctly; this file then renames at the
-- end of the chain).
--
-- DATA RESET (A14.4 — owner-ruled 2026-08-08, deliberately destructive and
-- licensed by that ruling alone): every pre-existing registry row is deleted
-- — the legacy estate rows seeded by pre-baseline migrations 011/012/016 on
-- upgraded databases AND the old fresh-install basics — and the curated
-- RelayHall basics below are seeded in their place. Estate skills migrate
-- element-by-element, with review, at the ClawBoard cutover; never via repo
-- migrations. project_skills links cascade with the deleted rows.

-- 1. Table and column renames (guarded).
DO $$
BEGIN
  IF to_regclass('public.tools') IS NOT NULL THEN
    ALTER TABLE tools RENAME TO skills;
  END IF;

  IF to_regclass('public.project_tools') IS NOT NULL THEN
    ALTER TABLE project_tools RENAME TO project_skills;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'project_skills' AND column_name = 'tool_id') THEN
    ALTER TABLE project_skills RENAME COLUMN tool_id TO skill_id;
  END IF;
END $$;

-- 2. Constraint renames (guarded individually, 069 pattern).
DO $$
DECLARE
  pair RECORD;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('skills',         'tools_pkey',                            'skills_pkey'),
      ('skills',         'tools_name_key',                        'skills_name_key'),
      ('project_skills', 'project_tools_pkey',                    'project_skills_pkey'),
      ('project_skills', 'project_tools_project_id_tool_id_key',  'project_skills_project_id_skill_id_key'),
      ('project_skills', 'project_tools_project_id_fkey',         'project_skills_project_id_fkey'),
      ('project_skills', 'project_tools_tool_id_fkey',            'project_skills_skill_id_fkey')
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

-- 3. Index renames (no-ops where absent).
ALTER INDEX IF EXISTS idx_tools_name              RENAME TO idx_skills_name;
ALTER INDEX IF EXISTS idx_tools_category          RENAME TO idx_skills_category;
ALTER INDEX IF EXISTS idx_tools_tags              RENAME TO idx_skills_tags;
ALTER INDEX IF EXISTS idx_tools_is_global         RENAME TO idx_skills_is_global;
ALTER INDEX IF EXISTS idx_project_tools_project_id RENAME TO idx_project_skills_project_id;
ALTER INDEX IF EXISTS idx_project_tools_tool_id    RENAME TO idx_project_skills_skill_id;

-- 4. Comments: ALTER TABLE RENAME carries comments along but their text still
--    describes tools; re-state them in the ratified vocabulary.
COMMENT ON TABLE public.skills IS 'Registry of skills (instruction text) served to agents and projects';
COMMENT ON COLUMN public.skills.config IS 'JSONB config - encrypted at app level for sensitive values';
COMMENT ON COLUMN public.skills.tags IS 'Array of tags for filtering and categorization';
COMMENT ON COLUMN public.skills.is_global IS 'Global skills are available to all projects';
COMMENT ON COLUMN public.skills.version IS 'Auto-incremented on each update';
COMMENT ON TABLE public.project_skills IS 'Junction table linking skills to projects with optional instruction overrides';
COMMENT ON COLUMN public.project_skills.override_instructions IS 'When set, replaces the skill base usage_instructions for this project';

-- 5. Registry data reset + curated basics (A14.4, A14.5).
DELETE FROM skills;

INSERT INTO skills (id, name, category, description, usage_instructions, tags, is_global, version)
VALUES
  (
    gen_random_uuid(),
    'task-management',
    'workflow',
    'Manage tasks through the RelayHall API or CLI.',
    E'Use `relayhall list`, `relayhall get`, `relayhall create`, and `relayhall move` for the task lifecycle (states: ideas, todo, in-progress, review, stuck, completed, archived). Agents start a subtask, hand the task to review, and an independent Verifier approves or rejects it. RelayHall compiles a task Brief on request; it never executes an agent.',
    ARRAY['cli', 'tasks', 'workflow'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'project-management',
    'workflow',
    'Group related tasks, reports, links, and resources into projects.',
    E'Use `relayhall projects`, `relayhall project create`, and the project resource commands (four resource kinds: repository, environment, workspace, reference). Prefer stable URLs and deployment-neutral paths in shared project metadata. Archived projects are read-only.',
    ARRAY['cli', 'projects', 'workflow'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'report-management',
    'workflow',
    'Record durable knowledge as Reports and link them to tasks.',
    E'Substance goes into Reports; board text stays brief and references them. Use `relayhall report create`, `relayhall report get`, and `relayhall report list`, and link reports to their tasks. Archive a finished report rather than deleting it: archived reports stay readable and linkable but leave default lists.',
    ARRAY['cli', 'reports', 'knowledge'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'api-access',
    'automation',
    'Drive RelayHall through its authenticated REST and OpenAPI surfaces.',
    E'Fetch `GET /openapi.json` with an authenticated reader credential. Use principal-bound `rh_` keys with the narrowest required scopes (`<object>:<verb>`). Unmapped scoped-key routes fail closed to `root`.',
    ARRAY['api', 'openapi', 'automation', 'security'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'skill-management',
    'admin',
    'Manage the RelayHall skills registry.',
    E'Use `relayhall skill list`, `relayhall skill get <name>`, and `relayhall skill update`. Skills are instruction text served to agents; update the registry record instead of pasting instructions into project data. Global skills reach every project; project links can override per project.',
    ARRAY['admin', 'skills', 'registry'],
    TRUE,
    1
  );
