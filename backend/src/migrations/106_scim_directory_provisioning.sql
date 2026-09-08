-- 106: RH-P5.SSO.W4 candidate A — the inbound SCIM 2.0 provisioning substrate.
--
-- Contract: the ratified four-report package — design `d95136d7` §7.4,
-- vocabulary amendment **A24** (`b94dd86e`), AUTHZ `4d961e37` **AZ-A4 clause 3**,
-- sitting `5a7fd9af` ruling **SSO-R7** — through wave brief `4bbfe967` §2.1–§2.3.
-- Candidate design record: report `c49e0037`.
--
-- ── WHAT THE SCIM RUNG NEEDS FROM THE DATABASE, AND WHY IT IS TWO THINGS ──
--
-- A24 authorizes the SCIM client to act "all scoped to its own Identity
-- provider". That single phrase is the whole reason this migration exists,
-- because it asks two different questions that must both have server-side
-- answers:
--
--   1. WHICH Identity provider is this caller pushing for?  `identity_providers`
--      gains `scim_client_principal_id`: the service Account whose Connector
--      (A17.2) is that provider's SCIM client. The endpoint resolves the
--      provider FROM THE CREDENTIAL, never from the URL, so the scoping value
--      is never caller-supplied and there is still exactly ONE endpoint family
--      for every provider (brief §2.1: "no vendor branches").
--
--   2. WHICH Accounts did that Identity provider provision?  `directory_provisioned_accounts`
--      records it. A24's refusal of "any read beyond provisioning
--      reconciliation" is only ENFORCEABLE if the endpoint can tell its own
--      rows from the board's; without this table the honest answer to
--      "may this SCIM client read that Account?" would be a guess.
--
-- The second could have been a key in `principals.metadata`, where the SSO
-- rung already stores `email`. It is a table instead because an authorization
-- boundary decided by a JSONB bag that every other writer can set is not a
-- boundary. T-SS14's blast-radius rule is the same argument from the other
-- side: the owner's `source='local'` membership survives every directory
-- write precisely because provenance is recorded rather than inferred.
--
-- ── WHAT THIS MIGRATION MAKES UNREPRESENTABLE ──
--
--   * two Identity providers naming the SAME service Account as their SCIM
--     client — the partial unique index below. Ambiguous resolution would
--     make "its own Identity provider" undecidable at exactly the moment it
--     is being enforced;
--   * a provisioning record pointing at a NON-HUMAN principal — the INSERT
--     trigger below. AZ-A4 clause 3 delegates the creation of "parentless
--     human Accounts" and nothing else, and this is the floor under the
--     application rule rather than a restatement of it;
--   * two Accounts from one Identity provider sharing a `userName` or an `externalId`
--     — the two composite unique indexes. RFC 7643 §4.1.1 makes `userName`
--     unique per service provider, and brief §2.3 rules that a collision is
--     REFUSED at provisioning time rather than silently suffixed;
--   * deleting an Identity provider that has provisioned anybody — the
--     ON DELETE RESTRICT, matching the reasoning migration 104 gives for
--     `identity_links.identity_provider_id`: a provider that has ever acted
--     is retired by DISABLING it.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ──
--
-- It does not touch `identity_providers_directory_mode_not_yet_enableable`.
-- SS-22's refusal is lifted exactly when the producer is COMPLETE, which is
-- candidate C's act after the `expected`-link writer lands in candidate B —
-- not here, where the arrival half exists and the binding half does not.
--
-- It records no heartbeat interval. SSO-R8's per-Identity-provider expected-heartbeat
-- interval is candidate B's migration; the run packet expected it to be 106
-- and it becomes 107 because the candidates land serially and this one is
-- first (design record `c49e0037` §5).

-- ── The SCIM client binding (A24: "scoped to its own Identity provider") ────

ALTER TABLE identity_providers
  ADD COLUMN IF NOT EXISTS scim_client_principal_id UUID REFERENCES principals(id) ON DELETE RESTRICT;

COMMENT ON COLUMN identity_providers.scim_client_principal_id IS
  'A24: the service Account whose Connector is this Identity provider''s SCIM client. NULL = this Identity provider does not provision by SCIM. Owner-plane; the endpoint resolves the provider from the authenticated credential through this column, never from the URL.';

