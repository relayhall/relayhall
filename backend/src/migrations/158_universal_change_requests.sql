-- 158_universal_change_requests.sql — the universal change-request model,
-- train T1 slice S1 (card 502fb19e; design ratified by owner ruling E325 with
-- every section 12 recommendation; rulings E308, E309, E310). Reserved in
-- backend/src/migrations/RESERVED as slot 158 before this file existed
-- (ruling 0464ad54 section 2).
--
-- ONE MORE KIND, ONE TYPED TARGET. An Approval keeps its noun (AZ-A9 clause
-- 1). Kind `change` joins agent-mint, grant, credential and authority-edit,
-- and carries every further target in a column pair instead of a kind per
-- target: `target_type` (a closed vocabulary) and `target_id` for a
-- single-object target, or `target_objects` (an ordered JSON list of
-- {type, id}) for the two multi-object targets, `grant.rows` and
-- `knowledge.compartment`. Each object of a request is ONE child row in
-- `approval_change_objects`, so the one-pending-request rule and the owner
-- coordinate are per object. `change_spec` holds the typed before, requested,
-- approved and diff of the change.
--
-- The four existing kinds keep their columns, arms, routes, tools and
-- oracles. Every statement below that redefines a shared constraint or
-- trigger restates the previous definition (migration 148) BYTE FOR BYTE and
-- adds the `change` rule beside it:
--
--   (a) approvals_kind_check gains 'change';
--   (b) the new columns, all nullable; the child table and its pending
--       index; the trigger that clears `pending` on the children when the
--       parent leaves pending; a deferred check that every change row has at
--       least one child row; and a separate CHECK that keeps the new columns
--       NULL on every other kind, so no legacy arm is edited for them;
--   (c) approvals_kind_shape: the WHEN 'change' arm is inserted BEFORE the
--       ELSE arm; the agent-mint, authority-edit and ELSE arms are 148's;
--   (d) approvals_lifecycle_stamps: 148's conjuncts, the first one exempting
--       change as it exempts grant and authority-edit, plus the two change
--       stamps (an approved change was applied at decide, or waits for its
--       collect; a collected change was applied);
--   (e) the relation trigger exempts change (the relation rule is per target
--       class and is enforced by the service);
--   (f) the immutability trigger: 148's rules, plus the change request never
--       changes after filing and the decision never changes after decide,
--       except the exporter's generation stamp and the revert stamp;
--   (g) the one-way trigger: 148's rules, plus an applied approved change is
--       terminal and an unapplied one goes only to collected or lapsed;
--   (h) approval_events gains approval.applied, approval.export_stalled and
--       approval.reverted;
--   (i) grants_approval_shape admits a Group grantee (consistent with 128's
--       grants_origin_group_only, which admits a manual Group row);
--   (j) the core tables the lifecycle exporter and the plugin proxy read:
--       knowledge_compartment_grants, knowledge_personal_consents (data
--       carried over from the exporter configuration, never requestable) and
--       plugin_access_entries. knowledge_shared_writers is migration 157's
--       and already carries approval_id and expires_at: nothing is created
--       for it here.
--
-- The two idempotency CHECKs are NOT touched: filing, deciding and withdrawing
-- a change stay unkeyed (section 12 Q10 (a)). The inline status CHECK of 098
-- is not touched either: application is a stamp, and a withdrawal stays
-- lapsed with WITHDRAWN.
--
-- Replay-safe: every statement is IF [NOT] EXISTS, CREATE OR REPLACE, a
-- DROP/ADD of a named constraint or trigger, or a COMMENT, so re-running this
-- file is a no-op. One implicit transaction, no COMMIT. database/init.sql is
-- untouched.

-- ── (a) the kind ───────────────────────────────────────────────────────────

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('agent-mint', 'grant', 'credential', 'authority-edit', 'change'));

-- ── (b) the change columns ─────────────────────────────────────────────────

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS target_id TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS target_objects JSONB;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS change_spec JSONB;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS grantee_type TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS scope_project_ids UUID[];
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS scope_report_ids UUID[];
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS scope_group_ids UUID[];
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS requested_lifetime JSONB;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS revert_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS applied_effect JSONB;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decider_standing TEXT;

