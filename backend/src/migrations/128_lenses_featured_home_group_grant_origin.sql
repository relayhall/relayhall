-- 128_lenses_featured_home_group_grant_origin.sql
-- RH-LENSES-b (card 4287af8a): featured Groups, the home-group POINTER, and
-- the provenance column the creation default stamps.
--
-- Governing design: RH-DESIGN.LENSES v7.1 (report 96f0bd3d) sections 7.1, 7.2
-- and 7.3, with ANNEX v7.1 (report d6637a92); owner ruling 60307311 s1.3/s1.5;
-- owner design record 99d6b0ad decisions 3 and 4.
--
-- THE MIGRATION NUMBER. The design record wrote "125". 125 was taken by
-- RH-AZ.PROJ-b and 124 by FEAT-A while this card waited, so this lane takes the
-- dispatcher-reserved 128 from main's ledger (7a57d4fa section F and
-- PARALLEL-WRITERS 0464ad54 s2/s2a). The record's
-- numbers are placeholders; the ledger is the authority.
--
-- ORDERING: this migration depends only on 094 (groups, group_members), 096
-- (the principals status vocabulary) and 078/099 (grants). It reads and alters
-- no other lane's schema, so integrating after a higher-numbered lane is safe.
--
-- Fresh-replay doctrine: database/init.sql untouched; every statement
-- idempotent.

-- ─────────────────────────── s7.1 · featured ────────────────────────────────
--
-- `featured` GRANTS NOTHING. No authorization predicate reads it; an unfeatured
-- Group keeps every member and every grant it has. It is a PRESENTATION fact
-- (99d6b0ad s4's "ignored unless featured", written here as the presentation
-- rule it is) plus one derivation input: a home-group pointer resolves only
-- while the Group it names is featured (s7.2, derivation D-L2).
--
-- Its writer is `PATCH /groups/{id}`, already behind the root sentinel for
-- every non-GET method (`utils/scopeMap.ts`, the /groups family).

ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial: every picker reads `featured = TRUE` by default and offers show-all,
-- so the index that matters is the one over the featured rows.
CREATE INDEX IF NOT EXISTS ix_groups_featured ON groups(featured) WHERE featured;

COMMENT ON COLUMN groups.featured IS
  'RH-LENSES-b (card 4287af8a; design 96f0bd3d s7.1): presentation-level promotion of a Group. It confers NO authority and no authorization predicate reads it. It is one input to the DERIVED home-group resolver (s7.2): a home pointer naming an unfeatured Group resolves to NULL while the pointer row survives.';

-- ────────────────────────── s7.2 · the home group ───────────────────────────
--
-- NOT `principal_preferences`. That table is "Per-principal presentation
-- preferences" (080:55) and AZ-A5 s5 puts personal preferences outside the
-- authority model. A home group selects the access rule attached to every
-- project the person creates; it is INSIDE the model.
--
-- THE STORED ROW IS A POINTER, NOT AN ANSWER (derivation D-L2). `homeGroup(a)`
-- returns this row's group_id IFF the Group is still `featured`, `a` is still a
-- member of it by any source, AND `a` is still `active`; otherwise NULL. There
-- is NO cleanup trigger: a trigger plus a read check is two mechanisms that can
-- disagree, and a trigger alone silently destroys an administrator's choice the
-- moment a directory sync briefly drops a membership - the shape SS-13's
-- fail-closed discipline exists to avoid.
--
-- ON DELETE RESTRICT on group_id, and it HAS A PATH. Deleting a Group that is
-- anyone's home pointer - even an unresolving one - is refused BY NAME
-- (`GROUP_IS_A_HOME_GROUP`, naming a count and never the identities) by
-- GroupService.remove, and the root-plane act `DELETE /groups/{id}/home-pointers`
-- clears them in one audited transaction first. This is the
-- identity_provider_login_groups pattern (105:55-63): the operator removes the
-- dependency, and that removal is itself audited.
--
-- ON DELETE CASCADE on account_principal_id: a principal row that is gone
-- carries no preference. Termination does NOT delete principals, so the
-- offboarding path clears the pointer explicitly (build obligation B-L7b).

