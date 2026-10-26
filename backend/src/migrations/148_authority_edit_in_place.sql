-- 148_authority_edit_in_place.sql — AUTHZ amendment AZ-A13 "Edit in place for
-- authority objects" (RATIFIED 2026-10-11, ruling E95, with the answers E93 and
-- E94; card 1a38270d, stage 2; reserved in backend/src/migrations/RESERVED
-- before this file was written, ruling 0464ad54 §2).
--
-- Clause 16, the migration sketch, built additively:
--
--   - approvals: the kind CHECK gains 'authority-edit' (AZ-A9 clause 1: "Each
--     follow-on kind widens that CHECK in its own migration"), and the edit
--     columns: the object (credential, warrant or grant) and its id, the
--     server's snapshot BEFORE, the full state REQUESTED and the state the
--     decider APPROVED, and the revert record of clause 6j (E94): the lifetime
--     the decider chose ("keep" or "until-task"), the revert date, and the
--     stamp the sweep writes once it has reverted;
--   - the WHEN 'authority-edit' arm of approvals_kind_shape, inserted BEFORE the
--     ELSE arm. Migration 145 kept 142's shape (one agent-mint arm, one ELSE arm
--     with nested kind conjuncts), so clause 7 P-1's "one WHEN branch per kind"
--     did not land as worded; the E73 rule ("one implementation") is met by
--     re-stating 145's constraint with the new arm inserted and every other arm
--     carried BYTE-IDENTICAL, plus the edit columns NULL on every other kind
--     (145's own precedent for its three new columns). The live suite proves
--     the grant and credential conjuncts are 145's by deparse equality;
--   - approvals_lifecycle_stamps: an approved authority-edit carries who decided,
--     when, the approved state and the lifetime, and is never collected;
--   - the one-way trigger: an approved authority-edit is terminal;
--   - the relation trigger exempts authority-edit (its related task and phase
--     are optional references, clause 6a);
--   - the immutability trigger: the edit's request (object, before, requested)
--     never changes after filing, and after approval nothing of the decision
--     changes except edit_reverted_at, stamped once;
--   - "until-task requires related_task_id or edit_revert_at" holds AT THE
--     APPROVE TRANSITION, as a trigger, not a CHECK: related_task_id is ON
--     DELETE SET NULL (142:43-46, 142:88-91), so a CHECK would turn every hard
--     delete of the related task into a constraint violation. The delete
--     terminal runs the revert first (utils/accessRequestTerminal.ts);
--   - one pending edit per object (partial unique index), and a partial index
--     for the revert sweep;
--   - warrant_events: the action CHECK gains 'warrant.amended' (clause 10h);
--   - access_surfaces: PATCH /credentials/:id joins settings.access-manager and
--     PATCH /grants/:id joins settings.access-grants (clause 15a), by an
--     additive UPDATE on 142's pattern.
--
-- The lapse reason TARGET_CHANGED needs no DDL: lapse_reason has no CHECK
-- (098:155). principal_credentials, warrants and grants are NOT touched: an
-- edit writes their existing columns in place (clause 9a). No data migration.
--
-- Independent of migration 147 (another lane's reservation): that file touches
-- services, knowledge_write_audit and operation_idempotency_records only, so
-- either integration order is legal (ruling 0464ad54 §2).
--
-- Replay-safe: every statement is IF [NOT] EXISTS, CREATE OR REPLACE, a
-- DROP/ADD of a named constraint or trigger, an UPDATE that appends only what
-- is absent, or a COMMENT, so re-running this file is a no-op.

-- ── clause 6i / clause 16: the kind ───────────────────────────────────────

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('agent-mint', 'grant', 'credential', 'authority-edit'));

-- ── clause 6a / clause 16: the edit columns ───────────────────────────────

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS edit_object_type TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS edit_object_id UUID;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS edit_before JSONB;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS edit_requested JSONB;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS edit_approved JSONB;
-- clause 6j (E94): the revert record.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS edit_lifetime TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS edit_revert_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS edit_reverted_at TIMESTAMPTZ;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_edit_object_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_edit_object_type_check
  CHECK (edit_object_type IS NULL OR edit_object_type IN ('credential', 'warrant', 'grant'));
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_edit_lifetime_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_edit_lifetime_check
  CHECK (edit_lifetime IS NULL OR edit_lifetime IN ('keep', 'until-task'));

-- ── the shape each kind's row must have (replaces 145's) ──────────────────
--
-- The agent-mint arm is 145's, plus: the edit columns stay NULL. The
-- authority-edit arm is new (clause 16). The ELSE arm is 145's, unchanged —
-- the shared non-mint bounds and the grant and credential conjuncts byte for
-- byte — plus ONE top-level conjunct: the edit columns stay NULL.
--
-- The authority-edit arm:
--   - the object, its id, the snapshot before and the requested state are set,
--     and the three states are JSON objects;
--   - EXACTLY ONE binding: an agent filed it (requesting_credential_id) or a
--     person acted (session_evidence: the one-act door);
--   - no requested scopes or rows, no requested or approved expiry, no target
--     task, no written grants, no issued credential, no minted principal, none
--     of the credential kind's pin and label;
--   - the reason is 20-2,000 characters when an agent filed it or the item is
--     pending, and otherwise absent or within those bounds (the one-act door's
--     reason is optional, clause 6b);
--   - a revert date belongs to an until-task lifetime, and the revert stamp to
--     an APPROVED until-task row.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_shape;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_shape CHECK (
  CASE kind
    WHEN 'agent-mint' THEN
      grantee_principal_id IS NULL AND reason IS NULL
      AND requested_expires_at IS NULL AND approved_expires_at IS NULL
      AND related_task_id IS NULL AND related_phase_id IS NULL
      AND created_grant_ids IS NULL AND issued_credential_id IS NULL
      AND requested_transport IS NULL AND approved_transport IS NULL AND credential_label IS NULL
      AND edit_object_type IS NULL AND edit_object_id IS NULL AND edit_before IS NULL
      AND edit_requested IS NULL AND edit_approved IS NULL
      AND edit_lifetime IS NULL AND edit_revert_at IS NULL AND edit_reverted_at IS NULL
    WHEN 'authority-edit' THEN
      edit_object_type IS NOT NULL AND edit_object_id IS NOT NULL
      AND edit_before IS NOT NULL AND edit_requested IS NOT NULL
      AND jsonb_typeof(edit_before) = 'object' AND jsonb_typeof(edit_requested) = 'object'
      AND (edit_approved IS NULL OR jsonb_typeof(edit_approved) = 'object')
      AND ((requesting_credential_id IS NOT NULL) <> (session_evidence IS NOT NULL))
      AND requested_scopes = '[]'::jsonb AND requested_rules = '[]'::jsonb
      AND requested_expires_at IS NULL AND approved_expires_at IS NULL
      AND target_task_id IS NULL AND created_grant_ids IS NULL
      AND issued_credential_id IS NULL AND minted_principal_id IS NULL
      AND requested_transport IS NULL AND approved_transport IS NULL AND credential_label IS NULL
      AND (CASE WHEN requesting_credential_id IS NOT NULL OR status = 'pending'
             THEN reason IS NOT NULL AND char_length(reason) BETWEEN 20 AND 2000
             ELSE reason IS NULL OR char_length(reason) BETWEEN 20 AND 2000 END)
      AND (edit_revert_at IS NULL OR edit_lifetime = 'until-task')
      AND (edit_reverted_at IS NULL OR (status = 'approved' AND edit_lifetime = 'until-task'))
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
      AND (edit_object_type IS NULL AND edit_object_id IS NULL AND edit_before IS NULL
        AND edit_requested IS NULL AND edit_approved IS NULL
        AND edit_lifetime IS NULL AND edit_revert_at IS NULL AND edit_reverted_at IS NULL)
  END
);

