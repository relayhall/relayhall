-- 075_project_charter.sql
-- RH-CHARTER (task f2735f1b): the Charter as a first-class object.
--
-- A Charter is a Project's authority index (vocabulary report, declared
-- amendment A9): it locates every governing agreement with status and
-- precedence, carries the standing directives, and asserts nothing new —
-- conflicts always resolve to the underlying document. One Charter per
-- Project; owner-plane writes; versioned so changes are attributable and
-- reversible; included automatically in every compiled Brief.
--
-- Schema only. No seed rows: a deployment's Charter content is created
-- through the API/CLI surface at that deployment. Shipping any concrete
-- Charter text in a repo migration would embed deployment-specific content
-- in the public tree, which the residue contract exists to prevent.
--
-- Versioning model: project_charters holds the head (current content, a
-- monotonic version counter, and the optimistic-concurrency revision UUID
-- per the 067 discipline); project_charter_versions is the append-only
-- record of every content state with attribution, so any prior version can
-- be read back and restored by an ordinary head write.
--
-- Fresh-replay doctrine: database/init.sql is untouched; a fresh install
-- reaches this schema via the migration chain, and this file is idempotent
-- (CREATE IF NOT EXISTS throughout) so re-running it is a no-op.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS project_charters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (length(content) > 0),
  content_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  updated_by_principal_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_charter_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charter_id UUID NOT NULL REFERENCES project_charters(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  content TEXT NOT NULL CHECK (length(content) > 0),
  content_hash TEXT NOT NULL,
  actor_principal_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (charter_id, version)
);

CREATE INDEX IF NOT EXISTS idx_project_charters_project
  ON project_charters(project_id);

CREATE INDEX IF NOT EXISTS idx_project_charter_versions_charter
  ON project_charter_versions(charter_id, version DESC);
