-- RelayHall canonical Project Resource contract (task 47ef04a2, RH-P1.5f).
--
-- Owner-approved contract: reports 21a04c23 + c1895aa8 (schema 28b76f54);
-- review 6fd3b9e0 findings 1 and 3 applied. Adds Project revisions, the
-- typed project_resources table (exactly four kinds), the installation-keyed
-- migration ledger, the per-Project cutover record, and the idempotency
-- store for the atomic kind-replacement transaction.
--
-- Forward and non-destructive: the legacy projects.resources /
-- projects.tool_instructions JSONB columns, projects.source_dir /
-- projects.nfs_dir and project_links rows are all byte-preserved as
-- compatibility-held data.
--
-- Two-phase inside one atomic statement set (the runner executes this file
-- as a single implicit transaction): PLAN builds the complete inventory with
-- source hashes and dispositions; a DRIFT gate fails the whole migration
-- closed if any previously ledgered source byte changed; APPLY creates
-- canonical rows and ledger entries; CUTOVER records, per Project, the
-- locked source revision, the source-byte hash and the item counts. A rerun
-- against unchanged sources is a complete no-op; a rerun after source drift
-- raises and leaves the database untouched.
--
-- Operational gate (contract 21a04c23 §8, not expressible in SQL): the
-- deployment runbook must produce and verify a restore-capable database
-- backup before executing this migration on any environment.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Project revisions (contract §2.1): opaque, rotated on every mutation.
-- ---------------------------------------------------------------------------

ALTER TABLE projects ADD COLUMN IF NOT EXISTS revision UUID NOT NULL DEFAULT gen_random_uuid();

-- ---------------------------------------------------------------------------
-- Installation identity (single row) — the ledger key that distinguishes
-- this installation's migration history from imported/restored data.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS relayhall_installation (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO relayhall_installation (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Canonical typed Resources
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS project_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('repository', 'environment', 'workspace', 'reference')),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  normalized_name TEXT NOT NULL,
  description TEXT CHECK (description IS NULL OR char_length(description) <= 1000),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  agent_visibility TEXT NOT NULL DEFAULT 'hidden' CHECK (agent_visibility IN ('hidden', 'available')),
  export_policy TEXT NOT NULL DEFAULT 'installation-only' CHECK (export_policy IN ('installation-only', 'portable')),
  details JSONB NOT NULL,
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  migration_provenance JSONB,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- state and archived_at move together, always
  CONSTRAINT project_resources_state_archived_at CHECK (
    (state = 'active' AND archived_at IS NULL) OR (state = 'archived' AND archived_at IS NOT NULL)
  ),
  -- Workspace is never portable (contract 28b76f54)
  CONSTRAINT project_resources_workspace_installation_only CHECK (
    NOT (kind = 'workspace' AND export_policy = 'portable')
  )
);

-- Uniqueness is an ACTIVE-only property: any number of archived rows may keep
-- the same tuple (that is how kind replacement retains history).
CREATE UNIQUE INDEX IF NOT EXISTS project_resources_active_name_uq
  ON project_resources (project_id, kind, normalized_name)
  WHERE state = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS project_resources_active_primary_repository_uq
  ON project_resources (project_id)
  WHERE state = 'active' AND kind = 'repository' AND details->>'role' = 'primary';

CREATE INDEX IF NOT EXISTS project_resources_project_idx
  ON project_resources (project_id, state, kind);

COMMENT ON TABLE project_resources IS
  'Canonical typed Project Resources (contract c1895aa8): repository | environment | workspace | reference. Values are quoted untrusted data and grant no capability.';

-- ---------------------------------------------------------------------------
-- Migration-provenance ledger (contract 21a04c23 §7.2): keyed by
-- installation, Project, source surface and source-locator digest.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS project_resource_migration_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id),
  source_surface TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  source_locator_digest TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('mapped', 'held')),
  reason TEXT,
  resource_id UUID REFERENCES project_resources(id),
  migration_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_resource_migration_items_uq
    UNIQUE (installation_id, project_id, source_surface, source_locator_digest, migration_version)
);

COMMENT ON TABLE project_resource_migration_items IS
  'Provenance ledger for the legacy->canonical Resource migration: every legacy value is either mapped (with the canonical resource id) or held (with a reason). Original legacy bytes are never modified. A rerun after source-byte drift fails closed.';

