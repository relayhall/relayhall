-- 147_knowledge_write_door.sql — RB-11 Governor v0, the CORE DOOR (card
-- b796067e; ratified design RB-11-GOVERNOR-V0 v3, ruling E97, declared change
-- D-8). Reserved in backend/src/migrations/RESERVED before this file existed
-- (ruling 0464ad54 section 2).
--
-- Three changes, one implicit transaction, no COMMIT. Every statement is
-- replay-safe: re-running this file against a database that already has it
-- changes nothing. database/init.sql is untouched.
--
-- ── 1. services.knowledge_write_endpoint (design C.12, D-8, D-9) ──
--
-- The owner-plane BASE URL of a source's write surface. Core appends the verb
-- (`/propose`, `/preview`, `/commit`) at dial time, so the column names one
-- surface and never a verb. NULL = the source accepts no writes, which is the
-- state of every Service until an owner sets it (H-G2 on PROD).
--
-- It rides the SAME trust surface as the query endpoint (migration 114):
-- written only through the owner-plane act, https only, dialed under the
-- same allowed networks and the same channel credential. Two named CHECKs,
-- each guarded by pg_constraint exactly as 114 guards its three:
--
--   knowledge_source_write_https_only   https or nothing;
--   knowledge_source_write_needs_query  a write endpoint needs the query
--                                       endpoint, so it also inherits 114's
--                                       credential requirement
--                                       (knowledge_source_credential_required).
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS knowledge_write_endpoint TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_source_write_https_only'
  ) THEN
    ALTER TABLE services ADD CONSTRAINT knowledge_source_write_https_only
      CHECK (knowledge_write_endpoint IS NULL OR knowledge_write_endpoint LIKE 'https://%');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_source_write_needs_query'
  ) THEN
    ALTER TABLE services ADD CONSTRAINT knowledge_source_write_needs_query
      CHECK (knowledge_write_endpoint IS NULL OR knowledge_query_endpoint IS NOT NULL);
  END IF;
END $$;

COMMENT ON COLUMN services.knowledge_write_endpoint IS
  'RB-11 Governor v0 (D-8): owner-plane base URL of the source write surface; core appends /propose, /preview or /commit. https only; requires knowledge_query_endpoint. Written only through the owner-plane act.';

