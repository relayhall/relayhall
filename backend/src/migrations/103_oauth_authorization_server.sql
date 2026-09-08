-- 103: RH-P3.C6 — the OAuth 2.1 authorization server (Tier B front door).
--
-- Contract: strategy 4e40f06f Phase 3, ratified C3 amendment — "the OAuth 2.1
-- authorization server ... the budgeted price of Tier B clients, following
-- where MCP auth is going (Client ID Metadata Documents, not DCR)"; analysis
-- d8507677 §4 (P3.C6); runbook daf703a6 §5.
--
-- ── WHAT THIS SUBSTRATE DELIBERATELY DOES NOT ADD: A TOKEN STORE ──
--
-- Ruling TS-12 (record 7e7eeca3, telemetry sitting 2026-08-28) settles the
-- S-A6 §8 revocation duty: C6 issues OPAQUE REFERENCE access tokens with
-- per-call lookup, so very-next-call revocation is TRUE for this class —
-- "one honest story with the existing rh_ reference credentials".
--
-- The honest story is only honest if it is literally the same machinery. An
-- OAuth access token issued here IS an `rh_` credential row in
-- principal_credentials, minted through principalService.issueCredential onto
-- a Connector principal parented to the authorizing Account, and consumed by
-- the ONE acceptance path (utils/credentialAcceptance +
-- middleware/auth.acceptPrincipalKey). A parallel token table would have
-- given the surface a second revocation story, a second expiry story and a
-- second transport pin — which is exactly the drift class that
-- utils/credentialAcceptance was extracted to make unrepresentable.
--
-- So this migration adds only what the PROTOCOL needs and the credential
-- substrate cannot express: who the client is (a Client ID Metadata Document
-- URL, not a DCR registration), and the short-lived authorization request /
-- code that carries one human consent from the browser to the token endpoint.

-- ── oauth_clients — Client ID Metadata Documents, cached ──────────────────
--
-- CIMD, not DCR: the client_id IS an https URL that serves the client's own
-- metadata document. There is no registration endpoint and no client secret,
-- so there is nothing here a caller can create by asking — a row appears the
-- first time a real authorization request names that URL and the document
-- fetch succeeds under the outbound policy in services/OAuthClientMetadataService.
--
-- The row is a CACHE plus provenance, never an authority: every authorization
-- re-fetches (or re-validates a fresh-enough cache) and the redirect_uris used
-- for the exact-string match come from the document, not from this table's
-- history. document_sha256 makes a silently-changed document visible in audit.
CREATE TABLE IF NOT EXISTS oauth_clients (
  -- The Client ID Metadata Document URL. It is the client_id, verbatim.
  client_id          TEXT PRIMARY KEY,
  client_name        TEXT,
  -- The document's redirect_uris, as fetched. Used for display and audit;
  -- the live match is against the freshly validated document.
  redirect_uris      JSONB NOT NULL DEFAULT '[]',
  -- The whole validated document, so a review can see what was trusted.
  document           JSONB NOT NULL DEFAULT '{}',
  -- sha256 of the exact bytes fetched: a client that changes its document
  -- between authorizations is visible rather than silent.
  document_sha256    TEXT NOT NULL,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT oauth_clients_https CHECK (client_id LIKE 'https://%')
);

COMMENT ON TABLE oauth_clients IS
  'RH-P3.C6: Client ID Metadata Documents seen by the authorization server, cached with the sha256 of the exact bytes fetched. A cache and an audit trail, never an authority - every authorization validates a freshly fetched document (services/OAuthClientMetadataService).';