-- Per-Project cutover record: which source bytes, at which Project revision,
-- were converted by which migration version. Presence = conversion complete.
CREATE TABLE IF NOT EXISTS project_resource_migration_runs (
  installation_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id),
  migration_version INTEGER NOT NULL,
  project_revision UUID NOT NULL,
  source_sha256 TEXT NOT NULL,
  planned_items INTEGER NOT NULL,
  mapped_items INTEGER NOT NULL,
  held_items INTEGER NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (installation_id, project_id, migration_version)
);

COMMENT ON TABLE project_resource_migration_runs IS
  'Cutover markers: one row per converted Project per migration version, binding the locked Project revision and the exact source-byte hash the plan was computed from.';

-- ---------------------------------------------------------------------------
-- Idempotency store for the atomic kind-replacement transaction (c1895aa8 §2.3)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS project_resource_replacements (
  caller TEXT NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL,
  replaced_resource_id UUID NOT NULL REFERENCES project_resources(id),
  replacement_resource_id UUID NOT NULL REFERENCES project_resources(id),
  -- The immutable 201 response pair, exactly as first committed: a replay
  -- returns THIS, not the rows' current state (review 666f69f2 finding 1).
  response_snapshot JSONB NOT NULL,
  request_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (caller, project_id, idempotency_key)
);

COMMENT ON TABLE project_resource_replacements IS
  'Caller/project-scoped idempotency records for POST .../resources/{id}/replace. Retention is unbounded in the private phase, which exceeds any client retry window; If-Match still binds the exact old revision regardless.';

-- ---------------------------------------------------------------------------
-- Deterministic legacy conversion (contract 21a04c23 §7.3–7.4):
-- PLAN -> DRIFT GATE -> APPLY -> CUTOVER, all inside this file's implicit
-- transaction. A legacy value maps only when the legacy structure itself
-- provides a natural name and the value passes the conservative validity
-- checks; everything else is held with a reason. Mapped resources take the
-- table defaults: hidden and installation-only. Uniqueness collisions fail
-- closed to held (never auto-renamed).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_installation UUID;
  proj RECORD;
  link RECORD;
  item RECORD;
  run RECORD;
  v_url TEXT;
  v_path TEXT;
  v_key TEXT;
  v_stage TEXT;
  v_category TEXT;
  v_resource_id UUID;
  v_mapped INTEGER;
  v_held INTEGER;
  v_planned INTEGER;
  v_project_source_hash TEXT;
  http_url_ok CONSTANT TEXT := '^https?://[^@/\s]+(/[^\s]*)?$';
  git_url_ok CONSTANT TEXT := '^(https://[^@/\s]+(/[^\s]*)?|ssh://[^\s]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+)$';