-- The closed vocabulary of target types: every type the ratified design
-- declares IN. A type declared OUT is never stored; a type whose slice has not
-- shipped yet is refused by the service by name before anything is written.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_target_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_target_type_check
  CHECK (target_type IS NULL OR target_type IN (
    'grant.rows', 'grant.edit', 'grant.revoke',
    'credential.scopes', 'credential.issue', 'credential.revoke',
    'identity.create', 'identity.role', 'identity.status',
    'warrant.create', 'warrant.edit', 'warrant.revoke', 'warrant.resume',
    'group.member', 'group.steward', 'group.lifecycle', 'group.ownership_status',
    'profile.assignment',
    'project.owner', 'task.account_owner', 'report.account_owner',
    'project.default_verifier', 'phase.default_verifier',
    'task.roles', 'charter.revision', 'phase.goal', 'task.access', 'phase.access', 'report.visibility',
    'plugin.capability', 'knowledge.compartment', 'knowledge.shared_writer'));
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_grantee_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_grantee_type_check
  CHECK (grantee_type IS NULL OR grantee_type IN ('principal', 'group'));
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_decider_standing_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_decider_standing_check
  CHECK (decider_standing IS NULL OR decider_standing IN
    ('root', 'administrator', 'owner', 'group-owner', 'group-manager', 'owning-account'));

-- The change columns belong to kind change alone. A separate CHECK rather than
-- an edit of the legacy arms, so those arms stay byte-identical (section 2.2).
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_change_columns_only;
ALTER TABLE approvals ADD CONSTRAINT approvals_change_columns_only CHECK (
  kind = 'change' OR (
    target_type IS NULL AND target_id IS NULL AND target_objects IS NULL AND change_spec IS NULL
    AND grantee_type IS NULL AND scope_project_ids IS NULL AND scope_report_ids IS NULL
    AND scope_group_ids IS NULL AND requested_lifetime IS NULL AND revert_at IS NULL
    AND reverted_at IS NULL AND applied_at IS NULL AND applied_effect IS NULL AND decider_standing IS NULL)
);

-- One row per object of a change request (section 2.1, F2). owner_ids is the
-- owner value the evaluator's owner arm reads for that object, derived by the
-- server at filing and re-derived at decide; '{}' where no owner tier reaches
-- the object. object_id is '<type>:<id>' ('<type>:*' for an all-of-type rule)
-- for a multi-object target and the target id for a single-object one.
CREATE TABLE IF NOT EXISTS approval_change_objects (
  approval_id UUID NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  owner_ids UUID[] NOT NULL DEFAULT '{}',
  grantee_type TEXT,
  grantee_principal_id UUID,
  requester_account_id UUID NOT NULL REFERENCES principals(id),
  pending BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (approval_id, ordinal),
  CONSTRAINT approval_change_objects_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT approval_change_objects_object_check CHECK (char_length(object_id) BETWEEN 1 AND 300),
  CONSTRAINT approval_change_objects_grantee_check CHECK (
    (grantee_type IS NULL) = (grantee_principal_id IS NULL)
    AND (grantee_type IS NULL OR grantee_type IN ('principal', 'group')))
);

-- One pending change per (target type, object, grantee, requester Account):
-- the EDIT_PENDING pattern (148), keyed per requester so one filer never
-- blocks another, NULLS NOT DISTINCT for object-only targets.
CREATE UNIQUE INDEX IF NOT EXISTS ux_approval_change_objects_pending
  ON approval_change_objects (target_type, object_id, grantee_type, grantee_principal_id, requester_account_id)
  NULLS NOT DISTINCT WHERE pending;
CREATE INDEX IF NOT EXISTS ix_approval_change_objects_owner
  ON approval_change_objects USING gin (owner_ids);

-- A child row's request never changes: only its pending flag, true -> false.
CREATE OR REPLACE FUNCTION enforce_approval_change_object_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.approval_id IS DISTINCT FROM OLD.approval_id
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.object_id IS DISTINCT FROM OLD.object_id
     OR NEW.owner_ids IS DISTINCT FROM OLD.owner_ids
     OR NEW.grantee_type IS DISTINCT FROM OLD.grantee_type
     OR NEW.grantee_principal_id IS DISTINCT FROM OLD.grantee_principal_id
     OR NEW.requester_account_id IS DISTINCT FROM OLD.requester_account_id
     OR (NEW.pending AND NOT OLD.pending) THEN
    RAISE EXCEPTION 'change object %/%: the object, its owners, the grantee and the requester never change after filing; pending only ends', OLD.approval_id, OLD.ordinal
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approval_change_objects_immutable ON approval_change_objects;
CREATE TRIGGER trg_approval_change_objects_immutable
  BEFORE UPDATE ON approval_change_objects
  FOR EACH ROW EXECUTE FUNCTION enforce_approval_change_object_immutable();