-- ── oauth_authorization_requests — one human consent, start to finish ─────
--
-- ONE row carries the whole authorization-code leg: the validated request
-- parameters (state 'pending'), the human's decision ('approved'/'denied'),
-- and the one-time consumption of the code at the token endpoint
-- ('consumed'). Keeping it in one row is what makes "one-time use" an atomic
-- UPDATE ... WHERE state = 'approved' RETURNING rather than a read-then-write
-- race across two tables.
--
-- NOTHING SECRET IS STORED IN THE CLEAR. The authorization code is held as a
-- sha256 digest exactly as principal_credentials holds its token digest, and
-- the PKCE code_challenge is by construction already a digest of the client's
-- verifier. The board therefore cannot replay a code it has issued.
CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  -- The exact redirect_uri string presented at /authorize, matched
  -- character-for-character against the document's redirect_uris (OAuth 2.1
  -- removes the prefix/substring matching that made open redirectors easy).
  redirect_uri          TEXT NOT NULL,
  -- OAuth 2.1: PKCE is REQUIRED and S256 is the only method this server
  -- accepts. The CHECK makes a plain-method row unrepresentable rather than
  -- relying on the handler having remembered.
  code_challenge        TEXT NOT NULL,
  code_challenge_method VARCHAR(8) NOT NULL CHECK (code_challenge_method = 'S256'),
  -- The scope strings requested, already validated against the ratified
  -- vocabulary (utils/scopeMap) at /authorize. The scopes GRANTED are stored
  -- separately: a human may approve less than was asked for.
  requested_scopes      JSONB NOT NULL DEFAULT '[]',
  granted_scopes        JSONB NOT NULL DEFAULT '[]',
  -- RFC 8707 resource indicator, when the client sends one.
  resource              TEXT,
  -- The client's opaque `state`, returned verbatim on the redirect.
  state                 TEXT,
  -- The human Account that consented. NULL until a decision is recorded.
  account_principal_id  UUID REFERENCES principals(id) ON DELETE CASCADE,
  -- The Connector minted for (this client, this Account) and the credential
  -- issued on it. Both NULL until the token endpoint consumes the code.
  connector_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL,
  credential_id         UUID REFERENCES principal_credentials(id) ON DELETE SET NULL,
  -- sha256 hex of the authorization code. Set when the human approves;
  -- the code itself is returned to the browser exactly once and never stored.
  code_hash             TEXT,
  state_name            VARCHAR(16) NOT NULL DEFAULT 'pending'
                          CHECK (state_name IN ('pending','approved','denied','consumed')),
  -- Absolute expiry, computed by the writer. Approval narrows it to the
  -- short code lifetime; a pending request expires on the consent window.
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at            TIMESTAMPTZ,
  consumed_at           TIMESTAMPTZ,
  -- An approved request carries its code digest and the consenting Account;
  -- a consumed one carries its consumption stamp. The states cannot drift
  -- from the columns that make them true.
  CONSTRAINT oauth_request_approved_shape CHECK (
    state_name <> 'approved' OR (code_hash IS NOT NULL AND account_principal_id IS NOT NULL)
  ),
  -- A consumed row carries its consumption stamp, and ONLY that. The
  -- credential is minted after the code is claimed, in the same transaction,
  -- so requiring it here would refuse the claim itself; and a REFUSED
  -- exchange (a wrong PKCE verifier) legitimately consumes the code without
  -- ever minting one, which is the anti-guessing property the token endpoint
  -- relies on.
  CONSTRAINT oauth_request_consumed_shape CHECK (
    state_name <> 'consumed' OR consumed_at IS NOT NULL
  ),
  CONSTRAINT oauth_request_decided_shape CHECK (
    (state_name IN ('pending')) = (decided_at IS NULL)
  )
);

-- One live code digest at a time; a consumed or denied row keeps its digest
-- for provenance without competing for the uniqueness the lookup relies on.
CREATE UNIQUE INDEX IF NOT EXISTS ux_oauth_request_live_code
  ON oauth_authorization_requests(code_hash)
  WHERE code_hash IS NOT NULL AND state_name = 'approved';
CREATE INDEX IF NOT EXISTS ix_oauth_request_client ON oauth_authorization_requests(client_id);
CREATE INDEX IF NOT EXISTS ix_oauth_request_expiry ON oauth_authorization_requests(expires_at);
CREATE INDEX IF NOT EXISTS ix_oauth_request_account ON oauth_authorization_requests(account_principal_id);

COMMENT ON TABLE oauth_authorization_requests IS
  'RH-P3.C6: one row per authorization-code leg - validated request, human decision, one-time code consumption. The code is stored as a sha256 digest only. The access token it produces is an ordinary rh_ credential row in principal_credentials (ruling TS-12), so revocation and expiry have exactly one implementation.';
