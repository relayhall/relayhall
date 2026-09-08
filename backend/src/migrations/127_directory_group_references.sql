-- 127_directory_group_references.sql
-- RH-LENSES-a (card 74e02a05): DIRECTORY GROUP REFERENCES and their CARRIAGE.
--
-- Governing design: RH-DESIGN.LENSES v7.1 (record 96f0bd3d, ANNEX d6637a92),
-- normative mechanism text design v5 07764243 s3.1 and s4.4. The record calls
-- this migration "124"; the RESERVED ledger reserves 124 for rh-feata-duedate
-- and 125 for rh-95572530-az-proj-b, so this lane takes the next free number
-- (dispatcher note on card 74e02a05, 2026-09-05 19:36 UTC) and reserves it in
-- backend/src/migrations/RESERVED in this same branch (ruling 0464ad54 s2a).
--
-- IT IS 127 AND NOT 126, and the reason is worth reading before renumbering
-- it back. FOUR lanes appended 126 to their OWN branch's ledger and none
-- could see the others, because a reservation on a lane branch is invisible
-- until it integrates. This lane moved to a number no pushed branch claims;
-- the RESERVED ledger records 126 as the earliest-pushed claimant's, and
-- which of the remaining lanes keeps it is a dispatcher question.
--
-- WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT.
--
-- A DIRECTORY GROUP REFERENCE is an external group value observed at one
-- Identity provider. Its CARRIAGE is the observation "this Account was seen
-- carrying this reference, from this source". NEITHER HOLDS AUTHORITY. The
-- estate has exactly one path from a directory to authority --
--   groups (bound) -> group_members -> the authority readers
-- -- and this migration adds a REFERENCE store beside it, never a second
-- membership store. It is a design failure if any authorization predicate ever
-- reads either table; the control
-- `backend/src/__tests__/directoryCarriageSeamCensus.test.ts` measures that
-- over the source, and this migration keeps it structural:
--
--   * NO foreign key to `groups`, in either direction, ever. The only relation
--     between a reference and a Group is the byte-exact match within one
--     provider, computed at QUERY time by the unmodified `resolveGroupBindings`
--     (`services/identity/ssoGroupBinding.ts`). A FK would create a second
--     binding representation, and two representations of one relation is how
--     they drift.
--   * the column is `external_group_ref`, NOT `group_id`, and the object is a
--     directory group REFERENCE. Naming is the first line of defence.
--
-- `source` IS PART OF THE PRIMARY KEY, so the two producers -- the OIDC claim
-- path and SCIM /Groups -- replace DISJOINT row sets. That is the split
-- `094_groups.sql:15-18` already uses for `group_members.source`, one level up:
-- a SCIM push must not delete what a login observed, and the other way round.
--
-- ON DELETE CASCADE FROM `identity_providers`, unlike `groups`. Deleting a
-- provider UNBINDS Groups (104's `trg_identity_providers_unbind_groups`)
-- because a half-bound Group is a forbidden state; carriage, by contrast, is
-- an OBSERVATION ABOUT THAT PROVIDER and retaining it would show phantom
-- catalog rows for a provider that no longer exists.
--
-- NO `ordinal` COLUMN. Order is the provider's, and SS-12's "never touched"
-- rule covers it; surfaces sort at read by (display_name NULLS LAST,
-- external_group_ref). The design's sort names `featured` first; `groups.featured`
-- is RH-LENSES-b's column and does not exist at this branch's base, and a lane's
-- migration must not depend on another lane's schema (RESERVED ledger, ruling
-- 0464ad54 s2). LENSES-b adds the leading sort key with the column.
--
-- BOUNDED TEXT, the way `106:106-113` bounds `user_name` and `external_id`.
-- The bound is on OCTETS, not characters: a 1024-character ref of 4-byte code
-- points is a 4 KiB key, and the index that carries it is the thing being
-- bounded.
--
-- Fresh-replay doctrine: database/init.sql untouched; replay preserves the final schema and rows. The provider attribute CHECK
-- is replaced on replay; this migration does not claim a no-op replay.
--
-- ORDERING: depends on 104 (identity_providers, the group binding columns) and
-- on the `principals` table. It reads and alters no other lane's schema, so
-- integrating after a higher-numbered lane is safe (RESERVED ledger, owner
-- ruling PARALLEL-WRITERS 0464ad54 s2).