-- When the parent leaves pending, its children stop holding the pending key.
CREATE OR REPLACE FUNCTION clear_approval_change_objects_pending() RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'change' AND NEW.status <> 'pending' AND OLD.status = 'pending' THEN
    UPDATE approval_change_objects SET pending = FALSE WHERE approval_id = NEW.id AND pending;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approvals_change_objects_pending ON approvals;
CREATE TRIGGER trg_approvals_change_objects_pending
  AFTER UPDATE OF status ON approvals
  FOR EACH ROW EXECUTE FUNCTION clear_approval_change_objects_pending();

-- Every change row carries at least one child row (section 2.1), checked at
-- commit, so the parent and its children are written in one transaction.
CREATE OR REPLACE FUNCTION enforce_approval_change_has_objects() RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'change' AND NOT EXISTS (SELECT 1 FROM approval_change_objects WHERE approval_id = NEW.id) THEN
    RAISE EXCEPTION 'approval %: a change request names at least one object (approval_change_objects)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approvals_change_has_objects ON approvals;
CREATE CONSTRAINT TRIGGER trg_approvals_change_has_objects
  AFTER INSERT ON approvals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_approval_change_has_objects();

CREATE INDEX IF NOT EXISTS ix_approvals_change_target
  ON approvals (target_type, target_id) WHERE kind = 'change';
CREATE INDEX IF NOT EXISTS ix_approvals_change_unexported
  ON approvals (applied_at) WHERE kind = 'change' AND status = 'approved' AND applied_at IS NOT NULL;