CREATE TABLE IF NOT EXISTS account_home_groups (
  account_principal_id UUID PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  group_id             UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  source               TEXT NOT NULL CHECK (source IN ('admin', 'self')),
  set_by_principal_id  UUID REFERENCES principals(id),
  set_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The lookup GroupService.remove and the root-plane clear act both make: which
-- Accounts point at this Group.
CREATE INDEX IF NOT EXISTS ix_account_home_groups_group ON account_home_groups(group_id);

COMMENT ON TABLE account_home_groups IS
  'RH-LENSES-b (card 4287af8a; design 96f0bd3d s7.2): the home-group POINTER, one row per Account. It is not the answer. homeGroup(a) is DERIVED at read (derivation D-L2): the pointer resolves only while the Group is featured, the Account is a member of it, and the Account is active. No cleanup trigger exists, deliberately.';
COMMENT ON COLUMN account_home_groups.source IS
  'Who set it: self (PUT /principals/me/home-group, owner decision 3) or admin (PUT /principals/{id}/home-group). It records provenance and confers nothing.';

-- ──────────────────────── s7.3 · grants.origin ──────────────────────────────
--
-- WHY A NEW COLUMN AND NOT `grants.provenance`. 099:55-59 constrains
-- `provenance` to 'assignment:grant' | 'assignment:warrant', and the (parked)
-- rule-4 arm's `assignment-vehicle` internal-writer reason is closed by "table
-- in {grants, access_profile_assignments} AND NEW/OLD.provenance IS NOT NULL"
-- (65b9ffa1 s3.7). Widening that CHECK would make every creation-default row
-- satisfy that predicate, so a request path declaring `assignment-vehicle`
-- could write one. A separate column keeps the vehicle predicate EXACTLY as
-- narrow as it is today. Control R-7 pins that against a future "tidy the
-- columns" refactor.
--
-- 'steward' SHIPS AS A DORMANT CHECK VALUE WITH NO v1 WRITER. It is declared,
-- not laundered: a CHECK value supplies no act, and the steward arm defers in
-- full with LENSES-c and the rule-4 arm (DBD-15, owner ruling 60307311 s1.4).
--
-- NOT NULL DEFAULT 'manual' is a no-rewrite add on PostgreSQL 11+, and every
-- pre-existing row is 'manual' by construction: before this migration the only
-- writer of `grants` was the owner-plane act.

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_origin_shape;
ALTER TABLE grants ADD CONSTRAINT grants_origin_shape
  CHECK (origin IN ('manual', 'creation-default', 'steward'));

-- A-L23: no non-manual origin may ever name a PRINCIPAL grantee. The creation
-- default writes to a GROUP and only to a Group; the deferred steward act's
-- ratified grantee is also the Group (AZ-A8 clause 1, DBD-5 restated as a
-- REFUSAL rather than a deferral). This refuses the row in SQL, so a caller
-- writing raw INSERT is refused too - the closure is not the service's alone.
ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_origin_group_only;
ALTER TABLE grants ADD CONSTRAINT grants_origin_group_only
  CHECK (origin = 'manual' OR grantee_type = 'group');

COMMENT ON COLUMN grants.origin IS
  'RH-LENSES-b (card 4287af8a; design 96f0bd3d s7.3): how this grant row came to exist. manual = an owner-plane act (every row written before migration 128). creation-default = written by ProjectService.create for the creator''s resolving home group, inside the project''s own transaction. steward = DORMANT: declared here, with no v1 writer, and deferred in full with LENSES-c and the rule-4 arm. Deliberately NOT grants.provenance: 099''s CHECK is read by the rule-4 arm''s assignment-vehicle internal-writer reason, and widening it would admit a creation-default row to that predicate.';
COMMENT ON CONSTRAINT grants_origin_group_only ON grants IS
  'Card 4287af8a, acceptance A-L23: a grant whose origin is not manual is a GROUP grant. Neither the creation default nor the deferred steward act may ever name a principal grantee.';

-- ───────────────────────────── THE SELF-CHECK ───────────────────────────────
--
-- The three DROP CONSTRAINT IF EXISTS statements above are silent no-ops when a
-- name is wrong, and a silent no-op here ships a green migration with the
-- feature's closure missing. So the migration asserts its own postconditions
-- against the catalogue, which a naming assumption cannot forge.
DO $$
DECLARE
  missing TEXT := '';
  expected_provenance_check TEXT;
  expected_provenance_collation OID;
BEGIN
  -- Let this PostgreSQL version parse/deparse the canonical 099 expression.
  -- Exact expression equality retains operators, casts and Boolean structure;
  -- extracting quoted tokens cannot distinguish IN from NOT IN or an extra AND.
  -- The reference is empty, temporary and dropped before any assertion. It is
  -- not a persisted schema change or a probe against live Grant rows.
  CREATE TEMP TABLE rh_lenses128_provenance_contract (
    provenance TEXT CHECK (provenance IS NULL OR provenance IN ('assignment:grant', 'assignment:warrant'))
  ) ON COMMIT DROP;
  SELECT pg_get_expr(c.conbin, c.conrelid, false), a.attcollation
    INTO STRICT expected_provenance_check, expected_provenance_collation
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'provenance'
   WHERE c.conrelid = 'pg_temp.rh_lenses128_provenance_contract'::regclass
     AND c.contype = 'c';
  DROP TABLE pg_temp.rh_lenses128_provenance_contract;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'grants'::regclass AND contype = 'c'
       AND conname = 'grants_origin_shape'
       AND pg_get_constraintdef(oid) LIKE '%creation-default%'
       AND pg_get_constraintdef(oid) LIKE '%steward%'
  ) THEN missing := missing || ' grants_origin_shape'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'grants'::regclass AND contype = 'c'
       AND conname = 'grants_origin_group_only'
  ) THEN missing := missing || ' grants_origin_group_only'; END IF;

  -- R-7's schema half, asserted at migration time: the provenance CHECK still
  -- admits EXACTLY the two values it admitted before this migration. If a later
  -- edit widens it, this migration's whole argument for a separate column is
  -- void and the rule-4 arm's assignment-vehicle predicate has grown.
  --
  -- Compare the complete PostgreSQL-normalized expression to the canonical
  -- reference, with the same nullable TEXT/collation semantics. Require the
  -- named validated check and refuse every additional check depending on this
  -- column. conkey records column dependencies without a textual-name guess.
  -- R-7's real accepted/refused row probes remain an independent control.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'provenance'
     WHERE c.conrelid = 'grants'::regclass AND c.contype = 'c'
       AND c.conname = 'grants_provenance_shape'
       AND c.convalidated
       AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND NOT a.attisdropped
       AND a.attcollation = expected_provenance_collation
       AND c.conkey = ARRAY[a.attnum]::smallint[]
       AND pg_get_expr(c.conbin, c.conrelid, false) = expected_provenance_check
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'provenance'
     WHERE c.conrelid = 'grants'::regclass AND c.contype = 'c'
       AND c.conname <> 'grants_provenance_shape'
       AND a.attnum = ANY(c.conkey)
  ) THEN missing := missing || ' provenance-CHECK-domain-changed'; END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '128: postcondition failed -%. The feature would ship without its closure.', missing;
  END IF;
END $$;
