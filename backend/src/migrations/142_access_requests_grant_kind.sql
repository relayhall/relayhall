-- 142_access_requests_grant_kind.sql — AZ-A9 "Grant requests", clause 1
-- (card 785e1eed P1-B, lane claude-track-a-p1b-access-requests; reserved in
-- backend/src/migrations/RESERVED before this file was written, ruling
-- 0464ad54 §2).
--
-- AZ-A9 is a DRAFT amendment (AUTHZ-AMENDMENTS-E11-DRAFT v2) built under E-A
-- ahead of its ratification at the one batched sitting (E17). It amends design
-- 4d961e37 §6.1; this file is its schema half.
--
-- ONE NOUN (A17.11, quoted at 098:110 — "one noun on every surface: … the
-- approvals table"): a grant request is an Approval of kind 'grant', and an E8
-- credential request is an Approval of kind 'credential'. No second approvals
-- table is created. Every existing row is kind 'agent-mint', and its route,
-- tool, deciders and lifecycle stay unchanged byte for byte (clause 16): each
-- constraint below keeps the agent-mint arm exactly as 098 wrote it.
--
-- 'credential' is ADMITTED by the kind CHECK and NOT FILABLE yet: filing
-- refuses it KIND_NOT_AVAILABLE until slice P1-B-2 (clause 13). Its shape arm
-- below already binds the request fields it shares with 'grant'.
--
-- Replay-safe: every statement is IF [NOT] EXISTS, CREATE OR REPLACE, or a
-- DROP/ADD of a named constraint or trigger, so re-running this file is a
-- no-op.

-- ── clause 1: the kind ────────────────────────────────────────────────────

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'agent-mint';
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('agent-mint', 'grant', 'credential'));

-- target_task_id NOT NULL (098:144) becomes kind-aware: a mint names its
-- target Task; a grant or credential request names a RELATED task or phase
-- instead (clause 3).
ALTER TABLE approvals ALTER COLUMN target_task_id DROP NOT NULL;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_mint_target_present;
ALTER TABLE approvals ADD CONSTRAINT approvals_mint_target_present
  CHECK (kind <> 'agent-mint' OR target_task_id IS NOT NULL);

-- ── clause 3 (request and decision fields) and clause 13 ─────────────────
--
-- requested_scopes (098:145, NOT NULL) holds [] for kind 'grant'.
-- related_task_id / related_phase_id are ON DELETE SET NULL: a hard delete of
-- the related object reaps the request's grants FIRST (TaskManagerDB.deleteTask
-- and PhaseService.remove run the clause-12a hook before the DELETE), so the
-- FK never blocks a delete and never leaves a live request-made row behind.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS grantee_principal_id UUID REFERENCES principals(id);
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS requested_expires_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS approved_expires_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS related_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS related_phase_id UUID REFERENCES phases(id) ON DELETE SET NULL;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS created_grant_ids UUID[];
-- clause 13: the credential a credential-kind approval issued, so clause 12a
-- can revoke through it. Nullable and unused by the grant slice.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS issued_credential_id UUID REFERENCES principal_credentials(id);

-- The shape each kind's row must have. The agent-mint arm says the new columns
-- stay NULL, so a mint row cannot carry request fields. The grant arm makes the
-- clause-3 bounds true of every stored row, whatever path wrote it: a bound
-- credential (AZ-31c; never a session), a reason of 20–2,000 characters, an
-- expiry after filing and at most 90 days out (E15), at least one rule, no
-- scopes, and an approved expiry never later than the requested one (clause 8).
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_shape;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_shape CHECK (
  CASE kind
    WHEN 'agent-mint' THEN
      grantee_principal_id IS NULL AND reason IS NULL
      AND requested_expires_at IS NULL AND approved_expires_at IS NULL
      AND related_task_id IS NULL AND related_phase_id IS NULL
      AND created_grant_ids IS NULL AND issued_credential_id IS NULL
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
        AND issued_credential_id IS NULL AND minted_principal_id IS NULL))
  END
);