-- ── approvals_lifecycle_stamps (145's), with the authority-edit stamps ────
--
-- 145's arms are unchanged, except that the first one (098's: an approved or
-- collected row carries decided_at, approved_scopes and collect_expires_at)
-- exempts authority-edit as it exempts grant: an edit approval sets neither
-- approved_scopes nor a collect window. Added: an APPROVED authority-edit
-- carries who decided, when, the approved state and the lifetime (clause 6j:
-- "An approved authority-edit requires edit_lifetime"), and an authority-edit
-- is never collected (clause 6f: "Nothing is collected").
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_lifecycle_stamps;
ALTER TABLE approvals ADD CONSTRAINT approvals_lifecycle_stamps CHECK (
  (kind IN ('grant', 'authority-edit') OR status NOT IN ('approved', 'collected')
    OR (decided_at IS NOT NULL AND approved_scopes IS NOT NULL AND collect_expires_at IS NOT NULL))
  AND (kind <> 'grant' OR status <> 'approved'
    OR (decided_at IS NOT NULL AND decided_by_principal_id IS NOT NULL
        AND approved_rules IS NOT NULL AND approved_expires_at IS NOT NULL
        AND created_grant_ids IS NOT NULL AND cardinality(created_grant_ids) > 0))
  AND (kind <> 'grant' OR status <> 'collected')
  AND (kind <> 'credential' OR status NOT IN ('approved', 'collected')
    OR (decided_by_principal_id IS NOT NULL AND approved_expires_at IS NOT NULL AND approved_transport IS NOT NULL))
  AND (kind <> 'credential' OR status <> 'collected' OR issued_credential_id IS NOT NULL)
  AND (kind <> 'authority-edit' OR status <> 'approved'
    OR (decided_at IS NOT NULL AND decided_by_principal_id IS NOT NULL
        AND edit_approved IS NOT NULL AND edit_lifetime IS NOT NULL))
  AND (kind <> 'authority-edit' OR status <> 'collected')
  AND (status <> 'denied' OR decided_at IS NOT NULL)
  AND (status <> 'collected' OR (collected_at IS NOT NULL AND minted_principal_id IS NOT NULL))
  AND (status <> 'lapsed' OR lapse_reason IS NOT NULL)
);

