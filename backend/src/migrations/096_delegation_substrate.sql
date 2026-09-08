-- 096_delegation_substrate.sql
-- RH-P3.AZ-S3 (card 25e5fb92): the delegation substrate (AUTHZ design
-- 4d961e37 §3, §5, §7, §10; vocabulary amendments A17.1–A17.3, A17.10).
--
-- THREE LAYERS ON ONE principals TABLE (§3): Account = parentless
-- (human|service, session-auth only), Connector = Account-owned delegated
-- service identity, Agent = task-bounded short-lived identity. This
-- migration adds the delegation columns, the layer-shape CHECKs, the
-- `terminated` status (A17.10, sol B4), the credential columns for the §7
-- per-layer model, the step-up token store (§7.6), and the §10 legacy
-- disposition (sol r2-F2/r3-F2): every pre-096 row an A17 invariant
-- outlaws is marked legacy_identity=TRUE, EXEMPT from the new CHECKs,
-- frozen out of the new machinery at the service layer, and preserved
-- byte-intact. Fresh replay produces zero legacy rows.
--
-- principals.parent_principal_id (062 spawn lineage) is RE-FOUNDED here as
-- delegation lineage; pre-096 parented rows become legacy_identity rows.
--
-- NOTE on naming: the design's credential "key_id" column (the AEAD keyset
-- header, §7.2) is stored as encryption_key_id because principal_credentials
-- ALREADY carries key_id as the public rh_ key identifier (062) — a declared
-- naming deviation, same fact, collision-free.
--
-- Fresh-replay doctrine: database/init.sql untouched; idempotent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── principals: delegation columns ──────────────────────────────────────

ALTER TABLE principals ADD COLUMN IF NOT EXISTS bound_task_id UUID REFERENCES tasks(id);
ALTER TABLE principals ADD COLUMN IF NOT EXISTS own_expression JSONB;
ALTER TABLE principals ADD COLUMN IF NOT EXISTS terminated_at TIMESTAMPTZ;

-- A17.10 (review 731415a7 B2): hard delete of a principal with
-- descendants is FORBIDDEN — the 062 spawn-lineage FK (ON DELETE SET
-- NULL) is re-founded as delegation lineage with RESTRICT semantics, so a
-- parent delete refuses instead of silently orphaning descendants and
-- erasing their stored lineage. Idempotent: drop-and-recreate by name;
-- rows untouched.
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_parent_principal_id_fkey;
ALTER TABLE principals ADD CONSTRAINT principals_parent_principal_id_fkey
  FOREIGN KEY (parent_principal_id) REFERENCES principals(id) ON DELETE RESTRICT;

-- status vocabulary becomes active · disabled · terminated (A17.10).
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_status_check;
ALTER TABLE principals ADD CONSTRAINT principals_status_check
  CHECK (status IN ('active', 'disabled', 'terminated'));

-- ── §10 legacy disposition — ONE-TIME by construction (review 2fcd548c
-- B1): the disposition runs exactly when the legacy_identity column is
-- FIRST created, inside the same DO block, so a re-run of this file can
-- never reclassify valid post-096 Connectors/Agents as legacy. Pre-096
-- outlawed shapes: (a) parentless kind='agent' rows; (c) parented rows
-- predating the delegation contract; (b) parentless human/service rows
-- holding bearer credentials (Accounts are keyless under AZ-12/AZ-18) —
-- all preserved byte-intact on the §10 compatibility arm.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'principals'
      AND column_name = 'legacy_identity'
  ) THEN
    ALTER TABLE principals ADD COLUMN legacy_identity BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE principals SET legacy_identity = TRUE
     WHERE (kind = 'agent' AND parent_principal_id IS NULL)
        OR (parent_principal_id IS NOT NULL);
    UPDATE principals p SET legacy_identity = TRUE
     WHERE p.legacy_identity = FALSE
       AND p.parent_principal_id IS NULL
       AND p.kind IN ('human', 'service')
       AND EXISTS (SELECT 1 FROM principal_credentials c
                    WHERE c.principal_id = p.id
                      AND c.credential_type IN ('api_key', 'legacy_env'));
  END IF;
END $$;

-- Remediation-queue purpose backfill (sol M9) — same one-time guard: it
-- runs exactly when the purpose column is first created, so re-running
-- never overwrites a post-096 NULL left deliberately by an operator. The
-- NOT NULL constraint itself deliberately does NOT land here — new-row
-- purpose is service-enforced; the column constraint waits for the
-- remediation queue to drain (Phase 5).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'principals'
      AND column_name = 'purpose'
  ) THEN
    ALTER TABLE principals ADD COLUMN purpose TEXT;
    UPDATE principals SET purpose = 'LEGACY - pending owner review'
     WHERE purpose IS NULL AND parent_principal_id IS NULL AND kind = 'service';
  END IF;