-- "At least one of related_task_id and related_phase_id is mandatory" holds AT
-- FILING. It is a BEFORE INSERT trigger rather than a CHECK because the FKs
-- above are ON DELETE SET NULL: a CHECK would turn every delete of a related
-- object into a constraint violation.
CREATE OR REPLACE FUNCTION enforce_access_request_relation() RETURNS trigger AS $$
BEGIN
  IF NEW.kind <> 'agent-mint' AND NEW.related_task_id IS NULL AND NEW.related_phase_id IS NULL THEN
    RAISE EXCEPTION 'a % request names its related task or phase (AZ-A9 clause 3)', NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approvals_access_request_relation ON approvals;
CREATE TRIGGER trg_approvals_access_request_relation
  BEFORE INSERT ON approvals
  FOR EACH ROW EXECUTE FUNCTION enforce_access_request_relation();

-- clause 8: the decider narrows; the kind, the grantee and the requested
-- authority never change after filing. related_* are deliberately absent from
-- the column list — the FK's ON DELETE SET NULL is an UPDATE of them.
CREATE OR REPLACE FUNCTION enforce_approval_request_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.grantee_principal_id IS DISTINCT FROM OLD.grantee_principal_id
     OR NEW.requested_rules IS DISTINCT FROM OLD.requested_rules
     OR NEW.requested_expires_at IS DISTINCT FROM OLD.requested_expires_at THEN
    RAISE EXCEPTION 'approval %: the kind, grantee and requested authority never change after filing (AZ-A9 clause 8)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approvals_request_immutable ON approvals;
CREATE TRIGGER trg_approvals_request_immutable
  BEFORE UPDATE OF kind, grantee_principal_id, requested_rules, requested_expires_at ON approvals
  FOR EACH ROW EXECUTE FUNCTION enforce_approval_request_immutable();

-- ── approvals_lifecycle_stamps (098:166-172), kind-aware ──────────────────
--
-- The first arm is 098's, unchanged for every kind but 'grant'. For kind
-- 'grant', 'approved' is TERMINAL: it requires the decision stamps and a
-- non-empty created_grant_ids, and it does NOT require approved_scopes or
-- collect_expires_at, which a grant approval never sets. A grant approval is
-- never 'collected'.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_lifecycle_stamps;
ALTER TABLE approvals ADD CONSTRAINT approvals_lifecycle_stamps CHECK (
  (kind = 'grant' OR status NOT IN ('approved', 'collected')
    OR (decided_at IS NOT NULL AND approved_scopes IS NOT NULL AND collect_expires_at IS NOT NULL))
  AND (kind <> 'grant' OR status <> 'approved'
    OR (decided_at IS NOT NULL AND decided_by_principal_id IS NOT NULL
        AND approved_rules IS NOT NULL AND approved_expires_at IS NOT NULL
        AND created_grant_ids IS NOT NULL AND cardinality(created_grant_ids) > 0))
  AND (kind <> 'grant' OR status <> 'collected')
  AND (status <> 'denied' OR decided_at IS NOT NULL)
  AND (status <> 'collected' OR (collected_at IS NOT NULL AND minted_principal_id IS NOT NULL))
  AND (status <> 'lapsed' OR lapse_reason IS NOT NULL)
);

-- ── the one-way trigger (098:259-270), kind-aware ─────────────────────────
--
-- 098's rule stands for every kind. A kind-'grant' 'approved' row is terminal
-- too: its effect is the grant rows it wrote, which clause 12a revokes by
-- approval_id while the row itself stays 'approved' with an approval.revoked
-- event — reopening a task never restores it.
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── approval_events.action (098:208-210) gains approval.revoked ───────────

ALTER TABLE approval_events DROP CONSTRAINT IF EXISTS approval_events_action_check;
ALTER TABLE approval_events ADD CONSTRAINT approval_events_action_check CHECK (action IN
  ('approval.requested', 'approval.approved', 'approval.denied',
   'approval.collected', 'approval.lapsed', 'approval.revoked'));

