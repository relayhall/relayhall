-- 152_lenses_c_group_stewards.sql
-- LENSES-c slice c1-A (card 46cfbd1d): the Group roles relation.
-- Design delta LENSES-C steward tier (ratified 2026-10-11, ruling E98),
-- clause C.1; AUTHZ amendment AZ-A12 clause 15 M-b, preferred branch: the
-- relation is born WITH its role column, so every steward row carries a role
-- from its first row.
--
-- A row says that an Account holds one Group role in one Group: 'owner' or
-- 'manager'. The primary key gives one role per Account per Group. Whether a
-- row CONFERS anything is derived at read and never stored: it is live only
-- while its holder is active, a member of the Group by any source, and holds
-- no elevated role (clause C.2, the one shared fragment in
-- utils/liveStewardCondition.ts, which the steward acts, the catalog and the
-- team-grants read compose). There is no cleanup trigger.
--
-- WHO WRITES IT. Root login sessions appoint and remove (C.3); a live
-- owner-role holder removes manager rows in that Group (C.4, ruling E98 Q3).
-- Termination writes nothing here: a terminated holder's row stays, inert
-- (D-9). Both foreign keys are ON DELETE RESTRICT, so a Group with steward
-- rows is refused deletion by name (GROUP_HAS_STEWARDS) and a principal row
-- is never deleted out from under one.
--
-- THE HOLDER TRIGGER refuses, each with a message naming its rule:
--   a holder that names no principal;
--   a kind outside the POSITIVE allowlist {human, service} (agent and group
--     are refused because they are not on it, never by negation);
--   a parented principal; a legacy identity; an elevated role
--     (admin, operator, orchestrator).
-- THE UPDATE TRIGGER refuses every UPDATE: a role change is a removal and
-- then an appointment, two audited acts.
--
-- No backfill: no steward row exists before this migration. One implicit
-- transaction, no COMMIT. Idempotent and fresh-replay safe: the table and
-- index are IF NOT EXISTS, the CHECK is dropped and re-added by name, the
-- functions are CREATE OR REPLACE, the triggers are DROP IF EXISTS first.
-- database/init.sql and every earlier migration are untouched.

CREATE TABLE IF NOT EXISTS group_stewards (
  group_id                  UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  account_principal_id      UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  role                      TEXT NOT NULL DEFAULT 'manager',
  appointed_by_principal_id UUID REFERENCES principals(id),
  appointed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, account_principal_id),
  CONSTRAINT group_stewards_role_check CHECK (role IN ('owner', 'manager'))
);

-- The CHECK is re-asserted by name so a relation created by an earlier draft
-- of this file carries exactly this definition.
ALTER TABLE group_stewards DROP CONSTRAINT IF EXISTS group_stewards_role_check;
ALTER TABLE group_stewards ADD CONSTRAINT group_stewards_role_check
  CHECK (role IN ('owner', 'manager'));

CREATE INDEX IF NOT EXISTS ix_group_stewards_account ON group_stewards(account_principal_id);

COMMENT ON TABLE group_stewards IS
  'LENSES-c c1 (card 46cfbd1d; design delta C.1, ratified E98): Group roles. One row per Account per Group, role owner or manager. A row confers nothing unless its holder is active, a member of the Group by any source, and not admin, operator or orchestrator (derived at read, C.2). Written only by the root steward acts and by an owner removing a manager row; termination writes nothing here.';

-- C.1: the holder test, at insert. The elevated set equals ELEVATED_ROLES
-- (utils/credentialAuthority.ts), asserted in both directions by the
-- registers suite (LC-C7).
CREATE OR REPLACE FUNCTION enforce_group_steward_holder() RETURNS trigger AS $$
DECLARE
  holder_kind TEXT;
  holder_parented BOOLEAN;
  holder_legacy BOOLEAN;
  holder_role TEXT;
BEGIN
  SELECT kind, parent_principal_id IS NOT NULL, legacy_identity, role
    INTO holder_kind, holder_parented, holder_legacy, holder_role
    FROM principals WHERE id = NEW.account_principal_id;
  IF holder_kind IS NULL THEN
    RAISE EXCEPTION 'group steward % names no principal (LENSES-c C.1)', NEW.account_principal_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF holder_kind NOT IN ('human', 'service') THEN
    RAISE EXCEPTION 'group steward holders must be human or service Accounts (LENSES-c C.1, kind allowlist): kind % is refused', holder_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF holder_parented THEN
    RAISE EXCEPTION 'group steward holders must be parentless Accounts (LENSES-c C.1, parented)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF holder_legacy THEN
    RAISE EXCEPTION 'group steward holders must not be legacy identities (LENSES-c C.1, legacy)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF holder_role IN ('admin', 'operator', 'orchestrator') THEN
    RAISE EXCEPTION 'group steward holders must hold no elevated role (LENSES-c C.1, elevated_role): % is refused', holder_role
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_group_steward_holder ON group_stewards;
CREATE TRIGGER enforce_group_steward_holder
  BEFORE INSERT ON group_stewards
  FOR EACH ROW EXECUTE FUNCTION enforce_group_steward_holder();

-- C.1: rows are never edited.
CREATE OR REPLACE FUNCTION enforce_group_steward_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'group steward rows are never edited (LENSES-c C.1): remove the row and appoint again'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_group_steward_no_update ON group_stewards;
CREATE TRIGGER enforce_group_steward_no_update
  BEFORE UPDATE ON group_stewards
  FOR EACH ROW EXECUTE FUNCTION enforce_group_steward_no_update();