-- ── the relation trigger (142's), exempting authority-edit ────────────────
--
-- clause 6a: an authority-edit's related task and phase are optional
-- references. Every other non-mint kind still names one at filing.
CREATE OR REPLACE FUNCTION enforce_access_request_relation() RETURNS trigger AS $$
BEGIN
  IF NEW.kind NOT IN ('agent-mint', 'authority-edit') AND NEW.related_task_id IS NULL AND NEW.related_phase_id IS NULL THEN
    RAISE EXCEPTION 'a % request names its related task or phase (AZ-A9 clause 3)', NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── the immutability trigger (145's), with the edit request ───────────────
--
-- 145's two rules are unchanged. Added for kind authority-edit: the object,
-- its id, the snapshot before and the requested state never change after
-- filing (clause 6d: "The decider may never add a field, change the object, or
-- change the kind"); and once the item is APPROVED, nothing of the decision
-- changes — the approved state, the lifetime, the revert date — except the
-- revert stamp, written once (clause 16: "edit_reverted_at is stamped at most
-- once, on an approved row; the one-way and immutability triggers admit that
-- stamp, and nothing else, after approval").
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
  IF OLD.kind = 'authority-edit' AND (
       NEW.edit_object_type IS DISTINCT FROM OLD.edit_object_type
       OR NEW.edit_object_id IS DISTINCT FROM OLD.edit_object_id
       OR NEW.edit_before IS DISTINCT FROM OLD.edit_before
       OR NEW.edit_requested IS DISTINCT FROM OLD.edit_requested) THEN
    RAISE EXCEPTION 'approval %: the edited object, its state before and the requested state never change after filing (AZ-A13 clause 6)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind = 'authority-edit' AND OLD.status = 'approved' AND (
       NEW.edit_approved IS DISTINCT FROM OLD.edit_approved
       OR NEW.edit_lifetime IS DISTINCT FROM OLD.edit_lifetime
       OR NEW.edit_revert_at IS DISTINCT FROM OLD.edit_revert_at
       OR (OLD.edit_reverted_at IS NOT NULL AND NEW.edit_reverted_at IS DISTINCT FROM OLD.edit_reverted_at)
       OR (OLD.edit_reverted_at IS NULL AND NEW.edit_reverted_at IS NOT NULL AND OLD.edit_lifetime <> 'until-task')) THEN
    RAISE EXCEPTION 'approval %: an approved edit never changes; only its revert is stamped, once (AZ-A13 clauses 6j and 16)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind = 'authority-edit' AND OLD.status <> 'approved'
     AND NEW.edit_reverted_at IS DISTINCT FROM OLD.edit_reverted_at THEN
    RAISE EXCEPTION 'approval %: only an approved edit is reverted (AZ-A13 clause 16)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approvals_request_immutable ON approvals;
CREATE TRIGGER trg_approvals_request_immutable
  BEFORE UPDATE OF kind, grantee_principal_id, requested_rules, requested_expires_at,
                   requested_scopes, requested_transport, credential_label,
                   edit_object_type, edit_object_id, edit_before, edit_requested,
                   edit_approved, edit_lifetime, edit_revert_at, edit_reverted_at ON approvals
  FOR EACH ROW EXECUTE FUNCTION enforce_approval_request_immutable();

-- ── the one-way trigger (142's), with authority-edit ──────────────────────
--
-- 098's and 142's rules stand. An approved authority-edit is terminal too
-- (clause 6f): its effect is the edit it applied in the decide act.
CREATE OR REPLACE FUNCTION enforce_approval_one_way() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('denied', 'collected', 'lapsed') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'approval % is single-use (A17.11): % is terminal', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind = 'grant' AND OLD.status = 'approved' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'approval % is single-use (AZ-A9 clause 1): an approved grant request is terminal', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind = 'authority-edit' AND OLD.status = 'approved' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'approval % is single-use (AZ-A13 clause 6f): an approved authority edit is terminal', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── clause 6j / clause 16: "until-task requires related_task_id or
-- edit_revert_at", at the approve transition ───────────────────────────────
--
-- Checked when a row ENTERS approved (inserted approved by the one-act door, or
-- updated to approved by a decide), never afterwards: the related task's FK is
-- ON DELETE SET NULL, and a hard delete must stay possible (the delete
-- terminal reverts the widening first).
CREATE OR REPLACE FUNCTION enforce_authority_edit_lifetime() RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'authority-edit' AND NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved')
     AND NEW.edit_lifetime = 'until-task'
     AND NEW.related_task_id IS NULL AND NEW.edit_revert_at IS NULL THEN
    RAISE EXCEPTION 'approval %: a widening approved until its task ends names the task or a revert date (AZ-A13 clause 6j)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approvals_authority_edit_lifetime ON approvals;
CREATE TRIGGER trg_approvals_authority_edit_lifetime
  BEFORE INSERT OR UPDATE OF status ON approvals
  FOR EACH ROW EXECUTE FUNCTION enforce_authority_edit_lifetime();

-- ── clause 6b: one pending edit per object; clause 6j: the sweep's index ──

CREATE UNIQUE INDEX IF NOT EXISTS ux_approvals_authority_edit_pending
  ON approvals (edit_object_type, edit_object_id)
  WHERE kind = 'authority-edit' AND status = 'pending';
CREATE INDEX IF NOT EXISTS ix_approvals_authority_edit_revert
  ON approvals (edit_revert_at)
  WHERE edit_lifetime = 'until-task' AND edit_reverted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_approvals_authority_edit_object
  ON approvals (edit_object_type, edit_object_id)
  WHERE kind = 'authority-edit';

-- ── clause 10h: warrant_events gains warrant.amended ──────────────────────
--
-- 098 declared the CHECK inline, so PostgreSQL named it
-- warrant_events_action_check (read from pg_constraint before this DROP).
ALTER TABLE warrant_events DROP CONSTRAINT IF EXISTS warrant_events_action_check;
ALTER TABLE warrant_events ADD CONSTRAINT warrant_events_action_check CHECK (action IN
  ('warrant.created', 'warrant.updated', 'warrant.suspended', 'warrant.resumed',
   'warrant.revoked', 'warrant.expired', 'warrant.minted', 'warrant.amended'));

-- ── clause 15a: the two new write families ────────────────────────────────
--
-- PATCH /credentials/:id joins settings.access-manager (always-self; its
-- credential reveal and revoke families are there already) and PATCH
-- /grants/:id joins settings.access-grants, whose every family stays
-- root-gated under the route map, so AZ-A5's governable rule still holds. 109
-- seeds its catalogue once and is shipped history, so the families are added
-- by an additive UPDATE that appends each only when the row does not carry it
-- yet (replay-safe). A catalogue without the row is left unchanged.
UPDATE access_surfaces AS s
   SET write_families = s.write_families || ARRAY(
         SELECT family FROM unnest(ARRAY['PATCH /credentials/:id']::text[]) AS family
          WHERE NOT (family = ANY (s.write_families)))
 WHERE s.key = 'settings.access-manager';
UPDATE access_surfaces AS s
   SET write_families = s.write_families || ARRAY(
         SELECT family FROM unnest(ARRAY['PATCH /grants/:id']::text[]) AS family
          WHERE NOT (family = ANY (s.write_families)))
 WHERE s.key = 'settings.access-grants';

-- ── comments ──────────────────────────────────────────────────────────────

COMMENT ON COLUMN approvals.kind IS
  'AZ-A9 clause 1, ratified 2026-10-10 (E43; card 785e1eed): agent-mint (every pre-142 row; §6.1 unchanged) · grant (writes expiring grant rows on the requester''s chain-root Account at approval, clause 12) · credential (issues ONE Connector credential at collect, clause 13) · authority-edit (AZ-A13, ratified 2026-10-11, E95: edits an existing Connector credential, warrant or grant in place at approval; filable by a Connector for its own credential''s scopes from migration 148). Never changes after filing.';
COMMENT ON COLUMN approvals.edit_object_type IS
  'AZ-A13 clause 6a: the object an authority-edit changes in place: credential, warrant or grant. NULL on every other kind.';
COMMENT ON COLUMN approvals.edit_object_id IS
  'AZ-A13 clause 6a: the id of the edited object. The object keeps it (clause 1). One pending edit per object (clause 6b).';
COMMENT ON COLUMN approvals.edit_before IS
  'AZ-A13 clauses 6a and 6e: the server''s snapshot of the object''s editable fields at filing (allowlisted, never a secret). The edit applies only while the object still equals it; otherwise the item lapses TARGET_CHANGED.';
COMMENT ON COLUMN approvals.edit_requested IS
  'AZ-A13 clause 6a: the full editable state requested after the edit. Never changes after filing.';
COMMENT ON COLUMN approvals.edit_approved IS
  'AZ-A13 clause 6d: the state the decider approved, at or below edit_requested on every field. Set at approval; never changes afterwards.';
COMMENT ON COLUMN approvals.edit_lifetime IS
  'AZ-A13 clause 6j (E94): how long an approved widening lasts, the decider''s choice: keep (until someone narrows it) or until-task (reverted when the related task is completed or archived, or at edit_revert_at, whichever comes first).';
COMMENT ON COLUMN approvals.edit_revert_at IS
  'AZ-A13 clause 6j: the date an until-task widening is reverted at, when the decider set one.';
COMMENT ON COLUMN approvals.edit_reverted_at IS
  'AZ-A13 clause 6j: when the sweep reverted this widening (only what it added and is still present), or closed the record because the object was no longer live. Stamped once.';
