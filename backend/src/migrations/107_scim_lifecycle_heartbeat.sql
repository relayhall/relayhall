-- 107: RH-P5.SSO.W4 candidate B — the SCIM lifecycle rung and the push heartbeat.
--
-- Contract: the ratified four-report package — design `d95136d7` §7.4–§7.5,
-- vocabulary **A24** (`b94dd86e`), AUTHZ `4d961e37` **AZ-A4 clauses 2 and 4**
-- (clause 2 as amended 2026-09-01, record `57b47450`), sitting `5a7fd9af`
-- rulings **SSO-R6** and **SSO-R8** — through wave brief `4bbfe967` §2.4–§2.7,
-- and owner ruling `6bdcc16c` §1–§2 (2026-09-02), which decided the two
-- questions the ratified texts left open: what an `expected` link records as
-- its subject, and where the heartbeat interval lives.
--
-- ── TWO THINGS, AND WHY NEITHER IS A NEW TABLE ──
--
--   1. SSO-R8 / AZ-A4 clause 4: a per-Identity-provider EXPECTED-HEARTBEAT
--      interval. `identity_providers` gains `scim_heartbeat_interval_hours`,
--      NULLABLE — NULL means the row keeps claim-sync (pull) semantics, a value
--      means push semantics for THIS Identity provider. That is what makes the
--      reinterpretation per Identity provider mode rather than global, which
--      clause 4 requires ("pull semantics unchanged for claim-driven sync").
--      The watermark itself is a `directory_sync_state` row keyed
--      `scim:<identity provider id>` whose `last_success_at` means "last push
--      received" (ruling 6bdcc16c §2); the claim-sync rows keyed by the bare id
--      keep their meaning. No new table and no new alarm: the read is the
--      existing AZ-30 staleness query, and the interval is copied into that
--      row's `staleness_threshold_hours` by the only two writers that may move
--      it — the owner-plane write of the interval, and the push itself.
--
--   2. AZ-30 / §7.5: the DEPROVISION-DETECTED FLAG. AZ-30 rules "a
--      deprovision-detected flag surfaced in the Access manager", and AZ-A4
--      clause 2 adds auto-disable "in addition to raising the flag". The flag
--      lives on the PROVENANCE row (`directory_provisioned_accounts`), because
--      that row already records which Identity provider may act on the Account;
--      a flag in `principals.metadata` would be the JSONB bag migration 106
--      declined for exactly this class of fact. `deprovision_signal` names WHICH
--      of the two ratified signals arrived — `inactive` (SCIM `active=false`) or
--      `removed` (removal from the provisioning scope) — and `deprovisioned_at`
--      says when. Both NULL = no signal outstanding; re-activation clears both.
--
-- ── WHAT THIS MIGRATION MAKES UNREPRESENTABLE ──
--
--   * a non-positive heartbeat interval — the column CHECK;
--   * a deprovision signal outside the two ratified ones — the column CHECK;
--   * a signal without its instant, or an instant without its signal — the
--     paired CHECK.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ──
--
-- It does not touch `identity_providers_directory_mode_not_yet_enableable`
-- (migration 104). SS-22's refusal is lifted exactly when the producer is
-- COMPLETE, and that is candidate C's act; the CHECKs of 105 and 106 stand.
-- It adds no status vocabulary: `disabled` already exists on `principals`,
-- migration 096 already makes `terminated` final, and this rung never writes
-- the latter — reversible disable, never terminate (AZ-A4 clause 2). The
-- disable itself is an application act through `PrincipalService`, because
-- the clause's second half ("a status write must also clear the cached
-- principal row") is a property of the process, not of the schema.
--
-- Additive and replay-safe: IF NOT EXISTS on every column, a guarded
-- ADD CONSTRAINT for the pair; `database/init.sql` untouched.

-- ── The expected-heartbeat interval (SSO-R8, AZ-A4 clause 4) ───────────────

ALTER TABLE identity_providers
  ADD COLUMN IF NOT EXISTS scim_heartbeat_interval_hours INTEGER
    CONSTRAINT identity_providers_scim_heartbeat_interval_positive
    CHECK (scim_heartbeat_interval_hours IS NULL OR scim_heartbeat_interval_hours > 0);

COMMENT ON COLUMN identity_providers.scim_heartbeat_interval_hours IS
  'SSO-R8 / AZ-A4 clause 4 (ruling 6bdcc16c §2): the expected-heartbeat interval for this Identity provider''s SCIM pushes. NULL = claim-sync (pull) semantics, unchanged. A value = push semantics: the directory_sync_state row keyed scim:<id> means "last push received", and silence past this many hours raises the existing AZ-30 staleness alarm. Per Identity provider, never global.';

-- ── The deprovision-detected flag (AZ-30 / §7.5, AZ-A4 clause 2) ───────────

ALTER TABLE directory_provisioned_accounts
  ADD COLUMN IF NOT EXISTS deprovision_signal TEXT
    CONSTRAINT directory_provisioned_accounts_deprovision_signal_named
    CHECK (deprovision_signal IS NULL OR deprovision_signal IN ('inactive', 'removed'));

ALTER TABLE directory_provisioned_accounts
  ADD COLUMN IF NOT EXISTS deprovisioned_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'directory_provisioned_accounts_deprovision_flag_paired'
  ) THEN
    ALTER TABLE directory_provisioned_accounts
      ADD CONSTRAINT directory_provisioned_accounts_deprovision_flag_paired
      CHECK ((deprovision_signal IS NULL) = (deprovisioned_at IS NULL));
  END IF;
END
$$;

COMMENT ON COLUMN directory_provisioned_accounts.deprovision_signal IS
  'AZ-30 / AZ-A4 clause 2: the deprovision-detected flag, naming which ratified signal arrived — inactive (SCIM active=false) or removed (removal from the provisioning scope). NULL = no signal outstanding. Raised together with the auto-disable; cleared by the directory''s active=true. Group-claim shrinkage never sets it (SS-13).';

COMMENT ON COLUMN directory_provisioned_accounts.deprovisioned_at IS
  'When deprovision_signal was raised; NULL exactly when the signal is NULL (paired CHECK).';