-- ── The reference resource ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS directory_group_references (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_provider_id UUID NOT NULL REFERENCES identity_providers(id) ON DELETE CASCADE,
  external_group_ref   TEXT NOT NULL,
  display_name         TEXT,
  scim_external_id     TEXT,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT directory_group_references_ref_bounded
    CHECK (length(external_group_ref) > 0 AND octet_length(external_group_ref) <= 1024),
  CONSTRAINT directory_group_references_display_bounded
    CHECK (display_name IS NULL OR octet_length(display_name) <= 1024),
  CONSTRAINT directory_group_references_scim_external_bounded
    CHECK (scim_external_id IS NULL OR (length(scim_external_id) > 0 AND octet_length(scim_external_id) <= 255))
);

-- The reference is identified WITHIN a provider by its exact bytes. Two refs
-- differing by one byte, by case, by a trailing slash or by NFC/NFD are two
-- rows: SS-12's "opaque string matched exactly" is enforced here by the index,
-- not by a convention in the service.
CREATE UNIQUE INDEX IF NOT EXISTS ux_directory_group_references_ref
  ON directory_group_references(identity_provider_id, external_group_ref);

-- `externalId` is the SCIM client's own identifier for the resource
-- (RFC 7643 s3.1). It is unique within a provider WHERE PRESENT: the claim
-- producer never supplies one, and two references with no externalId are not
-- a collision.
CREATE UNIQUE INDEX IF NOT EXISTS ux_directory_group_references_scim_external
  ON directory_group_references(identity_provider_id, scim_external_id)
  WHERE scim_external_id IS NOT NULL;

-- ── The carriage ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS account_directory_group_references (
  directory_group_reference_id UUID NOT NULL REFERENCES directory_group_references(id) ON DELETE CASCADE,
  account_principal_id         UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  source                       TEXT NOT NULL CHECK (source IN ('claim', 'scim')),
  first_seen_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (directory_group_reference_id, account_principal_id, source)
);

CREATE INDEX IF NOT EXISTS ix_account_dgr_account
  ON account_directory_group_references(account_principal_id);

-- ── s4.4: which pushed attribute becomes `external_group_ref` ─────────────
--
-- `external_group_ref` must BYTE-MATCH what the OIDC claim carries, or a Group
-- bound from the catalog never receives claim-driven members. SCIM and OIDC
-- need not agree on the identifier, and pretending they do is the defect this
-- column avoids: the PROVIDER DECLARES which attribute of a pushed SCIM Group
-- becomes the ref, and the value is taken from it VERBATIM, never normalised.
--
-- `'id'` IS DELIBERATELY NOT A VALUE (design v5 s4.4 [F6]). RFC 7643 s3.1 makes
-- `id` the SERVICE PROVIDER's to assign, and s4.3 of the design maps SCIM `id`
-- onto `directory_group_references.id`; admitting it here would either make a
-- conforming POST (which supplies no `id`) unusable under the "declared
-- attribute absent -> 400" rule, or create a client-controlled shadow field
-- with the same name as a server-owned one. Two owners for one attribute is a
-- wire-contract defect. A client holding only an opaque internal identifier
-- puts it in `externalId`, which is what RFC 7643 s3.1 defines `externalId` for.
ALTER TABLE identity_providers
  ADD COLUMN IF NOT EXISTS scim_group_ref_attribute VARCHAR(32) NOT NULL DEFAULT 'externalId';
ALTER TABLE identity_providers
  DROP CONSTRAINT IF EXISTS identity_providers_scim_group_ref_attribute_check;
ALTER TABLE identity_providers
  ADD CONSTRAINT identity_providers_scim_group_ref_attribute_check
  CHECK (scim_group_ref_attribute IN ('externalId', 'displayName'));

