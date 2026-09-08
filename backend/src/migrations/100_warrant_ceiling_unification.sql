-- 100_warrant_ceiling_unification.sql
-- AUTHZ amendment AZ-A3 (RATIFIED 2026-08-26; owner gate 553c3a5f, folded
-- into design 4d961e37 and ruling 7440b579): a Warrant's authority ceiling
-- is ALWAYS a version-pinned Access profile. The inline-selector storage
-- shape is retired.
--
-- WHY. `grants` has no negation operator. A rules-form ceiling containing
-- the ratified `all-except` selector form could not be materialized as an
-- assignment vehicle without either WIDENING (a typed wildcard admits the
-- excluded objects) or FREEZING (an expanded complement stops including
-- future objects). The Access profile arm expresses all three ratified
-- selector forms natively, and AZ-4 already ruled that profile assignments
-- compile into nothing — they are evaluated live. So the second shape was
-- not a second option; it was a path that could never be made equivalent
-- to the first, forking every consumer of a ceiling along the way.
--
-- WHAT CHANGES. Nothing about what a ceiling MEANS — only how many ways
-- there are to write one. `POST /warrants` still accepts `ceilingRules`;
-- the server now publishes them as a real Access profile inside the same
-- step-up-gated act and pins that version (AZ-21b unchanged).
--
-- THE COLUMN STAYS. `warrants.ceiling_rules` is held byte-intact — held,
-- reported, never dropped, the house compatibility rule that migration 078
-- states for `resource_grants`. It is NULL from this migration on, and the
-- CHECK below is what makes that a fact rather than a convention.
--
-- NO DATA MIGRATION IS OWED. At ratification no warrant existed anywhere
-- in the estate: DEV is rebuild-at-will and had been reset, TST is pinned
-- seventeen days before migration 098 and carries no `warrants` table at
-- all, and the Phase-5 private PRD does not exist (Charter 4d1311c1 §4,
-- estate facts). The guard below therefore expects to find nothing — and
-- says so loudly rather than silently mangling anything if it does, on the
-- 097 precedent.
--
-- Fresh-replay doctrine: database/init.sql untouched; every statement here
-- is idempotent so re-running the file is a no-op.

-- ── the guard ───────────────────────────────────────────────────────────
--
-- An inline ceiling cannot be converted safely without deciding, per
-- warrant, who its profile belongs to and what it is called — an owner
-- disposition, not a migration's call. If any exists, stop and say so.

DO $$
DECLARE
  inline_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO inline_count FROM warrants WHERE ceiling_rules IS NOT NULL;
  IF inline_count > 0 THEN
    RAISE EXCEPTION
      'AZ-A3: % warrant(s) still carry an inline ceiling. Amendment AZ-A3 retires that shape and this migration will not guess a profile name or owner for them — publish each ceiling as an Access profile, re-point the warrant, then re-run. (design 4d961e37 AZ-A3; owner gate 553c3a5f)',
      inline_count;
  END IF;
END $$;

-- ── one shape, enforced ─────────────────────────────────────────────────
--
-- 098 required EXACTLY ONE of the two forms. AZ-A3 leaves one: the profile
-- pin is mandatory and the inline column must be empty.

ALTER TABLE warrants DROP CONSTRAINT IF EXISTS warrants_ceiling_present;
ALTER TABLE warrants ADD CONSTRAINT warrants_ceiling_present
  CHECK (ceiling_profile_version_id IS NOT NULL AND ceiling_rules IS NULL);

COMMENT ON COLUMN warrants.ceiling_rules IS
  'RETIRED by AUTHZ amendment AZ-A3 (2026-08-26, owner gate 553c3a5f). Held byte-intact under the house compatibility rule and constrained NULL: a warrant ceiling is always a version-pinned Access profile, because grants cannot express the ratified all-except selector form and AZ-4 already evaluates profile assignments live rather than compiling them. Inline rules survive only as a creation-time convenience on POST /warrants, which publishes them as a profile.';

COMMENT ON COLUMN warrants.ceiling_profile_version_id IS
  'The warrant MINT ceiling, version-pinned at creation (AZ-21b) — republishing the profile never widens a standing warrant. Since AZ-A3 this is the ONLY ceiling shape, and it is mandatory. An assignment vehicle assigns the profile itself, so vehicle VISIBILITY follows the published version (AZ-11/T14) while this pin does not: two planes, one object.';
