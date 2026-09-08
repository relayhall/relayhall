-- 098_warrants_approvals.sql
-- RH-P3.AZ-S4 (card aa48fb12): Warrants and Approvals (AUTHZ design
-- 4d961e37 §6; vocabulary A17.5 Warrant, A17.11 Approval).
--
-- WARRANT (A17.5): a standing, owner-created, revocable authorization under
-- which a named HOLDER (one Connector, or a service Account exercised
-- through its live Connectors) may mint Agent identities without per-spawn
-- human approval. Scope = a SET of anchors (tasks/phases/projects, union
-- semantics); authority ceiling = a version-PINNED Access profile reference
-- (AZ-21b — republish never silently widens a standing warrant) or inline
-- selector rules; MANDATORY expiry (single-task warrants may rely on
-- task-terminal expiry alone; multi-anchor warrants carry an explicit
-- date); optional caps (max_concurrent = live minted identities counted
-- through the provenance FK; max_total = the counter column below);
-- optional transport pin (§7.5).
--
-- APPROVAL (A17.11): the durable Agent-mint request/authorization object.
-- Lifecycle: pending · approved · denied · collected · lapsed. Binds to the
-- EXACT requesting credential id — or, for the atomic SESSION MINT path
-- (§6.1a), to the authenticated session + step-up evidence with credential
-- id NULL. Single-use: consumed by COLLECT or expiring unused (TTL 24h
-- post-approval, 7d pending).
--
-- Provenance: minted Agent principals carry minted_under_warrant_id — the
-- §6.4 QUERYABLE provenance FK ("the Access manager lists every identity
-- minted under each warrant via a queryable provenance FK, not audit rows
-- alone") — and warrant_events / approval_events are append-only ledgers on
-- the 095 access_profile_events pattern. §9.7 audit_events rows are written
-- by the services in the same transactions; these tables are the per-object
-- provenance feed the Access manager renders.
--
-- Fresh-replay doctrine: database/init.sql untouched; idempotent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── warrants (§6.2) ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS warrants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  holder_principal_id UUID NOT NULL REFERENCES principals(id),
  -- AZ-31a: the live-cap binds to the CREATING principal — creator
  -- disabled/terminated or narrowed below the ceiling auto-suspends.
  created_by_principal_id UUID REFERENCES principals(id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
  -- Ceiling: EXACTLY one form — a version-pinned profile reference
  -- (AZ-21b) or inline selector rules. Never unbounded (AZ-31a: root
  -- warrants included).
  ceiling_profile_version_id UUID REFERENCES access_profile_versions(id),
  ceiling_rules JSONB,
  -- Optional inline SCOPE ceiling on top of the object ceiling; NULL means
  -- the minted scopes are capped only by the requester's own effective set
  -- (the mint-time ⊆ check) and rules 2/3.
  ceiling_scopes JSONB,
  -- Mandatory expiry (§6.2): multi-anchor warrants carry an explicit date
  -- (service-enforced at creation, where the anchor count is known);
  -- single-task warrants may rely on task-terminal expiry alone, computed
  -- by the lifecycle sweep as ALL anchors terminal. Expiry is one-way.
  expires_at TIMESTAMPTZ,
  transport_pin TEXT NOT NULL DEFAULT 'any'
    CHECK (transport_pin IN ('any', 'mcp', 'api')),
  -- §8.1: the warrant may set the minted credential max-age (default 24h).
  agent_max_age_hours INTEGER CHECK (agent_max_age_hours IS NULL OR (agent_max_age_hours >= 1 AND agent_max_age_hours <= 168)),
  max_concurrent INTEGER CHECK (max_concurrent IS NULL OR max_concurrent >= 1),
  max_total INTEGER CHECK (max_total IS NULL OR max_total >= 1),
  -- The §6.2 cap counter: total identities ever minted under this warrant.
  minted_total INTEGER NOT NULL DEFAULT 0 CHECK (minted_total >= 0),
  suspended_reason TEXT,
  suspended_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT warrants_name_nonempty CHECK (btrim(name) <> ''),
  -- The ceiling is mandatory and single-form: profile pin XOR inline rules.
  CONSTRAINT warrants_ceiling_present CHECK (
    (ceiling_profile_version_id IS NOT NULL AND ceiling_rules IS NULL)
    OR (ceiling_profile_version_id IS NULL AND ceiling_rules IS NOT NULL)
  ),
  CONSTRAINT warrants_status_stamps CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
    AND ((status <> 'suspended') OR (suspended_at IS NOT NULL AND suspended_reason IS NOT NULL))
    AND ((status <> 'expired') OR (expired_at IS NOT NULL))
  )
);

