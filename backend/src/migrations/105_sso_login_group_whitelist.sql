-- 105: RH-P5.SSO.W3 — the login group whitelist.
--
-- Contract: the ratified four-report object — design `d95136d7` v10, vocabulary
-- amendment `e65fd61e` (folded as A23 into `b94dd86e`), acceptance annex
-- `e6dcadb9`, revision log `79c2920a` — plus sitting record `5a7fd9af`
-- ruling **SSO-R4**, which is an owner-directed ADDITION to the ratified
-- package: *"a login GROUP-WHITELIST (only members of allowed group(s) may
-- authenticate), landing in W3 SCOPE — design settled in the W3 brief
-- (fail-closed on absent/overage claims, evaluated per §7.2 doctrine against
-- stored membership), cross-family reviewed with the wave."*
-- Owner decision W3-D2 (run packet `05492f21` §4) settles the semantics.
-- Wave inventory: annex §11 SS-W3.
--
-- ── WHY THIS IS A WHITELIST AND NOT A POLICY ENGINE ──
--
-- The board already has an authority model, and this is not it. A whitelist
-- decides ONE question — may this Account obtain a federated login session at
-- all — and decides nothing about what the login session may then do. Authority
-- remains exactly where AUTHZ `4d961e37` §3 puts it: grants, resolved by the
-- query-time membership join. So this table gates the DOOR, never the ROOM,
-- and T-SS18's parity assertion is untouched: an Account admitted through the
-- SSO door holds byte-identical effective scopes to the same Account admitted
-- through the password door.
--
-- ── WHAT THIS MIGRATION MAKES UNREPRESENTABLE ──
--
--   * a whitelist entry naming a Group that no longer exists — the FK is
--     ON DELETE RESTRICT, so deleting a Group that gates login is refused
--     while the entry stands (see the comment on the constraint below);
--   * a duplicate entry — the composite primary key;
--   * a whitelist that outlives its Identity provider — ON DELETE CASCADE,
--     because the entries are Identity-provider-owned CONFIGURATION rather
--     than proof of anything, and a whitelist with no Identity provider gates
--     nothing.
--
-- What it deliberately DOES NOT make unrepresentable is an ENABLED whitelist
-- with an EMPTY entry set. That state refuses every federated login, and it is
-- reachable on purpose: W3-D2 rules it *fail closed*. A CHECK forbidding it
-- would turn "I have not finished configuring this yet" into "everyone may log
-- in", which is the failure direction this feature exists to prevent.

-- ── The per-Identity-provider switch ──────────────────────────────────────
--
-- DEFAULT FALSE: an existing deployment that upgrades into this migration
-- keeps the behaviour it had. Turning the gate on is a deliberate, audited
-- owner-plane act, exactly like every other Identity provider field.
ALTER TABLE identity_providers
  ADD COLUMN IF NOT EXISTS login_group_whitelist_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN identity_providers.login_group_whitelist_enabled IS
  'SSO-R4 (owner-directed, sitting 5a7fd9af): when true, a federated login is admitted only if the Account holds membership in at least one Group listed in identity_provider_login_groups for this Identity provider. Enabled with an EMPTY list refuses every federated login — fail closed, W3-D2. Never consulted for local password logins (§8.5 break-glass is unreachable from here).';

-- ── The allowed-Group list ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS identity_provider_login_groups (
  identity_provider_id  UUID NOT NULL REFERENCES identity_providers(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT, and the reason is the W2 lesson repeated one table
  -- over: deleting an Identity provider used to CASCADE and destroy its
  -- Identity links (W2 evidence `6f63a606` finding 1). Here the failure would
  -- be quieter and worse — deleting a Group that gates login would silently
  -- WIDEN or NARROW who may authenticate, with nothing in the audit ledger
  -- naming the access change. The operator removes the entry first, which is
  -- an audited act, and only then may the Group go.
  group_id              UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  added_by_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL,
  added_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (identity_provider_id, group_id)
);

COMMENT ON TABLE identity_provider_login_groups IS
  'SSO-R4 login group whitelist: the Groups whose membership admits a federated login at one Identity provider. Membership is read from group_members with NO source filter — a local assignment and a directory-synced one both admit (W3-D2), because the question is whether the board considers this person a member, not how the board came to know it. Gates authentication only; it confers no authority and appears nowhere in grant resolution.';

COMMENT ON COLUMN identity_provider_login_groups.group_id IS
  'ON DELETE RESTRICT: a Group that gates login cannot be deleted out from under the whitelist. GroupService.remove() turns the resulting constraint violation into a NAMED refusal that tells the operator which Identity provider still lists it.';

-- Reverse lookup: "which Identity providers does this Group gate?" — the question
-- GroupService.remove() asks before refusing, and the Access manager asks when
-- rendering a Group. The forward direction is already served by the primary key.
CREATE INDEX IF NOT EXISTS ix_idp_login_groups_group
  ON identity_provider_login_groups(group_id);