-- ── 2. knowledge_write_audit (design C.15) ──
--
-- The core's half of the write audit, and the one place the core keeps
-- anything about a write. It is FAIL-CLOSED, which reverses migration 116's
-- read-audit trade (finding F10): the executor writes an `intent` row BEFORE
-- it dials and an `outcome` row after, and a failed insert fails the act. No
-- intent row, no dial.
--
-- WHAT IT CAN HOLD. Every column is an id, an enum, a digest or a bounded
-- token: there is NO free-text column, so note content, a title, a tag or a
-- raw source ref cannot be represented in a row even by mistake (the 116
-- `ref_sha256` argument, applied to the whole table). The ref is stored as a
-- sha256 core computes, never raw.
--
-- IDS AS VALUES, NOT FOREIGN KEYS, for the reason 116 records: a forensic
-- row must not lose its answer because its subject was deleted afterwards,
-- and an ON DELETE action would UPDATE an append-only row.
--
-- JOIN KEYS (C.15): `assertion_jti` = the jti the source records on its write
-- event; `proposal_id` ties propose, preview and commit together, and is how
-- the core binds a commit to the principal that proposed (C.8 step 1).
CREATE TABLE IF NOT EXISTS knowledge_write_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The `auditRef` the response returns; the shape mcp/shape.ts renders.
  audit_ref TEXT NOT NULL CHECK (audit_ref ~ '^ka_[0-9a-f]{32}$'),
  phase TEXT NOT NULL CHECK (phase IN ('intent', 'outcome')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  op TEXT NOT NULL CHECK (op IN ('propose', 'preview', 'commit')),
  -- WHO: the acting principal and the credential it presented (NULL for a
  -- login session), and the root Account the assertion attests.
  acting_principal_id UUID,
  credential_id UUID,
  account_principal_id UUID,
  -- WHERE: the source dialed (or named), and the proposal the act concerns.
  source_id UUID,
  proposal_id UUID,
  -- The jti of the write assertion this act sent, a base64url token.
  assertion_jti TEXT CHECK (assertion_jti IS NULL OR assertion_jti ~ '^[A-Za-z0-9_-]{16,128}$'),
  -- The core-attested task context (C.3): both or neither.
  task_id UUID,
  project_id UUID,
  -- `dialing` on an intent row; the core-authored outcome token otherwise.
  outcome TEXT NOT NULL CHECK (outcome ~ '^[a-z_]{1,64}$'),
  -- Digests and the opaque compartment id from the source's answer.
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  compartment TEXT CHECK (compartment IS NULL
    OR compartment ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  ref_sha256 TEXT CHECK (ref_sha256 IS NULL OR ref_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT knowledge_write_audit_phase_unique UNIQUE (audit_ref, phase),
  CONSTRAINT knowledge_write_audit_task_context CHECK ((task_id IS NULL) = (project_id IS NULL)),
  CONSTRAINT knowledge_write_audit_intent_dials CHECK (phase = 'outcome' OR outcome = 'dialing')
);

-- The proposal binding read on every preview and commit.
CREATE INDEX IF NOT EXISTS idx_knowledge_write_audit_proposal
  ON knowledge_write_audit (proposal_id)
  WHERE op = 'propose' AND phase = 'outcome' AND outcome = 'proposed';
CREATE INDEX IF NOT EXISTS idx_knowledge_write_audit_account
  ON knowledge_write_audit (account_principal_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_write_audit_order
  ON knowledge_write_audit (occurred_at DESC, id DESC);

-- APPEND-ONLY through 116's own trigger function, with ENABLE ALWAYS so a
-- replica-mode session cannot skip it.
DROP TRIGGER IF EXISTS trg_knowledge_write_audit_no_update_delete ON knowledge_write_audit;
CREATE TRIGGER trg_knowledge_write_audit_no_update_delete
BEFORE UPDATE OR DELETE ON knowledge_write_audit
FOR EACH ROW EXECUTE FUNCTION reject_knowledge_audit_mutation();
ALTER TABLE knowledge_write_audit ENABLE ALWAYS TRIGGER trg_knowledge_write_audit_no_update_delete;

COMMENT ON TABLE knowledge_write_audit IS
  'RB-11 Governor v0 (C.15) — append-only, FAIL-CLOSED record of every knowledge write act: intent before the dial, outcome after. Ids, enums and digests only; no column can hold note content or a raw ref. Reading is owner-plane/root authority.';

-- ── 3. The retry contract gains `knowledge.note.commit` ──
--
-- `POST /knowledge-writes/commit` mounts the shared retry middleware
-- (middleware/idempotency.ts), credential-scoped by ruling 3's default and
-- replay `return`: the stored receipt is the commit answer — a sealed handle,
-- the sha256 and the compartment id, never note content. Propose and preview
-- are NOT keyed: their answer carries the rendered bytes, and a stored
-- receipt would put note content in the core.
--
-- 138's two named CHECKs are the closed SQL binding of the declaration
-- table; they are redefined here verbatim plus the new operation, the
-- forward-amend precedent of 133 and 138. DROP ... IF EXISTS keeps a replay
-- of this file a no-op.
ALTER TABLE operation_idempotency_records
  DROP CONSTRAINT IF EXISTS operation_idempotency_operation_policy;
ALTER TABLE operation_idempotency_records
  ADD CONSTRAINT operation_idempotency_operation_policy
  CHECK (
    (operation IN ('task.create', 'task.stream.append', 'task.reference.create',
                   'task.note.append', 'task.patch', 'report.create',
                   'project.create', 'project.resource.create', 'phase.create',
                   'knowledge.note.commit')
     AND replay_policy = 'return')
    OR
    (operation IN ('agent.mint.request', 'agent.mint.collect', 'task.report.save')
     AND replay_policy = 'refuse')
  );

ALTER TABLE operation_idempotency_records
  DROP CONSTRAINT IF EXISTS operation_idempotency_operation_scope;
ALTER TABLE operation_idempotency_records
  ADD CONSTRAINT operation_idempotency_operation_scope
  CHECK (
    (operation IN ('task.create', 'task.patch', 'task.stream.append',
                   'agent.mint.request', 'agent.mint.collect', 'phase.create', 'task.report.save',
                   'knowledge.note.commit')
     AND split_part(scope, ':', 1) IN ('cred', 'user'))
    OR
    (operation IN ('task.reference.create', 'task.note.append', 'report.create',
                   'project.create', 'project.resource.create')
     AND split_part(scope, ':', 1) IN ('prin', 'user'))
  );