CREATE INDEX IF NOT EXISTS ix_warrants_holder ON warrants(holder_principal_id, status);
CREATE INDEX IF NOT EXISTS ix_warrants_creator ON warrants(created_by_principal_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS warrant_anchors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warrant_id UUID NOT NULL REFERENCES warrants(id) ON DELETE RESTRICT,
  anchor_type TEXT NOT NULL CHECK (anchor_type IN ('task', 'phase', 'project')),
  anchor_id UUID NOT NULL,
  UNIQUE (warrant_id, anchor_type, anchor_id)
);

CREATE INDEX IF NOT EXISTS ix_warrant_anchors_warrant ON warrant_anchors(warrant_id);
CREATE INDEX IF NOT EXISTS ix_warrant_anchors_anchor ON warrant_anchors(anchor_type, anchor_id);

-- ── approvals (A17.11, §6.1/§6.1a) ──────────────────────────────────────
--
-- DECLARED BASELINE COLLISION (the 096 encryption_key_id precedent, in the
-- other direction): database/init.sql carries a DEAD ClawBoard-heritage
-- `approvals` table (command/plan approvals: link_token, type ∈
-- command|plan) with ZERO code references — its route mount was already a
-- commented-out ghost in server.ts. A17.11 ratifies the noun for THIS
-- object ("one noun on every surface: … the approvals table"), so the
-- ratified name wins: the legacy table is RENAMED aside (non-destructive,
-- rows preserved byte-intact, BASELINE FILE untouched) rather than the
-- ratified noun deviating. ONE-TIME by construction: the rename runs only
-- while the legacy shape (link_token) is present, so re-running this file
-- never touches the new table; fresh replay follows the same path
-- (init.sql creates the legacy shape, this renames it, the ratified table
-- is created below).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'approvals'
      AND column_name = 'link_token'
  ) THEN
    ALTER TABLE approvals RENAME TO legacy_command_approvals;
    ALTER INDEX IF EXISTS approvals_pkey RENAME TO legacy_command_approvals_pkey;
    ALTER INDEX IF EXISTS approvals_link_token_key RENAME TO legacy_command_approvals_link_token_key;
    ALTER TABLE legacy_command_approvals RENAME CONSTRAINT approvals_status_check TO legacy_command_approvals_status_check;
    ALTER TABLE legacy_command_approvals RENAME CONSTRAINT approvals_type_check TO legacy_command_approvals_type_check;
    COMMENT ON TABLE legacy_command_approvals IS
      'Pre-098 ClawBoard-heritage command/plan approvals — dead code at rename time, preserved byte-intact. The ratified A17.11 approvals table (design 4d961e37 §6.1) owns the approvals name from 098 on.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'collected', 'lapsed')),
  requester_principal_id UUID NOT NULL REFERENCES principals(id),
  -- The EXACT requesting credential (AZ-31c). NULL only for the §6.1a
  -- atomic session mint, which records session + step-up evidence instead.
  requesting_credential_id UUID REFERENCES principal_credentials(id),
  session_evidence JSONB,
  target_task_id UUID NOT NULL REFERENCES tasks(id),
  requested_scopes JSONB NOT NULL,
  requested_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The approver may EDIT the requested authority DOWN before approving
  -- (§6.1); what was approved is what collect mints.
  approved_scopes JSONB,
  approved_rules JSONB,
  decided_by_principal_id UUID REFERENCES principals(id),
  decided_at TIMESTAMPTZ,
  decision_step_up JSONB,
  denial_reason TEXT,
  lapse_reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Pending TTL: 7 days (§6.1). Collect TTL: 24h, set at approval.
  pending_expires_at TIMESTAMPTZ NOT NULL,
  collect_expires_at TIMESTAMPTZ,
  collected_at TIMESTAMPTZ,
  minted_principal_id UUID REFERENCES principals(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT approvals_binding_present CHECK (
    (requesting_credential_id IS NOT NULL) OR (session_evidence IS NOT NULL)
  ),
  CONSTRAINT approvals_lifecycle_stamps CHECK (
    (status NOT IN ('approved', 'collected')
      OR (decided_at IS NOT NULL AND approved_scopes IS NOT NULL AND collect_expires_at IS NOT NULL))
    AND (status <> 'denied' OR decided_at IS NOT NULL)
    AND (status <> 'collected' OR (collected_at IS NOT NULL AND minted_principal_id IS NOT NULL))
    AND (status <> 'lapsed' OR lapse_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ix_approvals_requester ON approvals(requester_principal_id, status);
CREATE INDEX IF NOT EXISTS ix_approvals_credential ON approvals(requesting_credential_id)
  WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS ix_approvals_status ON approvals(status, requested_at DESC);

-- ── provenance FK on minted principals (§6.4) ───────────────────────────

ALTER TABLE principals ADD COLUMN IF NOT EXISTS minted_under_warrant_id UUID REFERENCES warrants(id);
CREATE INDEX IF NOT EXISTS ix_principals_minted_under_warrant
  ON principals(minted_under_warrant_id) WHERE minted_under_warrant_id IS NOT NULL;

-- ── append-only event ledgers (the 095 pattern) ─────────────────────────

CREATE TABLE IF NOT EXISTS warrant_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  warrant_id UUID NOT NULL,
  -- Dotted <singular>.<past-tense> names (vocabulary b94dd86e §6).
  action TEXT NOT NULL CHECK (action IN
    ('warrant.created', 'warrant.updated', 'warrant.suspended', 'warrant.resumed',
     'warrant.revoked', 'warrant.expired', 'warrant.minted')),
  actor_principal_id UUID,
  actor_handle TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS ix_warrant_events_warrant
  ON warrant_events(warrant_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS approval_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approval_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN
    ('approval.requested', 'approval.approved', 'approval.denied',
     'approval.collected', 'approval.lapsed')),
  actor_principal_id UUID,
  actor_handle TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS ix_approval_events_approval
  ON approval_events(approval_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_warrant_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'warrant/approval event ledgers are append-only'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_warrant_events_append_only ON warrant_events;
CREATE TRIGGER trg_warrant_events_append_only
  BEFORE UPDATE OR DELETE ON warrant_events
  FOR EACH ROW EXECUTE FUNCTION reject_warrant_ledger_mutation();

DROP TRIGGER IF EXISTS trg_approval_events_append_only ON approval_events;
CREATE TRIGGER trg_approval_events_append_only
  BEFORE UPDATE OR DELETE ON approval_events
  FOR EACH ROW EXECUTE FUNCTION reject_warrant_ledger_mutation();

-- ── one-way lifecycle guards ────────────────────────────────────────────
-- Warrant expiry/revocation is ONE-WAY (§6.2: "expiry one-way — reopening
-- never resurrects"); a suspended warrant is resumable ONLY by the
-- re-approval act (service-gated), so the trigger permits
-- suspended→active but never revoked/expired→anything else.
CREATE OR REPLACE FUNCTION enforce_warrant_one_way() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('revoked', 'expired') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'warrant % is one-way (§6.2): a % warrant never returns to service', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_warrants_one_way ON warrants;
CREATE TRIGGER trg_warrants_one_way
  BEFORE UPDATE OF status ON warrants
  FOR EACH ROW EXECUTE FUNCTION enforce_warrant_one_way();

-- An Approval is SINGLE-USE: denied/collected/lapsed are terminal.
CREATE OR REPLACE FUNCTION enforce_approval_one_way() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('denied', 'collected', 'lapsed') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'approval % is single-use (A17.11): % is terminal', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approvals_one_way ON approvals;
CREATE TRIGGER trg_approvals_one_way
  BEFORE UPDATE OF status ON approvals
  FOR EACH ROW EXECUTE FUNCTION enforce_approval_one_way();

COMMENT ON TABLE warrants IS
  'Warrants (AZ-S4, design 4d961e37 §6.2, A17.5): standing, owner-created, revocable mint authorizations. Ceiling = version-pinned profile reference (AZ-21b) XOR inline rules, never unbounded; mandatory expiry (single-task warrants may be task-terminal, computed by the sweep); live-cap bound to the CREATING principal (AZ-31a auto-suspend); mint takes SELECT FOR UPDATE on this row (AZ-33b, T18).';
COMMENT ON COLUMN warrants.minted_total IS
  '§6.2 cap counter: identities ever minted under this warrant (max_total ceiling); max_concurrent is counted LIVE through principals.minted_under_warrant_id.';
COMMENT ON TABLE warrant_anchors IS
  'Warrant scope anchors (§6.2/§6.3): tasks, phases, projects; union semantics. Every mint names its target Task and the server validates containment in this union.';
COMMENT ON TABLE approvals IS
  'Approvals (AZ-S4, design 4d961e37 §6.1/§6.1a, A17.11): pending · approved · denied · collected · lapsed. Bound to the exact requesting credential id (AZ-31c — rotation/grace/revocation lapses outstanding rows) or to session + step-up evidence for the atomic session mint. Single-use; collect re-runs the COMPLETE mint validation transactionally.';
COMMENT ON COLUMN principals.minted_under_warrant_id IS
  '§6.4: queryable provenance — the warrant this Agent identity was minted under (NULL for approval-path and session mints).';