-- ── clause 12: grants.approval_id ─────────────────────────────────────────
--
-- Where a grant row came from. A request-made row is an owner-approved
-- principal grant: origin 'manual' (the 128:110-121 CHECK forbids a
-- non-manual principal grant anyway), provenance NULL (it is not an
-- assignment vehicle's), and it always expires (E15: at most 90 days).
ALTER TABLE grants ADD COLUMN IF NOT EXISTS approval_id UUID REFERENCES approvals(id);
ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_approval_shape;
ALTER TABLE grants ADD CONSTRAINT grants_approval_shape CHECK (
  approval_id IS NULL
  OR (grantee_type = 'principal' AND origin = 'manual' AND provenance IS NULL AND expires_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_grants_approval ON grants(approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_approvals_kind_status ON approvals(kind, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS ix_approvals_related_task ON approvals(related_task_id) WHERE related_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_approvals_related_phase ON approvals(related_phase_id) WHERE related_phase_id IS NOT NULL;

COMMENT ON COLUMN approvals.kind IS
  'AZ-A9 clause 1 (DRAFT, card 785e1eed): agent-mint (every pre-142 row; §6.1 unchanged) · grant (writes expiring grant rows on the requester''s chain-root Account at approval, clause 12) · credential (E8, clause 13; admitted, not yet filable). Never changes after filing.';
COMMENT ON COLUMN approvals.grantee_principal_id IS
  'AZ-A9 clause 4: the requester''s chain-root Account, server-filled. A grant on a Connector or Agent is inert (§5.1), so a delegated grantee is refused GRANTEE_INERT at filing.';
COMMENT ON COLUMN approvals.reason IS
  'AZ-A9 clause 3: the requester''s reason, 20-2,000 characters. Untrusted text: stored as written and rendered only inside the untrusted-data fence.';
COMMENT ON COLUMN approvals.related_task_id IS
  'AZ-A9 clause 3/12a: the task this request is attached to. When it reaches completed or archived (either terminal writer) or is deleted, the request''s grant rows are revoked and a pending request lapses TASK_TERMINAL; reopening never restores them.';
COMMENT ON COLUMN approvals.related_phase_id IS
  'AZ-A9 clause 3: the related phase. For a request naming ONLY a phase, phase completed/archived revokes and lapses as clause 12a does for a task — the section (E) Q3 recommended reading, REVERSIBLE AT RATIFICATION.';
COMMENT ON COLUMN approvals.created_grant_ids IS
  'AZ-A9 clause 12: the grant rows the approval wrote, in its decide transaction. Non-empty on every approved grant-kind row.';
COMMENT ON COLUMN grants.approval_id IS
  'AZ-A9 clause 12: the grant-kind Approval that wrote this row (origin manual, provenance NULL, expires_at mandatory). NULL for every other writer.';

-- ── clause 9: the five route families join the existing Access manager ────
--
-- "Access surface: no new surface or menu entry. The five families join the
-- existing settings.access-manager row (109_access_surfaces.sql:235-257),
-- which already owns /approvals and /delegation/agent-mints." The two GETs
-- are read families and the three POSTs are write families. Their literal
-- second segment (`access-requests`) differs from `agent-mints` and
-- `warrants`, so the D15 overlap census (AccessSurfaceService.censusFindings,
-- familyPathsOverlap) finds no path another surface declares.
--
-- 109 seeds its catalogue once, on an empty table, and is shipped history, so
-- the families are added here by an additive UPDATE that appends each family
-- only when the row does not carry it yet (replay-safe). A catalogue with no
-- `settings.access-manager` row is left unchanged.
UPDATE access_surfaces AS s
   SET read_families = s.read_families || ARRAY(
         SELECT family FROM unnest(ARRAY[
           'GET /delegation/access-requests',
           'GET /delegation/access-requests/:approvalId']::text[]) AS family
          WHERE NOT (family = ANY (s.read_families))),
       write_families = s.write_families || ARRAY(
         SELECT family FROM unnest(ARRAY[
           'POST /delegation/access-requests',
           'POST /delegation/access-requests/:approvalId/withdraw',
           'POST /delegation/access-requests/:approvalId/collect']::text[]) AS family
          WHERE NOT (family = ANY (s.write_families)))
 WHERE s.key = 'settings.access-manager';