-- ── THE SELF-CHECK ────────────────────────────────────────────────────────
--
-- These checks verify required column names and reject forward foreign keys
-- from carriage to groups. They do not certify column types, defaults, other
-- constraints, reverse foreign keys, or additional binding representations.
-- Fresh schema correctness and replay remain real-PostgreSQL CI gates.
DO $$
DECLARE missing TEXT;
BEGIN
  SELECT string_agg(needed, ', ') INTO missing FROM (
    SELECT 'directory_group_references.' || c.name AS needed
      FROM (VALUES ('id'), ('identity_provider_id'), ('external_group_ref'), ('display_name'),
                   ('scim_external_id'), ('first_seen_at'), ('last_seen_at'), ('updated_at')) AS c(name)
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_name = 'directory_group_references' AND column_name = c.name)
    UNION ALL
    SELECT 'account_directory_group_references.' || c.name
      FROM (VALUES ('directory_group_reference_id'), ('account_principal_id'), ('source'),
                   ('first_seen_at'), ('last_seen_at')) AS c(name)
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_name = 'account_directory_group_references' AND column_name = c.name)
    UNION ALL
    SELECT 'identity_providers.scim_group_ref_attribute'
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_name = 'identity_providers' AND column_name = 'scim_group_ref_attribute')
  ) AS gaps;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '127: the carriage schema is incomplete after this migration: %', missing;
  END IF;
END $$;

-- The ONE relation this design forbids: a foreign key from either new table to
-- `groups`. A future editor who adds one has created a second representation
-- of the binding, and the byte-exact join stops being the only one. This is
-- the structural half of prohibition 1; the source census is the other half.
DO $$
DECLARE offenders TEXT;
BEGIN
  SELECT string_agg(conname, ', ') INTO offenders
    FROM pg_constraint
   WHERE contype = 'f'
     AND conrelid IN ('directory_group_references'::regclass,
                      'account_directory_group_references'::regclass)
     AND confrelid = 'groups'::regclass;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      '127: a foreign key from the carriage tables to groups exists (%). The only relation between a reference and a Group is the byte-exact match within one provider, computed at query time; a FK is a second binding representation.',
      offenders;
  END IF;
END $$;

-- ── Documentation, in the database ────────────────────────────────────────

COMMENT ON TABLE directory_group_references IS
  'RH-LENSES-a (74e02a05): an external group value OBSERVED at one Identity provider. It holds NO authority and is read by NO authorization predicate. A row whose carriage falls to zero is RETAINED, not deleted: the catalog exists to tell an administrator what the directory has shown, and one that forgets a group the moment its last member leaves cannot answer "is this the group I bound last month?". Housekeeping is the explicit root act DELETE /directory-group-references/:id, refused while the ref is bound.';
COMMENT ON COLUMN directory_group_references.external_group_ref IS
  'The value the Identity provider sent, byte-for-byte. OPAQUE: never parsed, never split on /, never case-folded, never NFC/NFD-folded. Two values differing by one byte are two references.';
COMMENT ON COLUMN directory_group_references.last_seen_at IS
  'When this reference was last observed. The catalog surfaces it so a retained orphan is visibly stale rather than silently current.';
COMMENT ON TABLE account_directory_group_references IS
  'RH-LENSES-a (74e02a05): "this Account was observed carrying this reference, from this source". It holds NO authority: carriage confers nothing until an administrator BINDS a reference to a Group by an owner-plane act, and even then the authority is the Group''s, through group_members, exactly as it is today.';
COMMENT ON COLUMN account_directory_group_references.source IS
  'claim | scim -- the producer that observed it. It is part of the PRIMARY KEY so the two producers replace DISJOINT row sets: a SCIM push never deletes what a login observed, and a login never deletes what a push observed.';
COMMENT ON COLUMN identity_providers.scim_group_ref_attribute IS
  'externalId | displayName -- which attribute of a pushed SCIM Group becomes external_group_ref, taken VERBATIM. Declared by the provider because SCIM and OIDC need not agree on the identifier. A misconfigured attribute produces carriage that binds NOTHING; it never produces wrong bindings, because the join is byte-exact and simply misses.';