END $$;

-- ── layer-shape CHECKs (legacy rows EXEMPT) ─────────────────────────────
-- human ⇒ parentless (A17.1).
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_human_parentless;
ALTER TABLE principals ADD CONSTRAINT principals_human_parentless
  CHECK (legacy_identity OR kind <> 'human' OR parent_principal_id IS NULL);
-- elevated role ⇒ parentless (AZ-RT1): anything above the minimal ceiling.
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_elevated_parentless;
ALTER TABLE principals ADD CONSTRAINT principals_elevated_parentless
  CHECK (legacy_identity
     OR parent_principal_id IS NULL
     OR role IS NULL
     OR role NOT IN ('admin', 'operator', 'orchestrator'));
-- new layer-3 rows are task-bound: kind='agent' with a parent carries a
-- bound task (parentless agent rows are legacy by backfill; the CHECK
-- refuses creating new ones).
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_agent_shape;
ALTER TABLE principals ADD CONSTRAINT principals_agent_shape
  CHECK (legacy_identity
     OR kind <> 'agent'
     OR (parent_principal_id IS NOT NULL AND bound_task_id IS NOT NULL));
-- terminated rows carry their timestamp.
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_terminated_stamp;
ALTER TABLE principals ADD CONSTRAINT principals_terminated_stamp
  CHECK ((status = 'terminated') = (terminated_at IS NOT NULL));

-- Chain shapes (§5.2 rule 6): Account → Connector → Agent and (human)
-- Account → Agent only; no agent→agent, no depth beyond 3. Parent kinds
-- need a row lookup, so this is a trigger, not a CHECK.
CREATE OR REPLACE FUNCTION enforce_delegation_chain_shape() RETURNS trigger AS $$
DECLARE
  parent_row RECORD;
BEGIN
  IF NEW.legacy_identity OR NEW.parent_principal_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT kind, parent_principal_id, status, legacy_identity INTO parent_row
    FROM principals WHERE id = NEW.parent_principal_id;
  IF parent_row IS NULL THEN
    RAISE EXCEPTION 'parent principal does not exist' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF parent_row.legacy_identity THEN
    RAISE EXCEPTION 'legacy identities are frozen out of the delegation machinery (T37): no new delegation under a legacy parent'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'service' THEN
    -- Connector: parent must be a parentless Account (human or service).
    IF parent_row.parent_principal_id IS NOT NULL OR parent_row.kind = 'agent' THEN
      RAISE EXCEPTION 'chain shape (§5.2 rule 6): a Connector''s parent must be a parentless Account'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'agent' THEN
    -- Agent: parent is a Connector (parented service) or a HUMAN Account.
    IF parent_row.kind = 'agent' THEN
      RAISE EXCEPTION 'chain shape (§5.2 rule 6): no agent→agent delegation'
        USING ERRCODE = 'check_violation';
    END IF;
    IF parent_row.kind = 'service' AND parent_row.parent_principal_id IS NULL THEN
      RAISE EXCEPTION 'chain shape (§3): a service Account is keyless and mints through a Connector — the Agent''s parent is the acting Connector (AZ-RT5)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF parent_row.kind = 'human' AND parent_row.parent_principal_id IS NOT NULL THEN
      RAISE EXCEPTION 'chain shape: a human parent must be a parentless Account'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'chain shape (A17.1): human principals are parentless Accounts'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_principals_chain_shape ON principals;
CREATE TRIGGER trg_principals_chain_shape
  BEFORE INSERT OR UPDATE OF parent_principal_id, kind ON principals
  FOR EACH ROW EXECUTE FUNCTION enforce_delegation_chain_shape();

-- ── terminated guards (A17.10, sol B4) ──────────────────────────────────
-- Re-enable REFUSES terminated principals: terminated is durable.
CREATE OR REPLACE FUNCTION enforce_terminated_is_final() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'terminated' AND NEW.status <> 'terminated' THEN
    RAISE EXCEPTION 'terminate is irreversible (A17.10): a terminated principal cannot be re-enabled'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_principals_terminated_final ON principals;
CREATE TRIGGER trg_principals_terminated_final
  BEFORE UPDATE OF status ON principals
  FOR EACH ROW EXECUTE FUNCTION enforce_terminated_is_final();