-- One service Account serves at most one Identity provider, so resolving
-- credential -> Identity provider is a function and not a choice. NULL is not
-- constrained: most Identity providers never provision by SCIM.
CREATE UNIQUE INDEX IF NOT EXISTS ux_identity_providers_scim_client
  ON identity_providers(scim_client_principal_id)
  WHERE scim_client_principal_id IS NOT NULL;

-- ── The directory provisioning record ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS directory_provisioned_accounts (
  account_principal_id     UUID PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  identity_provider_id     UUID NOT NULL REFERENCES identity_providers(id) ON DELETE RESTRICT,

  -- RFC 7643 §3.1: `externalId` is the PROVISIONING CLIENT's own identifier
  -- for the resource. It is optional in the protocol, so it is nullable here,
  -- and it is NOT the OIDC `sub` — SS-4 keeps the link key as the
  -- (Identity provider, sub) pair on `identity_links`, and conflating the two
  -- would re-introduce the `jwt_subject` defect §6.1 retired.
  external_id              TEXT,
  -- RFC 7643 §4.1.1: the client's `userName`, kept VERBATIM. The board handle
  -- is derived from it by normalisation, and storing only the derived form
  -- would make two distinct userNames that normalise alike indistinguishable
  -- — which is the collision brief §2.3 refuses rather than suffixes.
  user_name                TEXT NOT NULL,

  provisioned_by_principal_id UUID REFERENCES principals(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT directory_provisioned_accounts_user_name_bounded CHECK (
    length(user_name) > 0 AND octet_length(user_name) <= 255
  ),
  CONSTRAINT directory_provisioned_accounts_external_id_bounded CHECK (
    external_id IS NULL OR (length(external_id) > 0 AND octet_length(external_id) <= 255)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_directory_provisioned_accounts_user_name
  ON directory_provisioned_accounts(identity_provider_id, user_name);

CREATE UNIQUE INDEX IF NOT EXISTS ux_directory_provisioned_accounts_external_id
  ON directory_provisioned_accounts(identity_provider_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_directory_provisioned_accounts_provider
  ON directory_provisioned_accounts(identity_provider_id);

COMMENT ON TABLE directory_provisioned_accounts IS
  'A24/AZ-A4 clause 3: which Accounts an Identity provider''s SCIM client provisioned. The provenance A24''s read boundary is decided by — an Account absent from this table is invisible to that provider''s SCIM client, not merely unwritable.';

-- ── The floor under AZ-A4 clause 3 ─────────────────────────────────────────
--
-- The clause delegates creation of "parentless human Accounts at the fixed
-- minimal role" and nothing else. This trigger pins the ONE half of that shape
-- nothing else in the schema enforces: `kind = 'human'`. An application bug, a
-- future refactor of the creation path, or a hand-written INSERT cannot record
-- an agent or a service principal as directory-provisioned.
--
-- PARENTLESSNESS is deliberately NOT re-checked here, because pinning `kind`
-- already delivers it: migration 096's `principals_human_parentless` is
-- `CHECK (legacy_identity OR kind <> 'human' OR parent_principal_id IS NULL)`,
-- so a non-legacy human row CANNOT carry a parent. Restating it would be a
-- guard whose removal costs nothing, which is the shape the SS-9 chain spent
-- eight rounds learning to refuse. The chain a reviewer should check is:
-- this trigger pins human; 096 makes human imply parentless.
--
-- `role` is absent for a different reason, and the absence is a decision. The
-- clause fixes the role AT CREATION; an owner promoting a directory-provisioned
-- person afterwards is an ordinary owner-plane act, and a constraint here would
-- silently forbid it. The creation-time role is enforced where creation
-- happens, and asserted there.
CREATE OR REPLACE FUNCTION enforce_directory_account_is_human() RETURNS trigger AS $$
DECLARE
  target_kind TEXT;
BEGIN
  SELECT kind INTO target_kind FROM principals WHERE id = NEW.account_principal_id;
  IF target_kind IS DISTINCT FROM 'human' THEN
    RAISE EXCEPTION 'directory provisioning records a human Account only (AZ-A4 clause 3); principal % is %',
      NEW.account_principal_id, COALESCE(target_kind, 'missing');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_directory_provisioned_accounts_human ON directory_provisioned_accounts;
CREATE TRIGGER trg_directory_provisioned_accounts_human
  BEFORE INSERT ON directory_provisioned_accounts
  FOR EACH ROW EXECUTE FUNCTION enforce_directory_account_is_human();
