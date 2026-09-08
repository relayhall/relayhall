-- =============================================================================
-- Migration 042: Agent-type provenance + safe retirement of duplicate personas
--                (ClawBoard task c8f4dd95 — persona registry hygiene)
-- =============================================================================
--
-- Two problems this migration fixes:
--
--   1. PROVENANCE. agent_types mixes rows that are synced from the
--      agency-agents git repo (AgentTypeService.syncFromRepo) with legacy DB
--      rows that predate that sync. Nothing distinguished them. We add a
--      `source` column:
--        'git'       — the persona is defined by a markdown file in the
--                      agency-agents repo (i.e. it round-trips through sync).
--        'legacy-db' — the row exists only in the database.
--      The authoritative backfill happens live in syncFromRepo(), which now
--      stamps source='git' on every upserted row (a slug present in the repo
--      manifest IS a git-managed persona). This migration seeds the at-rest
--      snapshot: any row that already carries a source_file (only the sync
--      ever writes source_file) was synced from the repo, so it is 'git';
--      everything else defaults to 'legacy-db' until the next sync corrects it.
--
--   2. DUPLICATE NAMES. `clawboard doctor` reports two duplicate-persona-name
--      ERRORs:
--        - "OpenClaw Plugin Developer": slugs openclaw-plugin-dev (legacy) and
--          engineering-openclaw-plugin-dev (canonical).
--        - "Technical Writer": engineering-technical-writer (canonical, used)
--          and support-technical-writer (unused).
--      We retire the two LOSERS safely: repoint every task and session that
--      references the loser to the canonical winner (across ALL statuses,
--      including archived), then SOFT-delete the loser via retired_at. Retired
--      rows are preserved (never hard-deleted) so historical detail views and
--      archived-task provenance keep resolving, but they are excluded from the
--      default /agent-types listing so the doctor no longer sees a collision.
-- =============================================================================

-- --- 1. Provenance + retirement columns ------------------------------------

ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'legacy-db'
    CHECK (source IN ('git', 'legacy-db'));

ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS retired_reason TEXT;

-- Point retired lookups at their canonical replacement so detail views can
-- redirect / annotate. NULL for live rows.
ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS retired_in_favor_of UUID
    REFERENCES agent_types(id) ON DELETE SET NULL;

-- At-rest provenance backfill: only syncFromRepo writes source_file, so a
-- populated source_file means the row was synced from the agency-agents repo.
UPDATE agent_types
SET source = 'git'
WHERE source_file IS NOT NULL
  AND source <> 'git';

-- --- 2. Safe retirement of the two duplicate losers -------------------------
-- Winner/loser pairs are matched by slug (IDs differ per environment). Each
-- block is a no-op unless BOTH the loser and its winner exist in this DB, so
-- the migration is safe to run everywhere (dev has a subset of prod rows).

DO $$
DECLARE
  pair RECORD;
  loser_id  UUID;
  winner_id UUID;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      -- (loser slug,                canonical winner slug)
      ('openclaw-plugin-dev',        'engineering-openclaw-plugin-dev'),
      ('support-technical-writer',   'engineering-technical-writer')
    ) AS t(loser_slug, winner_slug)
  LOOP
    SELECT id INTO loser_id  FROM agent_types WHERE slug = pair.loser_slug;
    SELECT id INTO winner_id FROM agent_types WHERE slug = pair.winner_slug;

    -- Only act when both sides are present AND the loser is not already retired.
    CONTINUE WHEN loser_id IS NULL OR winner_id IS NULL;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM agent_types WHERE id = loser_id AND retired_at IS NOT NULL
    );

    -- Repoint references across ALL task/session statuses (incl. archived).
    UPDATE tasks    SET agent_type_id = winner_id WHERE agent_type_id = loser_id;
    UPDATE sessions SET agent_type_id = winner_id WHERE agent_type_id = loser_id;

    -- Soft-delete the loser (preserve the row for historical display).
    UPDATE agent_types
    SET retired_at          = now(),
        retired_reason      = 'duplicate persona name; retired in favor of ' || pair.winner_slug,
        retired_in_favor_of = winner_id,
        updated_at          = now()
    WHERE id = loser_id;

    RAISE NOTICE 'Retired persona % -> % (references repointed)',
      pair.loser_slug, pair.winner_slug;
  END LOOP;
END $$;

-- Partial index: fast "live personas only" listing for the /agent-types API.
CREATE INDEX IF NOT EXISTS idx_agent_types_live
  ON agent_types (category, name)
  WHERE retired_at IS NULL;
