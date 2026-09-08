-- 078_grants_substrate.sql
-- RH-P2.3 (task 03f50650): the grants schema in target shape (strategy
-- 4e40f06f §2.9/§3-P2; vocabulary b94dd86e §5.1; design report 631bb4fd).
--
-- A grant is object-level authority: (grantee, resource, verb). Polymorphic
-- grantee per the ratified §2.9 direction: grantee_type 'group' is admitted
-- by the CHECK as the C5 fast-follow SEAM but refused by the v1 write
-- surface (the 076 brokered-mode pattern) — v1 is principals-only. The
-- grantee carries no FK by design (a group id has no table yet); integrity
-- is enforced at the service layer and documented in docs/grants.md.
--
-- Resource types are the C5 list. 'phase' and 'plugin' are seam values
-- (their tables land later in Phase 2 / Phase 4); the legacy 'session' type
-- from resource_grants is deliberately NOT carried — it was never consulted
-- by any code. 'personality' is its own type: the registry-level skill
-- subtype is not a grants-schema fact (separate table, separate scope
-- family per §5.2).
--
-- resource_id NULL is the typed wildcard (all objects of the type),
-- replacing the '*' in-band sentinel. UNIQUE NULLS NOT DISTINCT keeps
-- wildcard rows deduplicated WITHOUT a partial unique index — the partial-
-- index fail-open class (the ux_pcred_active_key_id lesson) is structurally
-- absent because revocation is DELETE: grants are live authority
-- configuration, not history (the 070 doctrine). Attribution is
-- server-written (granted_by_principal_id); grant changes join the
-- board-wide audit log when RH-P2.7 builds it.
--
-- SUPERSESSION: migration 064 created resource_grants (monomorphic,
-- 3-verb, 4-type, '*' sentinel) with exactly one seeded pre-grant row —
-- ('report', '*', reports_reader, 'read') — carrying the 063 ordering
-- promise that no visibility tightening may ever precede the knowledge-
-- fabric pre-grant. No code has ever read that table. This migration
-- MIGRATES the pre-grant into `grants` (so the promise holds in the store
-- the Phase-2 predicate will actually consult) and leaves resource_grants
-- byte-intact and dormant: held, reported, never dropped (the house
-- compatibility rule).
--
-- Fresh-replay doctrine: database/init.sql is untouched; this file is
-- idempotent so re-running it is a no-op.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grantee_type TEXT NOT NULL DEFAULT 'principal' CHECK (grantee_type IN ('principal', 'group')),
  grantee_id UUID NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN
    ('task', 'phase', 'project', 'report', 'skill', 'personality', 'service', 'plugin')),
  resource_id UUID,
  verb TEXT NOT NULL CHECK (verb IN ('read', 'write', 'use', 'invoke', 'admin')),
  granted_by_principal_id UUID REFERENCES principals(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (grantee_type, grantee_id, resource_type, resource_id, verb)
);

-- Index names are SCHEMA-wide in Postgres: 064 already owns
-- `ix_grants_grantee` on the superseded resource_grants table, so reusing
-- that name here would be silently skipped by IF NOT EXISTS and leave the
-- lookup index absent (caught live by review 6988bb66 / task a6811c12).
CREATE INDEX IF NOT EXISTS ix_grants_grantee_lookup ON grants(grantee_type, grantee_id);
CREATE INDEX IF NOT EXISTS ix_grants_resource ON grants(resource_type, resource_id);

-- Migrate the single 064 pre-grant into the target store. Wildcard '*'
-- becomes the typed NULL. Idempotent via the unique constraint.
INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id, created_at)
SELECT 'principal', rg.grantee_principal_id, rg.resource_type, NULL, rg.permission,
       rg.granted_by_principal_id, rg.created_at
FROM resource_grants rg
WHERE rg.resource_type = 'report' AND rg.resource_id = '*' AND rg.permission = 'read'
ON CONFLICT DO NOTHING;

COMMENT ON TABLE grants IS
  'Object-level authority (RH-P2.3, strategy §2.9): (grantee, resource, verb) with typed NULL wildcard and expiry. v1 is principals-only (C5); grantee_type ''group'' is the declared fast-follow seam. Consulted by the Phase-2 shared authorization predicate (RH-P2.5); revocation is DELETE — grants are live configuration, not history (070 doctrine).';
COMMENT ON TABLE resource_grants IS
  'SUPERSEDED by grants (migration 078, RH-P2.3): held byte-intact per the compatibility rule, never dropped, never read by code. Its single seeded pre-grant row was migrated into grants with the 063 ordering promise intact.';
COMMENT ON COLUMN grants.resource_id IS
  'NULL = wildcard over the resource type (typed replacement for the retired ''*'' in-band sentinel).';
COMMENT ON COLUMN grants.grantee_id IS
  'Polymorphic with grantee_type — deliberately no FK (a group table does not exist yet); referential integrity for principals is enforced at the service layer.';