BEGIN
  -- Atomic source snapshot (review a4ff69b7 finding 1): SHARE locks block
  -- every concurrent writer on the legacy sources for the remainder of this
  -- transaction, so PLAN, DRIFT GATE, APPLY and CUTOVER all observe the same
  -- bytes. (The ALTER above already holds projects exclusively; the explicit
  -- locks make the invariant independent of statement order.)
  LOCK TABLE projects IN SHARE MODE;
  LOCK TABLE project_links IN SHARE MODE;

  SELECT id INTO v_installation FROM relayhall_installation;

  -- ── PLAN ────────────────────────────────────────────────────────────────
  -- The complete inventory, computed before any canonical row is written.
  CREATE TEMP TABLE migration_plan (
    project_id UUID NOT NULL,
    source_surface TEXT NOT NULL,
    source_locator TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    disposition TEXT NOT NULL,           -- 'map' | 'held'
    reason TEXT,
    kind TEXT,
    name TEXT,
    details JSONB
  ) ON COMMIT DROP;

  FOR proj IN SELECT id, resources, tool_instructions, source_dir, nfs_dir FROM projects LOOP

    -- A present but non-object legacy resources value (e.g. JSON null or a
    -- scalar) cannot be traversed: hold the whole container deterministically
    -- (review 5d229bf1 finding 2) and skip the per-key scans.
    IF proj.resources IS NOT NULL AND jsonb_typeof(proj.resources) != 'object' THEN
      INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'resources',
        encode(digest(COALESCE(proj.resources #>> '{}', 'null'), 'sha256'), 'hex'),
        'held', 'container failed validation', NULL, NULL, NULL);
    END IF;

    -- A present known parent container that is not an object (JSON null or a
    -- scalar) is itself held (review 09c90755 finding 1): its leaves cannot
    -- be inventoried, so the container is the deterministic source item.
    FOR v_key IN SELECT * FROM (VALUES ('repositories'), ('environments'), ('localPaths'), ('notebooks')) AS containers(k) LOOP
      IF proj.resources->v_key IS NOT NULL AND jsonb_typeof(proj.resources->v_key) != 'object' THEN
        INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', v_key,
          encode(digest(COALESCE(proj.resources->v_key #>> '{}', 'null'), 'sha256'), 'hex'),
          'held', 'container failed validation', NULL, NULL, NULL);
      END IF;
    END LOOP;

    -- A. repositories.main -> repository (role primary, name 'main').
    -- `->` distinguishes ABSENT (SQL NULL) from PRESENT JSON null (jsonb
    -- 'null'); a present null is ledgered, never silently skipped.
    IF proj.resources->'repositories'->'main' IS NOT NULL THEN
      v_url := proj.resources->'repositories'->>'main';
      IF v_url IS NULL THEN
        INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'repositories.main',
          encode(digest('null', 'sha256'), 'hex'), 'held', 'null value', NULL, NULL, NULL);
      ELSIF v_url ~ git_url_ok THEN
        INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'repositories.main',
          encode(digest(v_url, 'sha256'), 'hex'), 'map', NULL, 'repository', 'main',
          jsonb_build_object('url', v_url, 'role', 'primary', 'defaultBranch', NULL));
      ELSE
        INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'repositories.main',
          encode(digest(v_url, 'sha256'), 'hex'), 'held', 'url failed validation', NULL, NULL, NULL);
      END IF;
    END IF;

    -- B. repositories.additional[] -> held (no natural per-item name exists);
    --    a malformed non-array container is itself held (666f69f2 #6).
    IF jsonb_typeof(proj.resources->'repositories'->'additional') = 'array' THEN
      FOR v_key IN SELECT (idx - 1)::TEXT FROM jsonb_array_length(proj.resources->'repositories'->'additional') len, generate_series(1, len) idx LOOP
        v_url := proj.resources->'repositories'->'additional'->>v_key::INTEGER;
        INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'repositories.additional[' || v_key || ']',
          encode(digest(COALESCE(v_url, 'null'), 'sha256'), 'hex'), 'held',
          CASE WHEN v_url IS NULL THEN 'null value' ELSE 'no natural name in legacy structure' END,
          NULL, NULL, NULL);
      END LOOP;
    ELSIF proj.resources->'repositories'->'additional' IS NOT NULL THEN
      INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'repositories.additional',
        encode(digest(COALESCE(proj.resources->'repositories'->'additional' #>> '{}', 'null'), 'sha256'), 'hex'),
        'held', 'container failed validation', NULL, NULL, NULL);
    END IF;

    -- C. environments.{production,development,staging} -> environment (stage = key)
    FOR v_key, v_stage IN SELECT * FROM (VALUES ('production', 'production'), ('development', 'development'), ('staging', 'staging')) AS stages(k, s) LOOP
      IF proj.resources->'environments'->v_key IS NOT NULL THEN
        v_url := proj.resources->'environments'->>v_key;
        IF v_url IS NULL THEN
          INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'environments.' || v_key,
            encode(digest('null', 'sha256'), 'hex'), 'held', 'null value', NULL, NULL, NULL);
        ELSIF v_url ~ http_url_ok THEN
          INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'environments.' || v_key,
            encode(digest(v_url, 'sha256'), 'hex'), 'map', NULL, 'environment', v_key,
            jsonb_build_object('url', v_url, 'stage', v_stage));
        ELSE
          INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'environments.' || v_key,
            encode(digest(v_url, 'sha256'), 'hex'), 'held', 'url failed validation', NULL, NULL, NULL);
        END IF;
      END IF;
    END LOOP;

    -- D. localPaths.{nfsRoot,ssdBuild,dockerCompose} -> workspace (purpose other)
    FOR v_key IN SELECT * FROM (VALUES ('nfsRoot'), ('ssdBuild'), ('dockerCompose')) AS keys(k) LOOP
      IF proj.resources->'localPaths'->v_key IS NOT NULL THEN
        v_path := proj.resources->'localPaths'->>v_key;
        IF v_path IS NULL THEN
          INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'localPaths.' || v_key,
            encode(digest('null', 'sha256'), 'hex'), 'held', 'null value', NULL, NULL, NULL);
        ELSIF v_path LIKE '/%' AND v_path NOT LIKE '%..%' THEN
          INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'localPaths.' || v_key,
            encode(digest(v_path, 'sha256'), 'hex'), 'map', NULL, 'workspace', v_key,
            jsonb_build_object('path', v_path, 'purpose', 'other'));
        ELSE
          INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'localPaths.' || v_key,
            encode(digest(v_path, 'sha256'), 'hex'), 'held', 'path failed validation', NULL, NULL, NULL);
        END IF;
      END IF;
    END LOOP;

    -- E. notebooks.{documentation,research}: the URL may map to a reference;
    --    the remaining notebook configuration BODY is always separately held
    --    (review 6fd3b9e0 finding 3).
    FOR v_key IN SELECT * FROM (VALUES ('documentation'), ('research')) AS keys(k) LOOP
      IF proj.resources->'notebooks'->v_key IS NOT NULL THEN
        IF proj.resources->'notebooks'->v_key->'url' IS NOT NULL AND proj.resources->'notebooks'->v_key->>'url' IS NULL THEN
          -- present JSON null URL: the URL is its own source item and is held
          INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'notebooks.' || v_key || '.url',
            encode(digest('null', 'sha256'), 'hex'), 'held', 'null value', NULL, NULL, NULL);
        END IF;
        v_url := proj.resources->'notebooks'->v_key->>'url';
        IF v_url IS NOT NULL AND v_url ~ http_url_ok THEN
          INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'notebooks.' || v_key || '.url',
            encode(digest(v_url, 'sha256'), 'hex'), 'map', NULL, 'reference', v_key,
            jsonb_build_object('url', v_url, 'category', v_key));
        ELSIF v_url IS NOT NULL THEN
          INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'notebooks.' || v_key || '.url',
            encode(digest(v_url, 'sha256'), 'hex'), 'held', 'url failed validation', NULL, NULL, NULL);
        END IF;
        INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'notebooks.' || v_key || '.config',
          encode(digest(COALESCE(proj.resources->'notebooks'->v_key #>> '{}', 'null'), 'sha256'), 'hex'),
          'held', 'notebook configuration is compatibility-held', NULL, NULL, NULL);
      END IF;
    END LOOP;

    -- F. notebooks.additional[] -> held (configuration entries); a malformed
    --    non-array container is itself held (666f69f2 #6).
    IF jsonb_typeof(proj.resources->'notebooks'->'additional') = 'array' THEN
      FOR v_key IN SELECT (idx - 1)::TEXT FROM jsonb_array_length(proj.resources->'notebooks'->'additional') len, generate_series(1, len) idx LOOP
        INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'notebooks.additional[' || v_key || ']',
          encode(digest(COALESCE(proj.resources->'notebooks'->'additional'->>v_key::INTEGER, ''), 'sha256'), 'hex'),
          'held', 'notebook configuration is compatibility-held', NULL, NULL, NULL);
      END LOOP;
    ELSIF proj.resources->'notebooks'->'additional' IS NOT NULL THEN
      INSERT INTO migration_plan VALUES (proj.id, 'projects.resources', 'notebooks.additional',
        encode(digest(COALESCE(proj.resources->'notebooks'->'additional' #>> '{}', 'null'), 'sha256'), 'hex'),
        'held', 'container failed validation', NULL, NULL, NULL);
    END IF;

    -- G. tool_instructions -> always held; instructions never become Resources.
    IF proj.tool_instructions IS NOT NULL THEN
      INSERT INTO migration_plan VALUES (proj.id, 'projects.tool_instructions', 'tool_instructions',
        encode(digest(proj.tool_instructions::TEXT, 'sha256'), 'hex'),
        'held', 'instructions never become resources', NULL, NULL, NULL);
    END IF;

    -- H. source_dir / nfs_dir -> workspace when a valid absolute path
    IF proj.source_dir IS NOT NULL THEN
      IF proj.source_dir LIKE '/%' AND proj.source_dir NOT LIKE '%..%' THEN
        INSERT INTO migration_plan VALUES (proj.id, 'projects.source_dir', 'source_dir',
          encode(digest(proj.source_dir, 'sha256'), 'hex'), 'map', NULL, 'workspace', 'source_dir',
          jsonb_build_object('path', proj.source_dir, 'purpose', 'source'));
      ELSE
        INSERT INTO migration_plan VALUES (proj.id, 'projects.source_dir', 'source_dir',
          encode(digest(proj.source_dir, 'sha256'), 'hex'), 'held', 'path failed validation', NULL, NULL, NULL);
      END IF;
    END IF;

    IF proj.nfs_dir IS NOT NULL THEN
      IF proj.nfs_dir LIKE '/%' AND proj.nfs_dir NOT LIKE '%..%' THEN
        INSERT INTO migration_plan VALUES (proj.id, 'projects.nfs_dir', 'nfs_dir',
          encode(digest(proj.nfs_dir, 'sha256'), 'hex'), 'map', NULL, 'workspace', 'nfs_dir',
          jsonb_build_object('path', proj.nfs_dir, 'purpose', 'data'));
      ELSE
        INSERT INTO migration_plan VALUES (proj.id, 'projects.nfs_dir', 'nfs_dir',
          encode(digest(proj.nfs_dir, 'sha256'), 'hex'), 'held', 'path failed validation', NULL, NULL, NULL);
      END IF;
    END IF;
  END LOOP;

  -- I. project_links -> typed by link type/category (title is the natural name)
  FOR link IN SELECT * FROM project_links LOOP
    v_key := NULLIF(TRIM(link.title), '');
    -- The item hash binds EVERY field the mapping consumes (title, type,
    -- category, url) so changing any of them after ledgering is drift
    -- (review 73df8efe finding 2).
    v_url := COALESCE(link.title, '') || '|' || COALESCE(link.type, '') || '|' || COALESCE(link.category, '') || '|' || COALESCE(link.url, '');
    IF v_key IS NULL OR char_length(v_key) > 120 THEN
      INSERT INTO migration_plan VALUES (link.project_id, 'project_links', link.id::TEXT,
        encode(digest(v_url, 'sha256'), 'hex'), 'held', 'title unusable as a name', NULL, NULL, NULL);
    ELSIF link.type = 'git' AND link.url ~ git_url_ok THEN
      INSERT INTO migration_plan VALUES (link.project_id, 'project_links', link.id::TEXT,
        encode(digest(v_url, 'sha256'), 'hex'), 'map', NULL, 'repository', v_key,
        jsonb_build_object('url', link.url, 'role', 'additional', 'defaultBranch', NULL));
    ELSIF link.type IN ('doc', 'url', 'api', 'project', 'dashboard', 'notebook') AND link.url ~ http_url_ok THEN
      v_category := CASE
        WHEN link.category = 'documentation' THEN 'documentation'
        WHEN link.category = 'research' THEN 'research'
        WHEN link.category = 'tool' THEN 'tool'
        WHEN link.type = 'doc' THEN 'documentation'
        ELSE 'other'
      END;
      INSERT INTO migration_plan VALUES (link.project_id, 'project_links', link.id::TEXT,
        encode(digest(v_url, 'sha256'), 'hex'), 'map', NULL, 'reference', v_key,
        jsonb_build_object('url', link.url, 'category', v_category));
    ELSE
      INSERT INTO migration_plan VALUES (link.project_id, 'project_links', link.id::TEXT,
        encode(digest(v_url, 'sha256'), 'hex'), 'held', 'type or url not deterministically mappable', NULL, NULL, NULL);
    END IF;
  END LOOP;

  -- ── DRIFT GATE ──────────────────────────────────────────────────────────
  -- Fail the entire migration closed if any previously ledgered source byte
  -- changed, or if a completed Project's overall source hash no longer
  -- matches its cutover record. Same-bytes reruns are complete no-ops.
  FOR item IN
    SELECT p.project_id, p.source_surface, p.source_locator, p.source_sha256,
           l.source_sha256 AS ledgered_sha256
    FROM migration_plan p
    JOIN project_resource_migration_items l
      ON l.installation_id = v_installation
     AND l.project_id = p.project_id
     AND l.source_surface = p.source_surface
     AND l.source_locator_digest = encode(digest(p.source_locator, 'sha256'), 'hex')
     AND l.migration_version = 1
    WHERE l.source_sha256 <> p.source_sha256
  LOOP
    RAISE EXCEPTION 'MIGRATION_SOURCE_DRIFT: % % changed since it was ledgered (was %, now %). Refusing to apply; investigate before rerunning.',
      item.source_surface, item.source_locator, item.ledgered_sha256, item.source_sha256;
  END LOOP;

  FOR run IN
    SELECT r.project_id, r.source_sha256 AS recorded,
           encode(digest(COALESCE(pr.resources::TEXT, '') || '|' || COALESCE(pr.tool_instructions::TEXT, '') || '|'
             || COALESCE(pr.source_dir, '') || '|' || COALESCE(pr.nfs_dir, '') || '|'
             || COALESCE((SELECT string_agg(l.id::TEXT || '|' || l.title || '|' || l.type || '|' || COALESCE(l.category, '') || '|' || COALESCE(l.url, ''), ';' ORDER BY l.id)
                          FROM project_links l WHERE l.project_id = pr.id), ''), 'sha256'), 'hex') AS current
    FROM project_resource_migration_runs r
    JOIN projects pr ON pr.id = r.project_id
    WHERE r.installation_id = v_installation AND r.migration_version = 1
  LOOP
    IF run.recorded <> run.current THEN
      RAISE EXCEPTION 'MIGRATION_SOURCE_DRIFT: project % legacy bytes changed after cutover (recorded %, now %). Refusing to apply.',
        run.project_id, run.recorded, run.current;
    END IF;
  END LOOP;

  -- ── APPLY ───────────────────────────────────────────────────────────────
  -- Only Projects without a cutover record are converted; per-Project
  -- all-or-nothing is inherited from the file-level transaction.
  FOR proj IN
    SELECT p.id, p.revision, p.resources, p.tool_instructions, p.source_dir, p.nfs_dir
    FROM projects p
    WHERE NOT EXISTS (
      SELECT 1 FROM project_resource_migration_runs r
      WHERE r.installation_id = v_installation AND r.project_id = p.id AND r.migration_version = 1
    )
  LOOP
    v_mapped := 0;
    v_held := 0;
    v_planned := 0;

    FOR item IN
      SELECT * FROM migration_plan mp WHERE mp.project_id = proj.id
      ORDER BY mp.source_surface, mp.source_locator
    LOOP
      v_planned := v_planned + 1;
      v_resource_id := NULL;

      IF item.disposition = 'map' THEN
        BEGIN
          INSERT INTO project_resources (project_id, kind, name, normalized_name, details, migration_provenance)
          VALUES (proj.id, item.kind, item.name, lower(item.name),
                  item.details,
                  jsonb_build_object('surface', item.source_surface, 'locator', item.source_locator, 'migrationVersion', 1))
          RETURNING id INTO v_resource_id;
          INSERT INTO project_resource_migration_items
            (installation_id, project_id, source_surface, source_locator, source_locator_digest, source_sha256, disposition, resource_id)
          VALUES (v_installation, proj.id, item.source_surface, item.source_locator,
                  encode(digest(item.source_locator, 'sha256'), 'hex'), item.source_sha256, 'mapped', v_resource_id);
          v_mapped := v_mapped + 1;
        EXCEPTION WHEN unique_violation THEN
          INSERT INTO project_resource_migration_items
            (installation_id, project_id, source_surface, source_locator, source_locator_digest, source_sha256, disposition, reason)
          VALUES (v_installation, proj.id, item.source_surface, item.source_locator,
                  encode(digest(item.source_locator, 'sha256'), 'hex'), item.source_sha256, 'held', 'active-uniqueness collision');
          v_held := v_held + 1;
        END;
      ELSE
        INSERT INTO project_resource_migration_items
          (installation_id, project_id, source_surface, source_locator, source_locator_digest, source_sha256, disposition, reason)
        VALUES (v_installation, proj.id, item.source_surface, item.source_locator,
                encode(digest(item.source_locator, 'sha256'), 'hex'), item.source_sha256, 'held', item.reason);
        v_held := v_held + 1;
      END IF;
    END LOOP;

    -- ── CUTOVER ─────────────────────────────────────────────────────────
    INSERT INTO project_resource_migration_runs
      (installation_id, project_id, migration_version, project_revision, source_sha256, planned_items, mapped_items, held_items)
    VALUES (v_installation, proj.id, 1, proj.revision,
            encode(digest(COALESCE(proj.resources::TEXT, '') || '|' || COALESCE(proj.tool_instructions::TEXT, '') || '|'
              || COALESCE(proj.source_dir, '') || '|' || COALESCE(proj.nfs_dir, '') || '|'
              || COALESCE((SELECT string_agg(l.id::TEXT || '|' || l.title || '|' || l.type || '|' || COALESCE(l.category, '') || '|' || COALESCE(l.url, ''), ';' ORDER BY l.id)
                           FROM project_links l WHERE l.project_id = proj.id), ''), 'sha256'), 'hex'),
            v_planned, v_mapped, v_held);
  END LOOP;
END $$;
