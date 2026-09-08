-- 079_phase_object.sql
-- RH-P2.4 (task 8be358d2): the Phase object — the grouping layer between
-- Project and Task (strategy 4e40f06f §2.3 as amended by vocabulary
-- b94dd86e A3/D-6; design report 32346910).
--
-- A Phase groups Tasks under one outcome. It is ordered within its Project
-- and MAY OVERLAP with other Phases — RelayHall's own falsification gate
-- deliberately runs parallel to the phase it checks, so a strictly
-- sequential model would encode a falsehood. `position` is therefore an
-- ordering hint, NOT a uniqueness constraint; reads order by
-- (position, created_at, id) so ties are still deterministic.
--
-- GOAL IS A PROPERTY, NEVER A TABLE (b94dd86e §3, D-6). It exists at two
-- altitudes: projects.goal (the big picture) and phases.goal (the current
-- focus, tight enough to steer a harness). Both are plain nullable text on
-- the object you are already looking at. This migration adds the Project
-- half as well, because the ratified Brief clause (task-element design
-- e20a12d6 §4, E-12) renders BOTH goals and a Task inherits its Phase goal
-- rather than carrying one.
--
-- LIFECYCLE is exactly the Phase subset of the work-object vocabulary
-- (b94dd86e §4.1): todo · in-progress · completed · archived. No token is
-- invented here. Archive is the routine reversible verb (§4.4); delete is
-- the restricted admin-only path and is refused by the database while any
-- Task still points at the Phase.
--
-- A TASK'S PHASE MUST BELONG TO THE TASK'S PROJECT, structurally. A plain
-- phase_id -> phases(id) foreign key cannot express that, and a
-- service-layer-only check is the class of gap independent review keeps
-- finding in this project. The composite key (phase_id, project_id) ->
-- phases(id, project_id) makes it a database fact. MATCH SIMPLE (the
-- default) skips the check whenever EITHER column is NULL, which would let
-- a row keep a phase_id after its project_id was nulled — the CHECK
-- constraint below closes that hole explicitly rather than trusting the
-- application not to do it.
--
-- ON DELETE RESTRICT, not SET NULL: silently unphasing someone else's
-- Tasks is a data change nobody asked for. The service maps the constraint
-- violation to a typed 409 that names the count.
--
-- INDEX NAMES ARE SCHEMA-WIDE IN POSTGRES: `CREATE INDEX IF NOT EXISTS`
-- silently does nothing when the name is already owned by another table
-- (migration 078 shipped a dead CREATE INDEX line for exactly this reason —
-- caught live, task a6811c12). The two names below are new to this schema
-- and the fresh-replay gate asserts each one lands ON THE RIGHT TABLE via
-- pg_indexes.tablename, not merely that the name exists.
--
-- Schema only. Zero seed rows — a deployment's Phases are its own content
-- and never ship as repo bytes (the 075/076/078 rule).
--
-- Fresh-replay doctrine: database/init.sql is untouched; a fresh install
-- reaches this schema through the migration chain, and every statement here
-- is idempotent so re-running the file is a no-op.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS phases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  goal TEXT,
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in-progress', 'completed', 'archived')),
  position INTEGER NOT NULL DEFAULT 0,
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The composite-FK target. Redundant as a key (id is already unique), and
  -- deliberately so: it is what lets tasks bind (phase_id, project_id).
  UNIQUE (id, project_id)
);

CREATE INDEX IF NOT EXISTS ix_phases_project_order
  ON phases(project_id, position, created_at, id);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS phase_id UUID;

CREATE INDEX IF NOT EXISTS ix_tasks_phase ON tasks(phase_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_phase_project_fk'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_phase_project_fk
      FOREIGN KEY (phase_id, project_id) REFERENCES phases(id, project_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_phase_requires_project'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_phase_requires_project
      CHECK (phase_id IS NULL OR project_id IS NOT NULL);
  END IF;
END $$;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS goal TEXT;

COMMENT ON TABLE phases IS
  'The grouping object between Project and Task (RH-P2.4, strategy §2.3 as amended by vocabulary A3/D-6). Ordered within its Project and MAY overlap: `position` orders, it does not exclude. Carries a goal (a property, never a table). Grantable per §2.3 — Project visibility is inherited by default and grants are additive; exceptional restriction is explicit and audited (owner ruling 44ee41f2).';
COMMENT ON COLUMN phases.goal IS
  'The outcome statement for this Phase — the current focus, tight enough to steer a harness. A property at two altitudes (projects.goal is the other); never its own object, page or table (D-6).';
COMMENT ON COLUMN phases.position IS
  'Ordering hint within the Project. Deliberately NOT unique: Phases may overlap (§3). Reads order by (position, created_at, id).';
COMMENT ON COLUMN phases.status IS
  'The Phase subset of the work-object lifecycle (vocabulary §4.1): todo, in-progress, completed, archived. Archive is reversible (§4.4).';
COMMENT ON COLUMN phases.revision IS
  'Opaque optimistic-concurrency token, rotated on every mutation; If-Match binds it (the 067 discipline).';
COMMENT ON COLUMN tasks.phase_id IS
  'Optional Phase membership (RH-P2.4). NULL = unphased, which is the project backlog, not an error. Bound to the task''s own project by the composite FK tasks_phase_project_fk; ON DELETE RESTRICT so deleting a Phase can never silently unphase Tasks.';
COMMENT ON COLUMN projects.goal IS
  'The Project''s outcome statement — the big picture, so an orchestrator understands what it is building. A property, never a table (D-6); rendered in compiled Briefs alongside the Phase goal (E-12).';
