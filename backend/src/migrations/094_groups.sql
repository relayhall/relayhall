-- 094_groups.sql
-- RH-P3.AZ-S1 (card c3716fe7): the Groups substrate (AUTHZ design 4d961e37
-- §3, vocabulary amendment A17.6; strategy 4e40f06f Phase 3).
--
-- A Group is a board-minted object whose MEMBERS ARE ACCOUNTS ONLY
-- (A17.6): human and service Accounts, never delegated or parented
-- identities. principals.parent_principal_id exists since 062 as SPAWN
-- lineage and is re-founded by 096 as delegation lineage; the
-- parentless-member rule holds identically across both meanings, so the
-- trigger checks it directly and needs no 096 amendment.
--
-- Immutable id (A17.6): a trigger refuses UPDATE of groups.id. Group rows
-- are deletable only when empty (FK RESTRICT from group_members).
--
-- Membership source (AZ-30): 'local' rows are board-authored; 'directory'
-- rows belong to the sync snapshot and are dropped when the directory
-- removes the member (T31). Local rows deliberately SURVIVE directory
-- removal as explicit, audited exceptions (T33). The provider binding
-- itself is Phase 5 (task 2ae39bda); directory_sync_state carries the
-- fail-closed snapshot bookkeeping seam NOW (T32: sync failure keeps the
-- last snapshot and surfaces staleness past a threshold).
--
-- The group GRANT arm: grants.grantee_type='group' rows (the 078 seam)
-- resolve by membership join at query time — no schema change to grants.
--
-- Fresh-replay doctrine: database/init.sql untouched; idempotent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by_principal_id UUID REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT groups_name_nonempty CHECK (btrim(name) <> '')
);

-- Name uniqueness is case-insensitive: two groups whose names differ only
-- by case would be indistinguishable on every surface that lists them.
CREATE UNIQUE INDEX IF NOT EXISTS ux_groups_name_ci ON groups (lower(name));

CREATE TABLE IF NOT EXISTS group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  account_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'directory')),
  added_by_principal_id UUID REFERENCES principals(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, account_principal_id)
);

-- The membership lookup the grant arm joins through.
CREATE INDEX IF NOT EXISTS ix_group_members_account ON group_members(account_principal_id);

-- A17.6: members are Accounts only — never kind='agent', never parented
-- (spawn lineage today, delegation lineage after 096; see header).
CREATE OR REPLACE FUNCTION enforce_group_member_is_account() RETURNS trigger AS $$
DECLARE
  member_kind TEXT;
  member_parented BOOLEAN;
BEGIN
  SELECT kind, parent_principal_id IS NOT NULL
    INTO member_kind, member_parented
    FROM principals WHERE id = NEW.account_principal_id;
  IF member_kind IS NULL THEN
    RAISE EXCEPTION 'group member % names no principal', NEW.account_principal_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF member_kind = 'agent' THEN
    RAISE EXCEPTION 'group members must be Accounts (A17.6): agent identities are never members'
      USING ERRCODE = 'check_violation';
  END IF;
  IF member_parented THEN
    RAISE EXCEPTION 'group members must be parentless Accounts (A17.6): parented identities are never members'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_group_members_account_only ON group_members;
CREATE TRIGGER trg_group_members_account_only
  BEFORE INSERT OR UPDATE ON group_members
  FOR EACH ROW EXECUTE FUNCTION enforce_group_member_is_account();

-- A17.6: the group id is immutable.
CREATE OR REPLACE FUNCTION enforce_group_id_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'groups.id is immutable (A17.6)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_groups_id_immutable ON groups;
CREATE TRIGGER trg_groups_id_immutable
  BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION enforce_group_id_immutable();

-- AZ-30 seam: fail-closed directory-sync snapshot bookkeeping. One row per
-- provider (Phase 5 binds the real provider; 'local' deployments simply
-- never write here). last_success_at is the snapshot watermark the
-- staleness alarm reads; a failed sync updates last_attempt_at and
-- last_error_present ONLY — the membership snapshot is retained (T32).
CREATE TABLE IF NOT EXISTS directory_sync_state (
  provider TEXT PRIMARY KEY,
  last_success_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_error_present BOOLEAN NOT NULL DEFAULT FALSE,
  staleness_threshold_hours INTEGER NOT NULL DEFAULT 24
    CHECK (staleness_threshold_hours > 0)
);

COMMENT ON TABLE groups IS
  'Board-minted Groups (AZ-S1, design 4d961e37 §3, A17.6): immutable id; members are Accounts only. Mutation is owner-plane; introspection is principals:read.';
COMMENT ON TABLE group_members IS
  'Group membership (A17.6): Accounts only (trigger-enforced, parent-aware across the 094->096 window). source=local rows are board-authored and survive directory removal as audited exceptions (T33); source=directory rows belong to the sync snapshot (T31).';
COMMENT ON TABLE directory_sync_state IS
  'AZ-30 fail-closed sync bookkeeping seam: snapshot watermark + staleness threshold (default 24h). Provider binding lands with task 2ae39bda (Phase 5).';
COMMENT ON COLUMN group_members.source IS
  'local = explicit board-authored membership; directory = owned by the directory snapshot, dropped at the next sync when the directory no longer lists the member (T31).';
