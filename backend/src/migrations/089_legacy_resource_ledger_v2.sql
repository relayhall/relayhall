-- 089_legacy_resource_ledger_v2.sql
--
-- Forward-only repair for the immutable 067 legacy Project Resource ledger.
-- Version 2 inventories source values that 067 could not represent precisely:
-- unknown object members, per-member notebook configuration, malformed notebook
-- entries, and JSON-null notebook array members. Legacy source bytes and
-- canonical Resources are never changed or recreated.

ALTER TABLE project_resource_migration_items
  ADD COLUMN IF NOT EXISTS superseded_by_migration_version INTEGER;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'project_resource_migration_items'::regclass
      AND conname = 'project_resource_migration_items_superseded_version_ck'
  ) THEN
    ALTER TABLE project_resource_migration_items
      ADD CONSTRAINT project_resource_migration_items_superseded_version_ck
      CHECK (
        superseded_by_migration_version IS NULL
        OR superseded_by_migration_version > migration_version
      );
  END IF;
END
$constraint$;

COMMENT ON COLUMN project_resource_migration_items.superseded_by_migration_version IS
  'A later ledger version replaced this provenance interpretation. The historical row remains immutable evidence but compatibility counts exclude it.';

DO $migration$
DECLARE
  v_installation UUID;
  proj RECORD;
  legacy RECORD;
  item RECORD;
  run RECORD;
  v_key TEXT;
  v_url TEXT;
  v_project_source_hash TEXT;
  v_planned INTEGER;
