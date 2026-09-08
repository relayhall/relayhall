-- 062_identity_substrate.sql
-- Identity anchor + credentials + (dormant) server sessions + seeds.
-- Additive only. gen_random_uuid() available since 053 (pgcrypto).
--
-- Nothing here is read or written by the code shipping alongside it: every
-- object is inert until the resolution pipeline lands. That is deliberate, so
-- this migration can be applied to a running system with no behaviour change.

CREATE TABLE IF NOT EXISTS principals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                VARCHAR(16) NOT NULL CHECK (kind IN ('human','agent','service')),
  handle              VARCHAR(64) NOT NULL UNIQUE,   -- == today's identity strings, 1:1
  display_name        VARCHAR(255),
  status              VARCHAR(16) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','disabled')),
  role                VARCHAR(32) CHECK (role IN
                        ('admin','operator','editor','user','viewer',      -- human vocabulary
                         'orchestrator','reviewer','qa','agent')),          -- automation vocabulary
  source_tag          VARCHAR(255),                  -- spawn join key (tool-task-<id8>)
  harness             VARCHAR(32) CHECK (harness IN ('openclaw','hermes')),
  agent_type_id       UUID REFERENCES agent_types(id) ON DELETE SET NULL,  -- persona, NOT identity
  parent_principal_id UUID REFERENCES principals(id) ON DELETE SET NULL,   -- spawn lineage
  last_seen_at        TIMESTAMPTZ,
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_principals_source_tag
  ON principals(source_tag) WHERE source_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_principals_kind ON principals(kind);

CREATE TABLE IF NOT EXISTS principal_credentials (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id             UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  credential_type          VARCHAR(16) NOT NULL CHECK (credential_type IN
                             ('api_key','jwt_subject','legacy_env','password')),
  key_id                   VARCHAR(64),   -- api_key: public 12-char id | jwt_subject: OIDC sub | legacy_env: env var name
  secret_hash              TEXT,          -- sha256 hex (api_key/legacy_env), bcrypt (password), NULL (jwt_subject)
  label                    VARCHAR(128),
  scopes                   JSONB NOT NULL DEFAULT '[]',
  expires_at               TIMESTAMPTZ,
  revoked_at               TIMESTAMPTZ,
  last_used_at             TIMESTAMPTZ,
  created_by_principal_id  UUID REFERENCES principals(id),
  metadata                 JSONB NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((credential_type = 'jwt_subject') = (secret_hash IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pcred_active_key_id
  ON principal_credentials(key_id) WHERE revoked_at IS NULL AND key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_pcred_principal ON principal_credentials(principal_id);

-- Server-side human sessions. DORMANT: no code writes this until the OIDC
-- vehicle activates it behind CLAWBOARD_SESSIONS. It ships here so there is
-- exactly one canonical substrate migration and no second one ever competes
-- for a ledger number.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id   UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL,                -- sha256 of opaque 32-byte token; raw token never stored
  role_snapshot  VARCHAR(32),                  -- RETAINED, UNUSED: no login path writes it (SSO design d95136d7 SS-9)
  credential_id  UUID REFERENCES principal_credentials(id) ON DELETE SET NULL,
  oidc_sid       VARCHAR(255),                 -- back-channel logout correlation
  ip             INET,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoke_reason  VARCHAR(64)                   -- 'logout'|'idp_backchannel'|'disabled_user'|'admin'|'expired_sweep'
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_auth_sessions_token ON auth_sessions(token_hash);
CREATE INDEX IF NOT EXISTS ix_auth_sessions_principal ON auth_sessions(principal_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_auth_sessions_expires ON auth_sessions(expires_at);

-- Seed rows: handle === today's exact identity strings, so once resolution
-- lands, req.userId = handle and every existing switch keeps working unchanged.
-- Roles mirror today's effective automation-role output: parity, not a grant.
-- Display names are neutral because migrations are public-snapshot-eligible.
INSERT INTO principals (kind, handle, display_name, role, harness) VALUES
  ('human',   'dashboard_user',     'Owner',                                      'orchestrator', NULL),
  ('service', 'system',             'ClawBoard internal automation',              NULL,           NULL),
  ('service', 'service_account',    'Legacy shared API key',                      'agent',        NULL),
  ('service', 'journal_publisher',  'Journal publish pipeline',                   NULL,           NULL),
  ('service', 'reports_reader',     'Knowledge-fabric reports reader',            NULL,           NULL),
  ('agent',   'hermes_task_agent',  'Hermes spawned task agents (legacy shared)', 'agent',        'hermes'),
  ('agent',   'clawbeat_qa',        'Clawbeat QA',                                'qa',           'openclaw'),
  ('agent',   'clawbeat_reviewer',  'Clawbeat reviewer',                          'reviewer',     'openclaw'),
  ('agent',   'hermes_qa',          'Hermes QA',                                  'qa',           'hermes'),
  ('agent',   'hermes_qa_reviewer', 'Hermes QA reviewer',                         'reviewer',     'hermes')
ON CONFLICT (handle) DO NOTHING;

-- The system principal is an actor for request-less internal writes only; the
-- issuance API refuses to mint credentials for it.
UPDATE principals SET metadata = jsonb_set(metadata, '{no_credentials}', 'true')
 WHERE handle = 'system' AND (metadata->>'no_credentials') IS DISTINCT FROM 'true';
