-- 104: RH-P5.SSO.W2 — the relying-party core.
--
-- Contract: the ratified four-report object — design `d95136d7` v10, vocabulary
-- amendment `e65fd61e` (folded as A23 into `b94dd86e`), acceptance annex
-- `e6dcadb9`, revision log `79c2920a` — plus sitting record `5a7fd9af`
-- (rulings SSO-R1..R18) and strategy amendments companion `94dc31c0` (S-A8).
-- Wave inventory: annex §11 SS-W2. Run packet `7a424b07` §4.
--
-- ── WHAT THIS MIGRATION IS FOR ──
--
-- Migration 062 shipped an identity substrate whose intended SSO vehicle was
-- `principal_credentials.credential_type='jwt_subject'`, with `key_id`
-- documented as "OIDC sub". Design §6.1 retires that vehicle: its uniqueness
-- is on `key_id` ALONE across every credential type, so a subject would be
-- forced globally unique across issuers, could collide with an `api_key`'s
-- public 12-character id, and VARCHAR(64) is shorter than the subject
-- identifiers real issuers emit. None of that is a criticism of 062 — it was
-- written before the multi-provider position existed.
--
-- The binding key is the PAIR `(Identity provider, subject)` (SS-4), carried
-- by an Identity link (SS-8, vocabulary A23.2 — an EXTENSION of A19.2, one
-- table, one revocation story), never by a credential row.
--
-- ── THE INVARIANTS THIS FILE MAKES UNREPRESENTABLE ──
--
-- Every rule below that CAN live in the schema does, because this programme
-- has paid repeatedly for policy that had no vehicle (annex §11a; design
-- §6.2's record of rounds 4-7). In particular:
--
--   * an expectation is never mistaken for a proof — a session may not
--     reference a link that is not `proven` AND unrevoked, enforced by a
--     constraint trigger on `auth_sessions` rather than by whichever service
--     happens to write next (SS-24; a row CHECK cannot query another table,
--     which is why 094_groups.sql:58-85 uses the same pattern);
--   * a revoked link never has surviving sessions — the deferred trigger
--     refuses the transaction rather than leaving the window open (SS-24);
--   * a proven link never reverses to `expected` under a live session;
--   * an Identity provider that cannot declare immutable, never-recycled
--     subjects cannot be active at all (SS-21 / T-SS8);
--   * at most ONE Identity provider is active (SS-14a, owner ruling D3 —
--     enforced AT THE WRITE in this wave, its acceptance row discharged in
--     W3);
--   * `directory` provisioning mode cannot be active until W4 supplies the
--     producer that writes `expected` links (SS-22);
--   * an invitation names exactly one Account or declares intent to create
--     one — never both, never neither (SS-22);
--   * a logout token is consumed BY ITS INSERT, so two concurrent replays
--     cannot both proceed (SS-23).
--
-- Secrets in this file are ciphertext columns only. They are encrypted under
-- the AUTHZ `4d961e37` §7.2 envelope keyset — the SAME keyset, canary and
-- rotation as every other credential secret (SS-7) — and carry the keyset id
-- in `*_key_id`. A second envelope would be a second rotation story.

-- ── SSO-R12: retire `jwt_subject`, under a guard ──────────────────────────
--
-- The sitting ruled the value REMOVED from the 062 credential-type CHECK
-- "under a guard that refuses to run if any row uses it". The guard runs
-- first: the whole migration is one simple query, so PostgreSQL's implicit
-- transaction rolls every statement below back if this raises.
DO $$
DECLARE
  offending BIGINT;
BEGIN
  SELECT count(*) INTO offending
    FROM principal_credentials WHERE credential_type = 'jwt_subject';
  IF offending > 0 THEN
    RAISE EXCEPTION
      'migration 104 refuses to run: % principal_credentials row(s) still use credential_type=''jwt_subject'' (SSO-R12). Retire them before migrating.',
      offending
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

ALTER TABLE principal_credentials DROP CONSTRAINT IF EXISTS principal_credentials_credential_type_check;
ALTER TABLE principal_credentials ADD CONSTRAINT principal_credentials_credential_type_check
  CHECK (credential_type IN ('api_key','legacy_env','password'));

-- 062's OTHER CHECK — `(credential_type = 'jwt_subject') = (secret_hash IS
-- NULL)` — is deliberately LEFT ALONE. With the type gone it evaluates to
-- "secret_hash IS NOT NULL" for every permitted type, which is exactly what it
-- already enforced. SSO-R12 asks for one value removed from one CHECK; a
-- semantically-neutral rewrite of a second constraint would be scope this
-- ruling does not carry, and every changed byte is a reviewed byte.

COMMENT ON COLUMN principal_credentials.key_id IS
  'api_key: public 12-char id | legacy_env: env var name. NOT an OIDC subject: SSO binding is an Identity link (SS-4/SS-8, migration 104).';

-- ── §4.1 — the Identity provider (A23.1) ──────────────────────────────────
--
-- Every column is a VALUE A DEPLOYMENT SUPPLIES; none of them is a branch in
-- code. That is the whole agnosticism argument (§4.5(a)), and the eight shape
-- classes of annex §10a name which real product behaviour each one absorbs.
CREATE TABLE IF NOT EXISTS identity_providers (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        VARCHAR(128) NOT NULL,
  status                      VARCHAR(16)  NOT NULL DEFAULT 'disabled'
                                CHECK (status IN ('active','disabled')),

  -- Protocol. `issuer` is compared byte-exact; endpoints are NEVER templated
  -- from it (§4.2) — they are read from the validated discovery document.
  issuer                      TEXT NOT NULL,
  discovery_url               TEXT NOT NULL,
  client_id                   TEXT NOT NULL,
  client_auth_method          VARCHAR(32) NOT NULL DEFAULT 'client_secret_basic'
                                CHECK (client_auth_method IN
                                  ('client_secret_basic','client_secret_post','private_key_jwt','none')),
  -- §4.4 / SS-7: ciphertext under the §7.2 envelope keyset, never plaintext,
  -- never revealed on any surface. An operator who loses the secret rotates
  -- it at the Identity provider, not by reading it back from the board.
  client_secret_ct            TEXT,
  client_secret_key_id        VARCHAR(64),
  client_private_key_ct       TEXT,
  client_private_key_key_id   VARCHAR(64),
  scopes_requested            TEXT NOT NULL DEFAULT 'openid profile email',
  -- A bounded key/value map: `prompt`, `hd`, `acr_values`, `resource` and a
  -- provider's own required parameter, supplied without code.
  extra_authorize_params      JSONB NOT NULL DEFAULT '{}',
  -- §4.2: the value-scoped exemption for endpoints legitimately off the
  -- issuer origin. A whole-surface exemption hides what nobody reviewed.
  additional_endpoint_origins JSONB NOT NULL DEFAULT '[]',

  -- Claims. `groups_claim` is a DOTTED PATH so `realm_access.roles` is
  -- expressible (shape class 2). There is deliberately NO subject_claim: the
  -- link key is the OIDC `sub` and it is not configurable (SS-4).
  handle_claim                VARCHAR(128) NOT NULL DEFAULT 'preferred_username',
  display_name_claim          VARCHAR(128) NOT NULL DEFAULT 'name',
  email_claim                 VARCHAR(128) NOT NULL DEFAULT 'email',
  groups_claim                VARCHAR(256),
  required_claims             JSONB NOT NULL DEFAULT '{}',

  -- Behaviour.
  -- SS-21 / T-SS8: the operator MUST declare this; there is no default. A
  -- provider that cannot declare immutable, never-recycled subjects takes
  -- A19.2's "or no linking" branch — see the status CHECK below.
  subject_immutable           BOOLEAN NOT NULL,
  provisioning_mode           VARCHAR(16) NOT NULL DEFAULT 'invited'
                                CHECK (provisioning_mode IN ('invited','directory','jit')),
  group_binding_mode          VARCHAR(16) NOT NULL DEFAULT 'off'
                                CHECK (group_binding_mode IN ('off','claim')),
  -- SS-5 / T-SS12: per-provider, owner-set, audited. NEVER a global switch.
  allow_private_issuer_address BOOLEAN NOT NULL DEFAULT false,
  -- SSO-R5: claim matching is offered only behind its conditions, and this
  -- switch DEFAULTS OFF. It amends SS-11's absolute form by declaration; the
  -- remaining conditions (email_verified, single Identity provider, audited,
  -- refused for elevated roles) are enforced on the matching path.
  allow_claim_matching        BOOLEAN NOT NULL DEFAULT false,
  -- SSO-R16: per-provider opt-in, defaulting OFF, for retaining the ID token
  -- as an `id_token_hint`. Storage design addendum authored with this wave.
  retain_id_token             BOOLEAN NOT NULL DEFAULT false,
  provider_owns_profile       BOOLEAN NOT NULL DEFAULT false,
  clock_skew_seconds          INTEGER NOT NULL DEFAULT 60
                                CHECK (clock_skew_seconds BETWEEN 0 AND 300),
  session_ttl_seconds         INTEGER
                                CHECK (session_ttl_seconds IS NULL OR session_ttl_seconds BETWEEN 60 AND 2592000),
  authentication_request_ttl_seconds INTEGER NOT NULL DEFAULT 600
                                CHECK (authentication_request_ttl_seconds BETWEEN 60 AND 3600),
  backchannel_logout_enabled  BOOLEAN NOT NULL DEFAULT false,

  -- Health. Recorded, never silently retried into a different behaviour.
  last_discovery_at           TIMESTAMPTZ,
  last_discovery_error_present BOOLEAN NOT NULL DEFAULT false,
  jwks_refreshed_at           TIMESTAMPTZ,

  created_by_principal_id     UUID REFERENCES principals(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- SS-21: declared `false` (or flipped to false) cannot be active. The
  -- application refuses this with a NAMED error at configuration time; this
  -- CHECK is the floor under that, so no other writer can reach the state.
  CONSTRAINT identity_providers_immutable_subject_to_activate
    CHECK (status <> 'active' OR subject_immutable),
  -- SS-22: `directory` mode has no producer until W4's rung writes `expected`
  -- links. Refused at configuration time rather than silently binding by
  -- whatever a sync happened to write. W4 drops exactly this constraint.
  CONSTRAINT identity_providers_directory_mode_not_yet_enableable
    CHECK (status <> 'active' OR provisioning_mode <> 'directory')
);

-- The `iss` comparison is byte-exact, so one issuer is one Identity provider.
CREATE UNIQUE INDEX IF NOT EXISTS ux_identity_providers_issuer ON identity_providers(issuer);

-- SS-14a (owner ruling D3): EXACTLY ONE ENABLED Identity provider in v1,
-- enforced at the write. SSO-R5's claim-matching conditions depend on it, so
-- it cannot wait for W3 — W3 discharges the formal acceptance row, this index
-- is the enforcement. A constant-expression partial unique index admits at
-- most one row satisfying the predicate.
CREATE UNIQUE INDEX IF NOT EXISTS ux_identity_providers_single_active
  ON identity_providers((true)) WHERE status = 'active';

COMMENT ON TABLE identity_providers IS
  'Identity provider (A23.1): owner-plane configuration of ONE external OIDC issuer. Root-gated (/identity-providers); mints no scope family (A23.6).';

-- ── §6.2 / SS-8 / SS-24 — the Identity link (A23.2, extending A19.2) ──────
--
-- ONE table carries both producers under `link_kind`. Two tables mapping
-- external identities to Accounts would be two revocation stories, which is
-- the drift class C6 doctrine makes unrepresentable.
--
-- AZ-18 is not breached: an Identity link has no secret, no hash and nothing
-- to present. It authenticates nothing on its own — it RECORDS that a proof
-- happened.
CREATE TABLE IF NOT EXISTS identity_links (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_principal_id     UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  link_kind                VARCHAR(16) NOT NULL CHECK (link_kind IN ('sso','platform')),
  -- SS-24: `expected` is written ONLY by the directory sync and records "this
  -- Account is expected to authenticate as this subject at this Identity
  -- provider". No session may ever reference one.
  state                    VARCHAR(16) NOT NULL DEFAULT 'proven'
                             CHECK (state IN ('expected','proven')),

  -- SSO arm (A23.2 tuple).
  -- RESTRICT, not CASCADE (review round 2, R1 B1 / R3 B2). §7.3 says the table
  -- holds many rows "so a provider can be replaced without destroying links",
  -- and SS-8/A19.2 give an Identity link ONE revocation story that retains the
  -- row. A cascade from a normal owner-plane DELETE bypassed both: it erased
  -- the stored proof and its revocation history, and left the login session
  -- that link had authenticated alive with null bindings — the exact shape a
  -- local password session has. A provider that has ever linked anyone is
  -- retired by DISABLING it; only one that never did can be deleted.
  identity_provider_id     UUID REFERENCES identity_providers(id) ON DELETE RESTRICT,
  subject                  TEXT,

  -- Platform arm (A19.2 tuple, unchanged).
  platform_provider        VARCHAR(64),
  workspace_id             VARCHAR(255),
  external_user_id         VARCHAR(255),

  established_by           UUID REFERENCES principals(id),
  established_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at              TIMESTAMPTZ,
  last_seen_at             TIMESTAMPTZ,
  revoked_at               TIMESTAMPTZ,
  revoke_reason            VARCHAR(64),

  -- Both CHECK arms: the columns of one producer are populated EXACTLY when
  -- that producer owns the row. The bad state is unrepresentable at the
  -- write, which is the lesson C2 paid four rounds for.
  CONSTRAINT identity_links_sso_arm CHECK (
    (link_kind = 'sso') = (identity_provider_id IS NOT NULL AND subject IS NOT NULL)
  ),
  CONSTRAINT identity_links_platform_arm CHECK (
    (link_kind = 'platform') =
      (platform_provider IS NOT NULL AND workspace_id IS NOT NULL AND external_user_id IS NOT NULL)
  ),
  -- `promoted_at` is the instant the link became a proof. `expected` rows
  -- have none; `invited` and `jit` write `proven` directly and stamp it.
  CONSTRAINT identity_links_promoted_at_matches_state CHECK (
    (state = 'proven') = (promoted_at IS NOT NULL)
  ),
  -- Only the directory sync produces expectations, and only for the SSO arm.
  CONSTRAINT identity_links_expected_is_sso_only CHECK (
    state = 'proven' OR link_kind = 'sso'
  ),
  CONSTRAINT identity_links_subject_bounded CHECK (
    subject IS NULL OR (length(subject) > 0 AND octet_length(subject) <= 255)
  )
);

-- One subject at one Identity provider is at most one live link (SS-4).
CREATE UNIQUE INDEX IF NOT EXISTS ux_identity_links_sso_subject
  ON identity_links(identity_provider_id, subject)
  WHERE revoked_at IS NULL AND link_kind = 'sso';

-- An Account holds at most one live link per Identity provider (§6.3).
CREATE UNIQUE INDEX IF NOT EXISTS ux_identity_links_sso_account
  ON identity_links(identity_provider_id, account_principal_id)
  WHERE revoked_at IS NULL AND link_kind = 'sso';

-- A19.2's platform tuple, unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS ux_identity_links_platform_tuple
  ON identity_links(platform_provider, workspace_id, external_user_id)
  WHERE revoked_at IS NULL AND link_kind = 'platform';

CREATE INDEX IF NOT EXISTS ix_identity_links_account ON identity_links(account_principal_id);

COMMENT ON TABLE identity_links IS
  'Identity link (A23.2, extending A19.2): records that a proof happened. NOT a credential (AZ-18) — no secret, nothing to present.';

-- ── SS-19 — the session binding both federated logout kinds need ──────────
--
-- Without these two columns, subject-scoped back-channel logout is
-- UNRESOLVABLE, which is exactly why v1 of the design could not deliver it.
-- Every federated session names both the Identity provider that proved it and
-- the link it was proved through, so provider-scoped revocation is true BY
-- CONSTRUCTION rather than by a WHERE clause someone has to remember.
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS identity_provider_id UUID REFERENCES identity_providers(id) ON DELETE SET NULL;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS identity_link_id     UUID REFERENCES identity_links(id) ON DELETE SET NULL;
-- SSO-R16: the retained ID token, when the Identity provider opts in. Under
-- the SAME §7.2 envelope keyset (SS-7); disposal is bound to session death.
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS id_token_ct     TEXT;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS id_token_key_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS ix_auth_sessions_provider_sid
  ON auth_sessions(identity_provider_id, oidc_sid) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_auth_sessions_link
  ON auth_sessions(identity_link_id) WHERE revoked_at IS NULL;

COMMENT ON COLUMN auth_sessions.identity_provider_id IS
  'SS-19: the Identity provider that proved this session. NULL for local password sessions.';
COMMENT ON COLUMN auth_sessions.identity_link_id IS
  'SS-19: the Identity link this session was proved through. NULL for local password sessions.';

-- ── SS-24 — an expectation is never a proof, AT THE DATABASE BOUNDARY ─────
--
-- v6 of the design said "a CHECK forbids" this. A row CHECK cannot query
-- another table, so that was an invariant with no vehicle (round-6 F3). The
-- vehicle is a constraint trigger, the pattern this tree already uses for
-- exactly this class of cross-row rule (094_groups.sql:58-85).
--
-- THE PREDICATE IS BOTH HALVES: `state = 'proven' AND revoked_at IS NULL`.
-- v7 wrote only the state half, which let a REVOKED link stay `proven` and
-- keep passing (round-7 F2) — a revoked proof still usable through an
-- authenticated session, against A19.2's rule that links die on unlink. The
-- state check and the liveness check are ONE predicate; splitting them was
-- the defect.
CREATE OR REPLACE FUNCTION enforce_session_link_is_proven() RETURNS trigger AS $$
DECLARE
  link_state    TEXT;
  link_revoked  BOOLEAN;
BEGIN
  IF NEW.identity_link_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT state, revoked_at IS NOT NULL
    INTO link_state, link_revoked
    FROM identity_links WHERE id = NEW.identity_link_id;
  IF link_state IS NULL THEN
    RAISE EXCEPTION 'auth_sessions.identity_link_id % names no Identity link', NEW.identity_link_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF link_state <> 'proven' THEN
    RAISE EXCEPTION 'a login session may not reference an Identity link in state ''%'' (SS-24): an expectation is not a proof', link_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF link_revoked THEN
    RAISE EXCEPTION 'a login session may not reference a REVOKED Identity link (SS-24): a revoked proof is not a proof'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auth_sessions_link_proven ON auth_sessions;
CREATE TRIGGER trg_auth_sessions_link_proven
  BEFORE INSERT OR UPDATE OF identity_link_id ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION enforce_session_link_is_proven();

-- A link cannot reverse under a live session.
CREATE OR REPLACE FUNCTION enforce_identity_link_no_reversal() RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'proven' AND NEW.state = 'expected' THEN
    RAISE EXCEPTION 'an Identity link cannot revert from proven to expected (SS-24)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_identity_links_no_reversal ON identity_links;
CREATE TRIGGER trg_identity_links_no_reversal
  BEFORE UPDATE ON identity_links
  FOR EACH ROW EXECUTE FUNCTION enforce_identity_link_no_reversal();

-- SS-24 liveness: "unlinking a link with a live session either revokes that
-- session in the same transaction or REFUSES the transition — never leaves
-- it." A DEFERRED constraint trigger is what makes both halves true: the
-- service revokes link and sessions together and commits; a caller that
-- revokes only the link is refused AT COMMIT rather than leaving a window.
CREATE OR REPLACE FUNCTION enforce_revoked_link_has_no_live_sessions() RETURNS trigger AS $$
DECLARE
  live BIGINT;
BEGIN
  IF NEW.revoked_at IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO live
    FROM auth_sessions
   WHERE identity_link_id = NEW.id AND revoked_at IS NULL;
  IF live > 0 THEN
    RAISE EXCEPTION 'revoking Identity link % leaves % live login session(s) (SS-24): revoke them in the same transaction', NEW.id, live
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_identity_links_revocation_kills_sessions ON identity_links;
CREATE CONSTRAINT TRIGGER trg_identity_links_revocation_kills_sessions
  AFTER UPDATE OF revoked_at ON identity_links
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_revoked_link_has_no_live_sessions();

-- ── SS-18 — the pending-authentication row ────────────────────────────────
--
-- The vehicle EVERY §5.3 refusal depends on. v1 of the design described this
-- row in prose and never gave it a schema, which left `state`, `nonce`, PKCE
-- and consume-on-attempt unreachable from the delivery plan.
--
-- This is deliberately NOT C6's `oauth_authorization_requests`. That table
-- carries the authorization-SERVER leg — a third-party client's request for
-- authority over a board Account. This one carries the relying-PARTY leg —
-- the board's own request for an identity. Different lifecycles, different
-- secrets, different consumers, OPPOSITE TRUST DIRECTIONS. Sharing one table
-- would be precisely the role confusion SS-1 exists to prevent.
CREATE TABLE IF NOT EXISTS sso_authentication_requests (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The row NAMES the Identity provider, so the token endpoint dialled at the
  -- callback is THAT provider's, whatever the response claims (T-SS4).
  identity_provider_id UUID NOT NULL REFERENCES identity_providers(id) ON DELETE CASCADE,
  -- The raw values are NEVER stored: a database read must not let its holder
  -- complete a pending flow.
  state_hash           TEXT NOT NULL,
  nonce_hash           TEXT NOT NULL,
  -- The PKCE verifier must be SENT, so it is the one recoverable secret:
  -- encrypted under the §7.2 envelope keyset, same keyset, canary and
  -- rotation as SS-7. Never revealed on any surface.
  pkce_verifier_ct     TEXT NOT NULL,
  pkce_key_id          VARCHAR(64) NOT NULL,
  -- Recorded as sent, so the exchange cannot silently use a different one.
  redirect_uri         TEXT NOT NULL,
  -- SS-17: an OPAQUE server-side reference. Never a URL, never a path, never
  -- anything a caller can compose.
  return_ref           TEXT,
  -- §8.3: `auth_time` is compared against `requested_at`, not against "now".
  max_age_requested    INTEGER,
  requested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,
  -- Set on the ATTEMPT, not on success.
  consumed_at          TIMESTAMPTZ,
  consumed_outcome     VARCHAR(64)
);

-- Consumption is ONE conditional statement keyed on this index, so two
-- concurrent callbacks cannot both proceed; the loser sees zero rows.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sso_auth_requests_state ON sso_authentication_requests(state_hash);
CREATE INDEX IF NOT EXISTS ix_sso_auth_requests_sweep ON sso_authentication_requests(expires_at, consumed_at);

COMMENT ON TABLE sso_authentication_requests IS
  'SS-18: the relying-party pending-authentication row. Single-use is enforced by the WRITE (one conditional UPDATE), never by a read-then-write.';

-- ── SS-22 — the Invitation (A23.8) ────────────────────────────────────────
--
-- SS-20 forbids any provisioning mode selecting an existing Account by
-- matching a claim string; SS-22 is the VEHICLE that makes the replacement
-- buildable. A withdrawn takeover path whose replacement cannot be built is
-- not a repair (round-4 F3).
CREATE TABLE IF NOT EXISTS sso_invitations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_provider_id    UUID NOT NULL REFERENCES identity_providers(id) ON DELETE CASCADE,
  account_principal_id    UUID REFERENCES principals(id) ON DELETE CASCADE,
  new_account_intent      BOOLEAN NOT NULL,
  -- At least 128 bits of randomness, stored ONLY as a SHA-256 digest —
  -- nothing on the board can re-issue it.
  secret_hash             TEXT NOT NULL,
  -- Profile fields for the `new_account_intent` case: the invitation names
  -- the Account it will create, server-side, so no claim ever selects one.
  intended_handle         VARCHAR(64),
  expires_at              TIMESTAMPTZ NOT NULL,
  consumed_at             TIMESTAMPTZ,
  consumed_link_id        UUID REFERENCES identity_links(id) ON DELETE SET NULL,
  created_by_principal_id UUID REFERENCES principals(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The invitation either NAMES an existing Account or declares an intent to
  -- create one — never both, never neither.
  CONSTRAINT sso_invitations_account_xor_intent CHECK (
    (account_principal_id IS NOT NULL) = (new_account_intent = false)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sso_invitations_secret ON sso_invitations(secret_hash);
CREATE INDEX IF NOT EXISTS ix_sso_invitations_provider ON sso_invitations(identity_provider_id);

COMMENT ON TABLE sso_invitations IS
  'Invitation (A23.8, SS-22): owner-plane-minted, single-use, expiring authorization for ONE Account to be bound at ONE Identity provider. Consumed by one conditional UPDATE with the Identity provider IN THE PREDICATE.';

-- ── SS-23 — the logout-token replay store ─────────────────────────────────
--
-- "Single-use" needed a vehicle and until v5 had none. CONSUMPTION IS THE
-- INSERT: a duplicate violates the primary key and the request is refused, so
-- two concurrent replays cannot both proceed and there is no check-then-act.
--
-- The key is issuer-scoped BY THE COMPOSITE KEY ITSELF, so two Identity
-- providers may legitimately emit the same `jti`.
--
-- Retention is bound by a lifetime the contract itself defines: §5.3 gains a
-- maximum accepted age for logout tokens (300s), and this row stores that
-- token's OWN `expires_at`, swept only after the later of that instant plus
-- skew and the maximum age. No accepted token can outlive its row (round-5 F6).
CREATE TABLE IF NOT EXISTS sso_logout_token_uses (
  identity_provider_id UUID NOT NULL REFERENCES identity_providers(id) ON DELETE CASCADE,
  -- The token's `jti` where the Identity provider emits one, the SHA-256 of
  -- the compact token otherwise.
  replay_key           TEXT NOT NULL,
  seen_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The accepted token's own `exp`, so the sweep cannot outlive validity.
  token_expires_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (identity_provider_id, replay_key)
);

CREATE INDEX IF NOT EXISTS ix_sso_logout_token_uses_sweep ON sso_logout_token_uses(token_expires_at);

COMMENT ON TABLE sso_logout_token_uses IS
  'SS-23: back-channel logout-token replay store. Consumption IS the INSERT — a duplicate violates the composite primary key.';

-- ── SS-12 — the board Group directory binding ─────────────────────────────
--
-- Strategy §2.9 rules "board-minted immutable group ID, with the Identity
-- provider's group identifier as ONE binding source and local assignment as
-- another". The board half existed (094_groups.sql); the binding half did
-- not, so that sentence had no home in the schema.
--
-- `external_group_ref` is an OPAQUE STRING MATCHED EXACTLY — never parsed,
-- never split on `/`, never case-folded. Shape class 3 is the reason: the
-- same field must hold a directory GUID, a `/path` and a bare name without
-- the code knowing which it is looking at.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS identity_provider_id UUID REFERENCES identity_providers(id) ON DELETE SET NULL;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS external_group_ref   TEXT;

-- A binding is both columns or neither. Groups with no binding are local-only
-- and untouched by every sync path (AZ-30's `source=local` rule, one level up).
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_directory_binding_complete;
ALTER TABLE groups ADD CONSTRAINT groups_directory_binding_complete
  CHECK ((identity_provider_id IS NULL) = (external_group_ref IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS ux_groups_directory_binding
  ON groups(identity_provider_id, external_group_ref)
  WHERE identity_provider_id IS NOT NULL;

-- Deleting an Identity provider UNBINDS its Groups; it never deletes them and
-- never leaves one half-bound.
--
-- The column FK is ON DELETE SET NULL, which would null the provider and leave
-- `external_group_ref` populated - exactly the state
-- `groups_directory_binding_complete` forbids, so the delete would fail and an
-- Identity provider with any bound Group could never be removed at all.
--
-- Clearing BOTH columns first is what SS-12 already implies: a board Group is
-- board-minted and its id is immutable (A17.6), so losing its provider leaves
-- it local-only - "Groups with no binding are local-only and are untouched by
-- every sync path" - rather than destroying board-owned data.
CREATE OR REPLACE FUNCTION unbind_groups_from_identity_provider() RETURNS trigger AS $$
BEGIN
  UPDATE groups
     SET identity_provider_id = NULL, external_group_ref = NULL, updated_at = now()
   WHERE identity_provider_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_identity_providers_unbind_groups ON identity_providers;
CREATE TRIGGER trg_identity_providers_unbind_groups
  BEFORE DELETE ON identity_providers
  FOR EACH ROW EXECUTE FUNCTION unbind_groups_from_identity_provider();

COMMENT ON COLUMN groups.external_group_ref IS
  'SS-12: an opaque string matched EXACTLY — never parsed, never split, never case-folded (shape class 3).';