BEGIN
  -- Hold one source snapshot for PLAN, drift checks, supersession and receipt.
  LOCK TABLE projects IN SHARE MODE;
  LOCK TABLE project_links IN SHARE MODE;
  LOCK TABLE project_resource_migration_items IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE project_resource_migration_runs IN SHARE ROW EXCLUSIVE MODE;

  SELECT id INTO STRICT v_installation FROM relayhall_installation;

  CREATE TEMP TABLE legacy_ledger_v2_projects (
    project_id UUID PRIMARY KEY,
    project_revision UUID NOT NULL,
    source_sha256 TEXT NOT NULL
  ) ON COMMIT DROP;

  CREATE TEMP TABLE legacy_ledger_v2_plan (
    project_id UUID NOT NULL,
    source_surface TEXT NOT NULL,
    source_locator TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition = 'held'),
    reason TEXT NOT NULL,
    PRIMARY KEY (project_id, source_surface, source_locator)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE legacy_ledger_v2_supersessions (
    project_id UUID NOT NULL,
    source_surface TEXT NOT NULL,
    source_locator TEXT NOT NULL,
    PRIMARY KEY (project_id, source_surface, source_locator)
  ) ON COMMIT DROP;

  -- PLAN: calculate every project receipt and only the v2 delta. The source
  -- hash formula is byte-for-byte the 067 cutover formula so an existing v1
  -- receipt is a trustworthy drift anchor.
  FOR proj IN
    SELECT id, revision, resources, tool_instructions, source_dir, nfs_dir
    FROM projects
    ORDER BY id
  LOOP
    v_project_source_hash := encode(digest(
      COALESCE(proj.resources::TEXT, '') || '|' ||
      COALESCE(proj.tool_instructions::TEXT, '') || '|' ||
      COALESCE(proj.source_dir, '') || '|' ||
      COALESCE(proj.nfs_dir, '') || '|' ||
      COALESCE((
        SELECT string_agg(
          l.id::TEXT || '|' || l.title || '|' || l.type || '|' ||
          COALESCE(l.category, '') || '|' || COALESCE(l.url, ''),
          ';' ORDER BY l.id
        )
        FROM project_links l
        WHERE l.project_id = proj.id
      ), ''),
      'sha256'
    ), 'hex');

    INSERT INTO legacy_ledger_v2_projects
      (project_id, project_revision, source_sha256)
    VALUES (proj.id, proj.revision, v_project_source_hash);

    -- A scalar/array/null root was already held atomically by 067. Object
    -- members can be enumerated without interpreting their values.
    IF jsonb_typeof(proj.resources) = 'object' THEN
      FOR legacy IN
        SELECT key, value
        FROM jsonb_each(proj.resources)
        WHERE key NOT IN ('repositories', 'environments', 'localPaths', 'notebooks')
        ORDER BY key
      LOOP
        INSERT INTO legacy_ledger_v2_plan VALUES (
          proj.id,
          'projects.resources',
          'unknown:' || jsonb_build_array(legacy.key)::TEXT,
          encode(digest(legacy.value::TEXT, 'sha256'), 'hex'),
          'held',
          'unknown legacy key'
        );
      END LOOP;

      IF jsonb_typeof(proj.resources->'repositories') = 'object' THEN
        FOR legacy IN
          SELECT key, value FROM jsonb_each(proj.resources->'repositories')
          WHERE key NOT IN ('main', 'additional') ORDER BY key
        LOOP
          INSERT INTO legacy_ledger_v2_plan VALUES (
            proj.id, 'projects.resources',
            'unknown:' || jsonb_build_array('repositories', legacy.key)::TEXT,
            encode(digest(legacy.value::TEXT, 'sha256'), 'hex'),
            'held', 'unknown legacy key'
          );
        END LOOP;
      END IF;

      IF jsonb_typeof(proj.resources->'environments') = 'object' THEN
        FOR legacy IN
          SELECT key, value FROM jsonb_each(proj.resources->'environments')
          WHERE key NOT IN ('production', 'development', 'staging') ORDER BY key
        LOOP
          INSERT INTO legacy_ledger_v2_plan VALUES (
            proj.id, 'projects.resources',
            'unknown:' || jsonb_build_array('environments', legacy.key)::TEXT,
            encode(digest(legacy.value::TEXT, 'sha256'), 'hex'),
            'held', 'unknown legacy key'
          );
        END LOOP;
      END IF;

      IF jsonb_typeof(proj.resources->'localPaths') = 'object' THEN
        FOR legacy IN
          SELECT key, value FROM jsonb_each(proj.resources->'localPaths')
          WHERE key NOT IN ('nfsRoot', 'ssdBuild', 'dockerCompose') ORDER BY key
        LOOP
          INSERT INTO legacy_ledger_v2_plan VALUES (
            proj.id, 'projects.resources',
            'unknown:' || jsonb_build_array('localPaths', legacy.key)::TEXT,
            encode(digest(legacy.value::TEXT, 'sha256'), 'hex'),
            'held', 'unknown legacy key'
          );
        END LOOP;
      END IF;

      IF jsonb_typeof(proj.resources->'notebooks') = 'object' THEN
        FOR legacy IN
          SELECT key, value FROM jsonb_each(proj.resources->'notebooks')
          WHERE key NOT IN ('documentation', 'research', 'additional') ORDER BY key
        LOOP
          INSERT INTO legacy_ledger_v2_plan VALUES (
            proj.id, 'projects.resources',
            'unknown:' || jsonb_build_array('notebooks', legacy.key)::TEXT,
            encode(digest(legacy.value::TEXT, 'sha256'), 'hex'),
            'held', 'unknown legacy key'
          );
        END LOOP;

        -- 067 used one aggregate .config row for each named notebook. V2
        -- retains that row as provenance, marks it superseded, and records
        -- each caller-written member independently. A malformed entry is one
        -- held container and is never traversed.
        FOR v_key IN
          SELECT * FROM (VALUES ('documentation'), ('research')) AS keys(k)
        LOOP
          IF proj.resources->'notebooks' ? v_key THEN
            INSERT INTO legacy_ledger_v2_supersessions VALUES (
              proj.id, 'projects.resources', 'notebooks.' || v_key || '.config'
            );

            IF jsonb_typeof(proj.resources->'notebooks'->v_key) != 'object' THEN
              INSERT INTO legacy_ledger_v2_plan VALUES (
                proj.id, 'projects.resources', 'notebooks.' || v_key,
                encode(digest((proj.resources->'notebooks'->v_key)::TEXT, 'sha256'), 'hex'),
                'held', 'container failed validation'
              );
            ELSE
              FOR legacy IN
                SELECT key, value
                FROM jsonb_each(proj.resources->'notebooks'->v_key)
                WHERE key <> 'url'
                ORDER BY key
              LOOP
                INSERT INTO legacy_ledger_v2_plan VALUES (
                  proj.id,
                  'projects.resources',
                  'notebooks.' || v_key || '.config:' || jsonb_build_array(legacy.key)::TEXT,
                  encode(digest(legacy.value::TEXT, 'sha256'), 'hex'),
                  'held',
                  'notebook configuration is compatibility-held'
                );
              END LOOP;
            END IF;
          END IF;
        END LOOP;

        -- 067 hashed JSON null as the empty string and assigned the generic
        -- notebook-config reason. Only null members need replacement rows;
        -- non-null v1 rows remain the active provenance interpretation.
        IF jsonb_typeof(proj.resources->'notebooks'->'additional') = 'array' THEN
          FOR v_key IN
            SELECT (idx - 1)::TEXT
            FROM jsonb_array_length(proj.resources->'notebooks'->'additional') len,
                 generate_series(1, len) idx
          LOOP
            v_url := proj.resources->'notebooks'->'additional'->>v_key::INTEGER;
            IF v_url IS NULL THEN
              INSERT INTO legacy_ledger_v2_plan VALUES (
                proj.id,
                'projects.resources',
                'notebooks.additional[' || v_key || ']',
                encode(digest('null', 'sha256'), 'hex'),
                'held',
                'null value'
              );
              INSERT INTO legacy_ledger_v2_supersessions VALUES (
                proj.id,
                'projects.resources',
                'notebooks.additional[' || v_key || ']'
              );
            END IF;
          END LOOP;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- DRIFT GATE 1: an installation already cut over by 067 must still expose
  -- the exact source snapshot that v1 recorded.
  FOR run IN
    SELECT r.project_id, r.source_sha256 AS recorded, p.source_sha256 AS current
    FROM project_resource_migration_runs r
    JOIN legacy_ledger_v2_projects p ON p.project_id = r.project_id
    WHERE r.installation_id = v_installation
      AND r.migration_version = 1
      AND r.source_sha256 <> p.source_sha256
  LOOP
    RAISE EXCEPTION 'MIGRATION_SOURCE_DRIFT: project % legacy bytes changed after v1 cutover (recorded %, now %). Refusing v2 repair.',
      run.project_id, run.recorded, run.current;
  END LOOP;

  -- DRIFT GATE 2: direct raw replay validates every existing v2 item before
  -- deciding that the completed v2 receipt makes the apply phase a no-op.
  FOR item IN
    SELECT p.project_id, p.source_surface, p.source_locator,
           l.source_sha256 AS recorded, p.source_sha256 AS current
    FROM legacy_ledger_v2_plan p
    JOIN project_resource_migration_items l
      ON l.installation_id = v_installation
     AND l.project_id = p.project_id
     AND l.source_surface = p.source_surface
     AND l.source_locator_digest = encode(digest(p.source_locator, 'sha256'), 'hex')
     AND l.migration_version = 2
    WHERE l.source_sha256 <> p.source_sha256
  LOOP
    RAISE EXCEPTION 'MIGRATION_SOURCE_DRIFT: % % changed since v2 ledgering (recorded %, now %). Refusing replay.',
      item.source_surface, item.source_locator, item.recorded, item.current;
  END LOOP;

  -- DRIFT GATE 3: removed or newly-added source items change the complete
  -- project digest even when no surviving per-item locator can be joined.
  FOR run IN
    SELECT r.project_id, r.source_sha256 AS recorded, p.source_sha256 AS current
    FROM project_resource_migration_runs r
    JOIN legacy_ledger_v2_projects p ON p.project_id = r.project_id
    WHERE r.installation_id = v_installation
      AND r.migration_version = 2
      AND r.source_sha256 <> p.source_sha256
  LOOP
    RAISE EXCEPTION 'MIGRATION_SOURCE_DRIFT: project % legacy bytes changed after v2 cutover (recorded %, now %). Refusing replay.',
      run.project_id, run.recorded, run.current;
  END LOOP;

  -- APPLY + CUTOVER: v2 is ledger-only. It never inserts or updates a
  -- canonical Project Resource and never changes the preserved source bytes.
  FOR proj IN
    SELECT p.id, p.revision, h.source_sha256
    FROM projects p
    JOIN legacy_ledger_v2_projects h ON h.project_id = p.id
    WHERE NOT EXISTS (
      SELECT 1
      FROM project_resource_migration_runs r
      WHERE r.installation_id = v_installation
        AND r.project_id = p.id
        AND r.migration_version = 2
    )
    ORDER BY p.id
  LOOP
    v_planned := 0;

    FOR item IN
      SELECT * FROM legacy_ledger_v2_plan p
      WHERE p.project_id = proj.id
      ORDER BY p.source_surface, p.source_locator
    LOOP
      INSERT INTO project_resource_migration_items
        (installation_id, project_id, source_surface, source_locator,
         source_locator_digest, source_sha256, disposition, reason,
         migration_version)
      VALUES
        (v_installation, proj.id, item.source_surface, item.source_locator,
         encode(digest(item.source_locator, 'sha256'), 'hex'), item.source_sha256,
         'held', item.reason, 2);
      v_planned := v_planned + 1;
    END LOOP;

    -- Preserve v1 evidence in place while excluding only interpretations
    -- replaced by v2 from management compatibility counts.
    UPDATE project_resource_migration_items old
    SET superseded_by_migration_version = 2
    FROM legacy_ledger_v2_supersessions s
    WHERE s.project_id = proj.id
      AND old.installation_id = v_installation
      AND old.project_id = s.project_id
      AND old.source_surface = s.source_surface
      AND old.source_locator_digest = encode(digest(s.source_locator, 'sha256'), 'hex')
      AND old.migration_version = 1
      AND old.superseded_by_migration_version IS NULL;

    INSERT INTO project_resource_migration_runs
      (installation_id, project_id, migration_version, project_revision,
       source_sha256, planned_items, mapped_items, held_items)
    VALUES
      (v_installation, proj.id, 2, proj.revision, proj.source_sha256,
       v_planned, 0, v_planned);
  END LOOP;
END
$migration$;