-- Credential issuance REFUSES terminated principals by consulting state.
CREATE OR REPLACE FUNCTION enforce_no_credentials_for_terminated() RETURNS trigger AS $$
DECLARE
  p_status TEXT;
BEGIN
  SELECT status INTO p_status FROM principals WHERE id = NEW.principal_id;
  IF p_status = 'terminated' THEN
    RAISE EXCEPTION 'credential issuance refuses terminated principals (A17.10)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pcred_no_terminated ON principal_credentials;
CREATE TRIGGER trg_pcred_no_terminated
  BEFORE INSERT ON principal_credentials
  FOR EACH ROW EXECUTE FUNCTION enforce_no_credentials_for_terminated();

-- ── credential columns (§7) ─────────────────────────────────────────────

ALTER TABLE principal_credentials ADD COLUMN IF NOT EXISTS transport VARCHAR(8) NOT NULL DEFAULT 'any';
ALTER TABLE principal_credentials DROP CONSTRAINT IF EXISTS pcred_transport_check;
ALTER TABLE principal_credentials ADD CONSTRAINT pcred_transport_check
  CHECK (transport IN ('any', 'mcp', 'api'));
ALTER TABLE principal_credentials ADD COLUMN IF NOT EXISTS secret_ciphertext TEXT;
ALTER TABLE principal_credentials ADD COLUMN IF NOT EXISTS encryption_key_id VARCHAR(64);
ALTER TABLE principal_credentials ADD COLUMN IF NOT EXISTS reveal_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE principal_credentials ADD COLUMN IF NOT EXISTS rotated_from_id UUID REFERENCES principal_credentials(id);
ALTER TABLE principal_credentials ADD COLUMN IF NOT EXISTS grace_until TIMESTAMPTZ;
-- Ciphertext and its keyset header travel together (§7.2, T30).
ALTER TABLE principal_credentials DROP CONSTRAINT IF EXISTS pcred_ciphertext_keyed;
ALTER TABLE principal_credentials ADD CONSTRAINT pcred_ciphertext_keyed
  CHECK ((secret_ciphertext IS NULL) = (encryption_key_id IS NULL));

-- ── step-up token store (§7.6, AZ-23) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS step_up_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  principal_id UUID NOT NULL REFERENCES principals(id),
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('password', 'oidc')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_step_up_tokens_principal ON step_up_tokens(principal_id, created_at DESC);

COMMENT ON COLUMN principals.own_expression IS
  'AZ-24: the stored, live-evaluated selector expression of a DELEGATED principal — {"scopes": "parent"|[...], "objects": "parent"|[rules]}. Inheritance is never implicit: a NON-legacy delegated principal with NULL own_expression evaluates to EMPTY authority (fail closed).';
COMMENT ON COLUMN principals.legacy_identity IS
  '§10 disposition (sol r2-F2/r3-F2): pre-096 rows an A17 invariant outlaws — preserved byte-intact, evaluated under the Phase-2 arms, EXEMPT from the new CHECKs, FROZEN OUT of the new machinery (no new issuance/delegation/membership/assignment), every authentication audited with a legacy marker, listed in the Access-manager remediation queue until the Phase-5 estate transition.';
COMMENT ON COLUMN principals.bound_task_id IS
  '§3/§8: NOT NULL for new layer-3 Agent rows — the task this identity is bounded to; write authority never leaves it (T36, sol B5).';
COMMENT ON COLUMN principal_credentials.transport IS
  '§7.5 (AZ-14): credential transport pin ∈ any|mcp|api, compared against the SERVER-DERIVED request provenance stamp only — never caller input.';
COMMENT ON COLUMN principal_credentials.secret_ciphertext IS
  '§7.2 (AZ-12/AZ-32): AEAD ciphertext of the full token under the RELAYHALL_CREDENTIAL_KEYS envelope keyset (encryption_key_id = keyset header). Written in ONE transaction with secret_hash from the same plaintext; reveal verifies H(decrypt)==hash (T30).';
COMMENT ON COLUMN principal_credentials.grace_until IS
  '§7.3: rotation grace watermark — a graced predecessor authenticates until grace_until and is never revealable; a new rotation immediately revokes any prior graced sibling (at most two live per chain).';
COMMENT ON TABLE step_up_tokens IS
  '§7.6 (AZ-23): short-lived SINGLE-USE elevation tokens bound to one named action + target; minted only after password/OIDC re-auth; consuming endpoint burns them.';
