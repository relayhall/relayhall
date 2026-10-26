-- 145_access_requests_credential_kind.sql — AZ-A9 clause 13, the CREDENTIAL
-- kind (card 785e1eed slice P1-B-2, lane claude-p1b2-credential-kind; reserved
-- in backend/src/migrations/RESERVED before this file was written, ruling
-- 0464ad54 §2).
--
-- AZ-A9 was ratified 2026-10-10 (E43). Migration 142 built its schema half for
-- kind 'grant' and ADMITTED kind 'credential' without making it filable. This
-- file makes the credential kind's rows exactly what clause 13 allows, at the
-- database, whatever path writes them:
--
--   "A request to issue ONE Connector credential. ... The request carries
--    scopes (never root or *:admin), a transport pin, a mandatory expires_at
--    (default 14 days, at most 90; E15 parity with clause 3) ... Approval
--    records the authorization only. ... COLLECT re-runs every check and
--    creates ... the credential ... It records the target Connector in
--    minted_principal_id ... It records the issued credential in a new
--    nullable approvals.issued_credential_id, and clause 12a revokes through
--    that column."
--
-- Slice P1-B-2 builds ONE target: the requesting Connector itself (the night
-- brief's "an agent asks over MCP for scopes it lacks"). A credential for
-- another existing Connector or for a new Connector, and the optional bundled
-- grant rows, are refused by name at filing (TARGET_NOT_AVAILABLE,
-- BUNDLED_ROWS_NOT_AVAILABLE) and are unrepresentable here: the credential arm
-- pins requested_rules to [] and minted_principal_id to the requester.
--
-- Migration 142 is shipped text and is not edited (D-06): its two comments
-- that ratification made wrong are restated with COMMENT ON at the end.
--
-- Replay-safe: every statement is IF [NOT] EXISTS, CREATE OR REPLACE, a
-- DROP/ADD of a named constraint or trigger, or a COMMENT, so re-running this
-- file is a no-op.

-- ── clause 13: the transport pin and the label ────────────────────────────
--
-- requested_transport: the pin the requester asks for (default: the pin of the
-- credential it files with). approved_transport: the pin the decider approved,
-- equal to the request or narrowed from 'any' to 'mcp' or 'api' (clause 8:
-- never wider). credential_label: the label the issued credential carries.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS requested_transport TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS approved_transport TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS credential_label TEXT;

-- ── the shape each kind's row must have (replaces 142's) ──────────────────
--
-- The agent-mint arm is 142's, plus: the three new columns stay NULL. The
-- shared non-mint bounds are 142's ELSE arm, unchanged. The grant arm is 142's,
-- plus the three new columns NULL. The credential arm is new:
--   - at least one requested scope, and NEITHER root NOR any *:admin scope,
--     requested or approved (clause 11, "validateRequestedScopes rules 2-3 for
--     credentials"; clause 13 "scopes (never root or *:admin)");
--   - the approved scopes, once there are any, a NON-EMPTY subset of the
--     requested ones (clause 8: the decider may untick, never add);
--   - a transport pin in the vocabulary, and an approved pin equal to it or
--     narrowed from 'any' (clause 8);
--   - no rows and no written grants (bundled rows are not built in P1-B-2);
--   - an issued credential named only on a COLLECTED request (collect is the
--     one writer of issued_credential_id, and collected is terminal);
--   - the collected target is the requester itself (the one target built).
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_shape;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_shape CHECK (
  CASE kind
    WHEN 'agent-mint' THEN
      grantee_principal_id IS NULL AND reason IS NULL
      AND requested_expires_at IS NULL AND approved_expires_at IS NULL
      AND related_task_id IS NULL AND related_phase_id IS NULL
      AND created_grant_ids IS NULL AND issued_credential_id IS NULL
      AND requested_transport IS NULL AND approved_transport IS NULL AND credential_label IS NULL
    ELSE
      grantee_principal_id IS NOT NULL
      AND requesting_credential_id IS NOT NULL AND session_evidence IS NULL
      AND reason IS NOT NULL AND char_length(reason) BETWEEN 20 AND 2000
      AND requested_expires_at IS NOT NULL
      AND requested_expires_at > requested_at
      AND requested_expires_at <= requested_at + INTERVAL '90 days'
      AND (approved_expires_at IS NULL OR approved_expires_at <= requested_expires_at)
      AND target_task_id IS NULL
      AND (kind <> 'grant' OR (
        jsonb_typeof(requested_rules) = 'array' AND jsonb_array_length(requested_rules) > 0
        AND requested_scopes = '[]'::jsonb
        AND issued_credential_id IS NULL AND minted_principal_id IS NULL
        AND requested_transport IS NULL AND approved_transport IS NULL AND credential_label IS NULL))
      AND (kind <> 'credential' OR (
        jsonb_typeof(requested_scopes) = 'array' AND jsonb_array_length(requested_scopes) > 0
        AND NOT jsonb_path_exists(requested_scopes, '$[*] ? (@ == "root" || @ like_regex ":admin$")')
        AND (approved_scopes IS NULL OR (
          jsonb_typeof(approved_scopes) = 'array' AND jsonb_array_length(approved_scopes) > 0
          AND requested_scopes @> approved_scopes
          AND NOT jsonb_path_exists(approved_scopes, '$[*] ? (@ == "root" || @ like_regex ":admin$")')))
        AND requested_transport IN ('any', 'mcp', 'api')
        AND (approved_transport IS NULL OR approved_transport = requested_transport
             OR (requested_transport = 'any' AND approved_transport IN ('mcp', 'api')))
        AND requested_rules = '[]'::jsonb AND created_grant_ids IS NULL
        AND (issued_credential_id IS NULL OR status = 'collected')
        AND (credential_label IS NULL OR char_length(credential_label) BETWEEN 1 AND 100)
        AND (minted_principal_id IS NULL OR minted_principal_id = requester_principal_id)))
  END
);

-- ── approvals_lifecycle_stamps (142's), with the credential stamps ────────
--
-- 142's arms are unchanged; the 098 arm already makes an approved or
-- collected credential request carry decided_at, approved_scopes and
-- collect_expires_at, and a collected one collected_at and minted_principal_id.
-- Added: an APPROVED credential request carries who decided, the approved
-- expiry and the approved pin; a COLLECTED one names the credential it issued
-- (clause 13: "clause 12a revokes through that column").
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_lifecycle_stamps;
ALTER TABLE approvals ADD CONSTRAINT approvals_lifecycle_stamps CHECK (
  (kind = 'grant' OR status NOT IN ('approved', 'collected')
    OR (decided_at IS NOT NULL AND approved_scopes IS NOT NULL AND collect_expires_at IS NOT NULL))
  AND (kind <> 'grant' OR status <> 'approved'
    OR (decided_at IS NOT NULL AND decided_by_principal_id IS NOT NULL
        AND approved_rules IS NOT NULL AND approved_expires_at IS NOT NULL
        AND created_grant_ids IS NOT NULL AND cardinality(created_grant_ids) > 0))
  AND (kind <> 'grant' OR status <> 'collected')
  AND (kind <> 'credential' OR status NOT IN ('approved', 'collected')
    OR (decided_by_principal_id IS NOT NULL AND approved_expires_at IS NOT NULL AND approved_transport IS NOT NULL))
  AND (kind <> 'credential' OR status <> 'collected' OR issued_credential_id IS NOT NULL)
  AND (status <> 'denied' OR decided_at IS NOT NULL)
  AND (status <> 'collected' OR (collected_at IS NOT NULL AND minted_principal_id IS NOT NULL))
  AND (status <> 'lapsed' OR lapse_reason IS NOT NULL)
);

-- ── clause 8: the request never changes after filing (replaces 142's) ─────
--
-- 142's rule is unchanged for every kind: the kind, the grantee, the requested
-- rows and the requested expiry. For the AZ-A9 kinds the requested SCOPES, the
-- requested PIN and the LABEL are the request too, so they are added — for
-- non-mint rows only, so an agent-mint row's update behaviour stays exactly
-- 142's (clause 16).
CREATE OR REPLACE FUNCTION enforce_approval_request_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.grantee_principal_id IS DISTINCT FROM OLD.grantee_principal_id
     OR NEW.requested_rules IS DISTINCT FROM OLD.requested_rules
     OR NEW.requested_expires_at IS DISTINCT FROM OLD.requested_expires_at THEN
    RAISE EXCEPTION 'approval %: the kind, grantee and requested authority never change after filing (AZ-A9 clause 8)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind <> 'agent-mint' AND (
       NEW.requested_scopes IS DISTINCT FROM OLD.requested_scopes
       OR NEW.requested_transport IS DISTINCT FROM OLD.requested_transport
       OR NEW.credential_label IS DISTINCT FROM OLD.credential_label) THEN
    RAISE EXCEPTION 'approval %: the requested scopes, transport pin and label never change after filing (AZ-A9 clauses 8 and 13)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approvals_request_immutable ON approvals;
CREATE TRIGGER trg_approvals_request_immutable
  BEFORE UPDATE OF kind, grantee_principal_id, requested_rules, requested_expires_at,
                   requested_scopes, requested_transport, credential_label ON approvals
  FOR EACH ROW EXECUTE FUNCTION enforce_approval_request_immutable();

CREATE INDEX IF NOT EXISTS ix_approvals_issued_credential ON approvals(issued_credential_id)
  WHERE issued_credential_id IS NOT NULL;

-- ── D-06: 142's two comments, restated as ratified ────────────────────────

COMMENT ON COLUMN approvals.kind IS
  'AZ-A9 clause 1, ratified 2026-10-10 (E43; card 785e1eed): agent-mint (every pre-142 row; §6.1 unchanged) · grant (writes expiring grant rows on the requester''s chain-root Account at approval, clause 12) · credential (issues ONE Connector credential at collect, clause 13; filable from migration 145). Never changes after filing.';
COMMENT ON COLUMN approvals.related_task_id IS
  'AZ-A9 clauses 3 and 12a: the task this request is attached to. When it reaches completed or archived (either terminal writer) or is deleted, the request''s grant rows are revoked (or handed over to a linking assignment), the credential it issued is revoked, and a pending or approved-uncollected request lapses TASK_TERMINAL; reopening never restores them.';
COMMENT ON COLUMN approvals.related_phase_id IS
  'AZ-A9 clauses 3 and 12a (phase arm, ratified 2026-10-10, E43 Q3): the related phase. For a request naming ONLY a phase, phase completed or archived revokes its grant rows and its issued credential and lapses it PHASE_TERMINAL, as for a task; restoring the phase restores nothing.';
COMMENT ON COLUMN approvals.issued_credential_id IS
  'AZ-A9 clause 13: the Connector credential a credential-kind Approval issued at collect. Clause 12a revokes through it. Never a secret: the secret renders once in the collect response and is never stored here.';
COMMENT ON COLUMN approvals.requested_transport IS
  'AZ-A9 clause 13: the transport pin (any, mcp, api) a credential request asks for; default the pin of the credential it was filed with. NULL on every other kind.';
COMMENT ON COLUMN approvals.approved_transport IS
  'AZ-A9 clauses 8 and 13: the pin the decider approved, equal to the requested one or narrowed from any to mcp or api. NULL until approved, and on every other kind.';
COMMENT ON COLUMN approvals.credential_label IS
  'AZ-A9 clause 13: the label the issued credential carries (1-100 characters; the server names it when the request does not). NULL on every other kind.';