-- ── (c) approvals_kind_shape (148's), with the change arm ──────────────────
--
-- The agent-mint and authority-edit arms and the ELSE arm are 148's, byte for
-- byte. The change arm, inserted BEFORE the ELSE arm:
--   - the target type and the spec are set, the spec is a JSON object, and
--     EXACTLY ONE of target_id and target_objects (a non-empty array);
--   - EXACTLY ONE binding: a bearer filed it (requesting_credential_id) or a
--     login session filed it (session_evidence), 148's authority-edit XOR;
--   - the reason is mandatory, 20-2,000 characters;
--   - a grantee is named with its type, or neither is (object-only targets);
--   - every column of the legacy kinds stays NULL or empty: no requested or
--     approved scopes, rows, expiry, transport or label, no target task, no
--     written grant ids, no issued credential, and every edit_* column NULL —
--     the revert lives in revert_at and reverted_at, which are this arm's own;
--   - the revert stamp belongs to an APPROVED change.
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
    WHEN 'change' THEN
      target_type IS NOT NULL AND change_spec IS NOT NULL
      AND jsonb_typeof(change_spec) = 'object'
      AND ((target_id IS NOT NULL) <> (target_objects IS NOT NULL))
      AND (target_objects IS NULL OR (jsonb_typeof(target_objects) = 'array' AND jsonb_array_length(target_objects) > 0))
      AND ((requesting_credential_id IS NOT NULL) <> (session_evidence IS NOT NULL))
      AND reason IS NOT NULL AND char_length(reason) BETWEEN 20 AND 2000
      AND ((grantee_principal_id IS NULL) = (grantee_type IS NULL))
      AND requested_scopes = '[]'::jsonb AND requested_rules = '[]'::jsonb
      AND approved_scopes IS NULL AND approved_rules IS NULL
      AND requested_expires_at IS NULL AND approved_expires_at IS NULL
      AND target_task_id IS NULL AND created_grant_ids IS NULL AND issued_credential_id IS NULL
      AND requested_transport IS NULL AND approved_transport IS NULL AND credential_label IS NULL
      AND edit_object_type IS NULL AND edit_object_id IS NULL AND edit_before IS NULL
      AND edit_requested IS NULL AND edit_approved IS NULL
      AND edit_lifetime IS NULL AND edit_revert_at IS NULL AND edit_reverted_at IS NULL
      AND (requested_lifetime IS NULL OR jsonb_typeof(requested_lifetime) = 'object')
      AND (applied_effect IS NULL OR jsonb_typeof(applied_effect) = 'object')
      AND (reverted_at IS NULL OR status = 'approved')
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

-- ── (d) approvals_lifecycle_stamps (148's), with the change stamps ─────────
--
-- 148's conjuncts, the first one exempting change as it exempts grant and
-- authority-edit (a change sets neither approved_scopes nor, unless it waits
-- for a collect, a collect window). Added: an APPROVED change carries who
-- decided and when, and was applied in the decide (applied_at) or waits for
-- its collect (collect_expires_at, the two-step secret class); a COLLECTED
-- change was applied.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_lifecycle_stamps;
ALTER TABLE approvals ADD CONSTRAINT approvals_lifecycle_stamps CHECK (
  (kind IN ('grant', 'authority-edit', 'change') OR status NOT IN ('approved', 'collected')
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
  AND (kind <> 'change' OR status <> 'approved'
    OR (decided_at IS NOT NULL AND decided_by_principal_id IS NOT NULL
        AND (applied_at IS NOT NULL OR collect_expires_at IS NOT NULL)))
  AND (kind <> 'change' OR status <> 'collected' OR applied_at IS NOT NULL)
  AND (status <> 'denied' OR decided_at IS NOT NULL)
  AND (status <> 'collected' OR (collected_at IS NOT NULL AND minted_principal_id IS NOT NULL))
  AND (status <> 'lapsed' OR lapse_reason IS NOT NULL)
);

-- ── (e) the relation trigger (148's), exempting change ─────────────────────
--
-- A change request's related task and phase are optional references; the
-- task-bound class (section 7.4) is the service's rule.
CREATE OR REPLACE FUNCTION enforce_access_request_relation() RETURNS trigger AS $$
BEGIN
  IF NEW.kind NOT IN ('agent-mint', 'authority-edit', 'change') AND NEW.related_task_id IS NULL AND NEW.related_phase_id IS NULL THEN
    RAISE EXCEPTION 'a % request names its related task or phase (AZ-A9 clause 3)', NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── (f) the immutability trigger (148's), with the change request ──────────
--
-- 148's rules are unchanged. Added for kind change: the target, the grantee
-- type and the spec's type, before and requested never change after filing;
-- once the item is decided, the spec (approved and diff included), the
-- decider's standing and the revert date never change; the revert stamp is
-- written once, on an APPROVED row. applied_at and applied_effect stay
-- writable after the decide: the collect of a two-step secret stamps
-- applied_at, and the lifecycle exporter adds its generation to
-- applied_effect.
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
  IF OLD.kind = 'change' AND (
       NEW.target_type IS DISTINCT FROM OLD.target_type
       OR NEW.target_id IS DISTINCT FROM OLD.target_id
       OR NEW.target_objects IS DISTINCT FROM OLD.target_objects
       OR NEW.grantee_type IS DISTINCT FROM OLD.grantee_type
       OR NEW.change_spec->'type' IS DISTINCT FROM OLD.change_spec->'type'
       OR NEW.change_spec->'before' IS DISTINCT FROM OLD.change_spec->'before'
       OR NEW.change_spec->'requested' IS DISTINCT FROM OLD.change_spec->'requested') THEN
    RAISE EXCEPTION 'approval %: the change target, the grantee and the requested change never change after filing (design section 2.3 f)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind = 'change' AND OLD.status <> 'pending' AND (
       NEW.change_spec IS DISTINCT FROM OLD.change_spec
       OR NEW.decider_standing IS DISTINCT FROM OLD.decider_standing
       OR NEW.revert_at IS DISTINCT FROM OLD.revert_at
       OR (OLD.reverted_at IS NOT NULL AND NEW.reverted_at IS DISTINCT FROM OLD.reverted_at)) THEN
    RAISE EXCEPTION 'approval %: a decided change never changes; only its export generation and its revert are stamped (design section 2.3 f)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind = 'change' AND OLD.status <> 'approved'
     AND NEW.reverted_at IS DISTINCT FROM OLD.reverted_at THEN
    RAISE EXCEPTION 'approval %: only an approved change is reverted (design section 2.3 f)', OLD.id
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
                   edit_approved, edit_lifetime, edit_revert_at, edit_reverted_at,
                   target_type, target_id, target_objects, grantee_type, change_spec,
                   decider_standing, revert_at, reverted_at ON approvals
  FOR EACH ROW EXECUTE FUNCTION enforce_approval_request_immutable();

-- ── (g) the one-way trigger (148's), with change ───────────────────────────
--
-- 148's rules stand. An approved change whose effect was applied in the
-- decide is terminal; an approved change that waits for its collect (a
-- two-step secret) goes only to collected or lapsed. (d) reads the same stamp.
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
  IF OLD.kind = 'change' AND OLD.status = 'approved' AND NEW.status <> OLD.status
     AND (OLD.applied_at IS NOT NULL OR NEW.status NOT IN ('collected', 'lapsed')) THEN
    RAISE EXCEPTION 'approval % is single-use (design section 2.3 g): an applied change is terminal, and an approved two-step change is only collected or lapsed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── (h) approval_events.action gains the change ledger rows ────────────────

ALTER TABLE approval_events DROP CONSTRAINT IF EXISTS approval_events_action_check;
ALTER TABLE approval_events ADD CONSTRAINT approval_events_action_check CHECK (action IN
  ('approval.requested', 'approval.approved', 'approval.denied',
   'approval.collected', 'approval.lapsed', 'approval.revoked',
   'approval.applied', 'approval.export_stalled', 'approval.reverted'));

-- ── (i) grants_approval_shape (142's) admits a Group grantee ───────────────
--
-- A change request writes grant rows for a named Account OR a Group (section
-- 3, grant.rows). 128's grants_origin_group_only (origin manual, or a Group
-- grantee) already admits a manual Group row; the shape stays manual, without
-- provenance and always expiring.
ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_approval_shape;
ALTER TABLE grants ADD CONSTRAINT grants_approval_shape CHECK (
  approval_id IS NULL
  OR (grantee_type IN ('principal', 'group') AND origin = 'manual' AND provenance IS NULL AND expires_at IS NOT NULL)
);

-- ── (j) the core tables the exporter and the plugin proxy read ─────────────
--
-- knowledge_compartment_grants: one row = one subject's read or write on one
-- Project compartment of one knowledge source. The lifecycle exporter emits
-- them as projects[].grants in place of the configuration's projectGrants.
-- Rows carried over from the configuration keep their consent_ref, have no
-- approval and were added by `system`; rows an approved change wrote name the
-- approval, the decider and an expiry.
CREATE TABLE IF NOT EXISTS knowledge_compartment_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id UUID NOT NULL,
  operation TEXT NOT NULL,
  consent_ref TEXT NOT NULL,
  approval_id UUID REFERENCES approvals(id),
  added_by TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  CONSTRAINT knowledge_compartment_grants_subject_check CHECK (subject_type IN ('user', 'group')),
  CONSTRAINT knowledge_compartment_grants_operation_check CHECK (operation IN ('read', 'write')),
  CONSTRAINT knowledge_compartment_grants_consent_check CHECK (char_length(consent_ref) BETWEEN 1 AND 256),
  CONSTRAINT knowledge_compartment_grants_added_by_check CHECK (
    added_by = 'system' OR added_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT knowledge_compartment_grants_approval_expires CHECK (approval_id IS NULL OR expires_at IS NOT NULL),
  CONSTRAINT knowledge_compartment_grants_expiry_after_add CHECK (expires_at IS NULL OR expires_at > added_at),
  CONSTRAINT knowledge_compartment_grants_one_row UNIQUE (source_id, project_id, subject_type, subject_id, operation)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_compartment_grants_source
  ON knowledge_compartment_grants (source_id, project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_compartment_grants_approval
  ON knowledge_compartment_grants (approval_id) WHERE approval_id IS NOT NULL;

-- knowledge_personal_consents: the configuration's personalConsents, carried
-- over as data. Never requestable (E260(1): a personal compartment is
-- readable by nobody else), so nothing but the carry-over writes it.
CREATE TABLE IF NOT EXISTS knowledge_personal_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL,
  reader_id UUID NOT NULL,
  consent_ref TEXT NOT NULL,
  added_by TEXT NOT NULL DEFAULT 'system',
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_personal_consents_pair_check CHECK (owner_id <> reader_id),
  CONSTRAINT knowledge_personal_consents_consent_check CHECK (char_length(consent_ref) BETWEEN 1 AND 256),
  CONSTRAINT knowledge_personal_consents_added_by_check CHECK (added_by = 'system'),
  CONSTRAINT knowledge_personal_consents_one_row UNIQUE (source_id, owner_id, reader_id)
);

-- plugin_access_entries: a non-view plugin capability for one Account, the
-- table the plugin proxy reads beside the deployment file (E313). Created
-- here so the model is one migration; its request path ships with train T3.
CREATE TABLE IF NOT EXISTS plugin_access_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_name TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  approval_id UUID REFERENCES approvals(id),
  added_by TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  CONSTRAINT plugin_access_entries_name_check CHECK (char_length(plugin_name) BETWEEN 1 AND 200),
  CONSTRAINT plugin_access_entries_capability_check CHECK (
    char_length(capability) BETWEEN 1 AND 200 AND capability <> 'view'),
  CONSTRAINT plugin_access_entries_added_by_check CHECK (
    added_by = 'system' OR added_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT plugin_access_entries_approval_expires CHECK (approval_id IS NULL OR expires_at IS NOT NULL),
  CONSTRAINT plugin_access_entries_one_row UNIQUE (plugin_name, account_id, capability)
);

-- ── comments ──────────────────────────────────────────────────────────────

COMMENT ON COLUMN approvals.kind IS
  'AZ-A9 clause 1, ratified 2026-10-10 (E43; card 785e1eed): agent-mint (every pre-142 row; §6.1 unchanged) · grant (writes expiring grant rows on the requester''s chain-root Account at approval, clause 12) · credential (issues ONE Connector credential at collect, clause 13) · authority-edit (AZ-A13, ratified 2026-10-11, E95: edits an existing Connector credential, warrant or grant in place at approval) · change (the universal change request, ratified 2026-10-17, E325: one typed target in target_type, the change in change_spec; migration 158). Never changes after filing.';
COMMENT ON COLUMN approvals.target_type IS
  'Kind change (E325, section 2.1): the target type, from the closed vocabulary of approvals_target_type_check. NULL on every other kind.';
COMMENT ON COLUMN approvals.target_id IS
  'Kind change: the single object the change is about (a row id, or an opaque pair such as <source>:<scope>). Exactly one of target_id and target_objects is set.';
COMMENT ON COLUMN approvals.target_objects IS
  'Kind change: the ordered list of {type, id} a multi-object target (grant.rows, knowledge.compartment) covers; one approval_change_objects row per element.';
COMMENT ON COLUMN approvals.change_spec IS
  'Kind change: {type, before, requested, approved, diff}. before is the server''s snapshot at filing and requested the change asked for, both fixed at filing; approved (at or below requested, field by field) and diff are written at decide and never change afterwards.';
COMMENT ON COLUMN approvals.grantee_type IS
  'Kind change: principal or group, set with grantee_principal_id for a change FOR an Account or a Group; both NULL for an object-only target.';
COMMENT ON COLUMN approvals.scope_project_ids IS
  'Kind change: every Project the objects resolve to, server-derived at filing and re-derived at decide. Display, filtering and the per-Project view only, never visibility (owner_ids on the child rows is the coordinate the hub reads).';
COMMENT ON COLUMN approvals.scope_report_ids IS
  'Kind change: every standalone Report the objects name, derived as scope_project_ids is.';
COMMENT ON COLUMN approvals.scope_group_ids IS
  'Kind change: every Group that owns a named object or is the target itself, derived as scope_project_ids is.';
COMMENT ON COLUMN approvals.requested_lifetime IS
  'Kind change: {choice: keep | until-task | until-date, taskId?, revertAt?}, the lifetime the requester asked for (AZ-A13 6(j) generalised).';
COMMENT ON COLUMN approvals.revert_at IS
  'Kind change: when the approved change is reverted, set at decide from the approved lifetime.';
COMMENT ON COLUMN approvals.reverted_at IS
  'Kind change: when the change was reverted. Stamped once, on an approved row.';
COMMENT ON COLUMN approvals.applied_at IS
  'Kind change: when core applied the change - in the decide transaction for every in-decide target (a plugin-state target included: the core row is the application), at collect for a two-step secret.';
COMMENT ON COLUMN approvals.applied_effect IS
  'Kind change: the ids the application wrote (grant ids, a credential id, a writer-list row, compartment rows); the lifecycle exporter adds generation once a snapshot carried the row, or export: stalled.';
COMMENT ON COLUMN approvals.decider_standing IS
  'Kind change: the arm that admitted the decider (root, administrator, or an owner tier).';
COMMENT ON TABLE approval_change_objects IS
  'Kind change (E325, section 2.1, F2): one row per object of a change request, carrying the per-object pending key and owner_ids, the owner value the evaluator''s owner arm reads for that object.';
COMMENT ON TABLE knowledge_compartment_grants IS
  'E308 (section 7.2): a subject''s read or write on a Project compartment of a knowledge source, exported in the signed lifecycle snapshot as projects[].grants. Carried-over configuration rows: approval_id NULL, added_by system, consent_ref preserved.';
COMMENT ON TABLE knowledge_personal_consents IS
  'E308 (section 7.3): the configuration''s personal consents carried over as data. Never requestable (E260(1)).';
COMMENT ON TABLE plugin_access_entries IS
  'E313 (section 3, plugin.capability): a non-view plugin capability for an Account; read beside the deployment file. Its request path ships with train T3.';
