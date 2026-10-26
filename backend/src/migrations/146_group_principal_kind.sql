-- 146_group_principal_kind.sql
-- AZ-A12 build 1 (card 20f40e40): a Group is a principal of kind 'group'.
-- AUTHZ amendment AZ-A12 "Groups become principals" (RATIFIED 2026-10-10,
-- ruling E72; text in AUTHZ AMENDMENTS COMPANION 2 003511f6), clauses 1-3
-- and clause 15 M-a.
--
-- ONE ID, ONE LIFECYCLE (clause 2). The Group principal's id IS the Group's
-- id (principals.id = groups.id): grants.grantee_id already holds groups.id
-- for every Group grant (078, no FK), and every ownership column is an FK to
-- principals(id), so "owned by G" and "granted to G" join on one value and
-- no existing grant is remapped. groups.id is immutable (094), so the pair
-- cannot drift. The handle is 'group:' || id, the display name is the
-- Group's name, the status is 'active', the role is NULL, and there is no
-- parent. The Group writers (GroupService.create and the directory
-- reference "Use this group" act) insert the principal row first and the
-- groups row in the same statement; this migration backfills one principal
-- row per existing groups row, and only that: NO ownership is inferred
-- (clause 4, "No historical ownership is inferred").
--
-- WHAT A GROUP PRINCIPAL NEVER IS (clause 3), with the backstop this file
-- adds for each:
--   (a) no credential, no login session, no Identity link, no home group:
--       one guard function wired on principal_credentials, auth_sessions,
--       identity_links and account_home_groups;
--   (b) no chain: the 096 chain-shape function is replaced here (the 096
--       file itself is untouched) with an explicit refusal of a Group parent
--       and of a parented Group; principals_group_shape forbids every chain
--       and Agent column on a Group row;
--   (c) it never acts: tasks' claimant, shepherd, verifier and creator, and
--       reports.author_principal_id refuse a Group value (a non-writing
--       BEFORE trigger, named to sort AFTER trg_tasks_shepherd_fallback so
--       it judges the final NEW values);
--   (d) it is never a Group member: the 094 member function is replaced
--       here (the 094 file itself is untouched) with a refusal of
--       member_kind = 'group'. Nested groups are refused, not deferred.
--
-- One implicit transaction, no COMMIT. Idempotent and fresh-replay safe:
-- every constraint is dropped and re-added by name, every function is
-- CREATE OR REPLACE, every trigger is DROP IF EXISTS first, the backfill is
-- WHERE NOT EXISTS, the groups FK is added only when absent, and the
-- self-checks hold on a second run. database/init.sql is untouched.

-- (a) SELF-CHECK, before anything is changed. The handle CHECK below
-- reserves the 'group:' prefix for this kind, and the backfill takes each
-- Group's id for its principal row; either fails on a database that already
-- holds such a value, so this names the count instead of a constraint error.
DO $$
DECLARE
  prefixed bigint;
  colliding bigint;
BEGIN
  SELECT count(*) INTO prefixed
    FROM principals WHERE kind <> 'group' AND handle LIKE 'group:%';
  IF prefixed > 0 THEN
    RAISE EXCEPTION 'AZ-A12 migration 146 self-check: % existing non-Group principal handle(s) start with the reserved prefix group:', prefixed
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO colliding
    FROM principals p JOIN groups g ON g.id = p.id
   WHERE p.kind <> 'group';
  IF colliding > 0 THEN
    RAISE EXCEPTION 'AZ-A12 migration 146 self-check: % principal row(s) share an id with a Group and are not of kind group', colliding
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- (b) The kind vocabulary gains 'group' (clause 1; the 062 inline CHECK).
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_kind_check;
ALTER TABLE principals ADD CONSTRAINT principals_kind_check
  CHECK (kind IN ('human', 'agent', 'service', 'group'));

-- (c) The Group shape (clause 15 M-a, verbatim). The status values and the
-- terminated_at stamp are already bound by principals_status_check and
-- principals_terminated_stamp (096).
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_group_shape;
ALTER TABLE principals ADD CONSTRAINT principals_group_shape
  CHECK (kind <> 'group' OR (
    parent_principal_id IS NULL AND role IS NULL AND bound_task_id IS NULL
    AND own_expression IS NULL AND owner_control_account_id IS NULL
    AND personality_id IS NULL AND minted_under_warrant_id IS NULL
    AND purpose IS NULL AND harness IS NULL AND source_tag IS NULL
    AND NOT legacy_identity));

-- (d) The 'group:' handle prefix belongs to this kind and only to it.
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_group_handle;
ALTER TABLE principals ADD CONSTRAINT principals_group_handle
  CHECK ((kind = 'group') = (handle LIKE 'group:%'));

-- (e) Clause 3(a): no credential, no login session, no Identity link and no
-- home group for a Group principal. ONE function; each trigger names the
-- column it guards as its argument.
CREATE OR REPLACE FUNCTION refuse_group_principal_reference() RETURNS trigger AS $$
DECLARE
  referenced uuid;
BEGIN
  referenced := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  IF referenced IS NOT NULL
     AND EXISTS (SELECT 1 FROM principals WHERE id = referenced AND kind = 'group') THEN
    RAISE EXCEPTION 'a Group principal never authenticates (AZ-A12 clause 3a): %.% cannot name one', TG_TABLE_NAME, TG_ARGV[0]
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_principal_credentials_not_group ON principal_credentials;
CREATE TRIGGER trg_principal_credentials_not_group
  BEFORE INSERT OR UPDATE OF principal_id ON principal_credentials
  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_reference('principal_id');

DROP TRIGGER IF EXISTS trg_auth_sessions_not_group ON auth_sessions;
CREATE TRIGGER trg_auth_sessions_not_group
  BEFORE INSERT OR UPDATE OF principal_id ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_reference('principal_id');

DROP TRIGGER IF EXISTS trg_identity_links_not_group ON identity_links;
CREATE TRIGGER trg_identity_links_not_group
  BEFORE INSERT OR UPDATE OF account_principal_id ON identity_links
  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_reference('account_principal_id');

DROP TRIGGER IF EXISTS trg_account_home_groups_not_group ON account_home_groups;
CREATE TRIGGER trg_account_home_groups_not_group
  BEFORE INSERT OR UPDATE OF account_principal_id ON account_home_groups
  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_reference('account_principal_id');

-- (f) Clause 3(d): a Group is never a member of a Group. The 094 function,
-- replaced with one added branch; the 094 trigger keeps calling it.
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
  IF member_kind = 'group' THEN
    RAISE EXCEPTION 'group members must be Accounts (A17.6): a Group is never a member of a Group (AZ-A12 clause 3d)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF member_parented THEN
    RAISE EXCEPTION 'group members must be parentless Accounts (A17.6): parented identities are never members'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- (g) Clause 3(b): a Group principal is parentless and never a parent. The
-- 096 function, replaced with two added refusals at its head (they run for
-- legacy rows too, which the 096 short-circuit below them would admit); the
-- 096 trigger keeps calling it.
CREATE OR REPLACE FUNCTION enforce_delegation_chain_shape() RETURNS trigger AS $$
DECLARE
  parent_row RECORD;
BEGIN
  IF NEW.kind = 'group' AND NEW.parent_principal_id IS NOT NULL THEN
    RAISE EXCEPTION 'chain shape (AZ-A12 clause 3b): a Group principal is parentless'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.parent_principal_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM principals WHERE id = NEW.parent_principal_id AND kind = 'group') THEN
    RAISE EXCEPTION 'chain shape (AZ-A12 clause 3b): a Group principal is never a parent, so no Connector or Agent is minted under a Group'
      USING ERRCODE = 'check_violation';
  END IF;
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

-- (h) Clause 3(c): a Group principal never acts, so the authority-bearing
-- task columns and a Report's author refuse one. The trigger WRITES NOTHING:
-- it reads NEW and either raises or returns it unchanged. On tasks it is
-- named to sort after trg_tasks_shepherd_fallback (BEFORE triggers fire in
-- name order), so it judges the shepherd that fallback has just copied in.
CREATE OR REPLACE FUNCTION refuse_group_principal_actor() RETURNS trigger AS $$
DECLARE
  candidate jsonb := to_jsonb(NEW);
  column_name text;
  referenced uuid;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    referenced := (candidate ->> column_name)::uuid;
    IF referenced IS NOT NULL
       AND EXISTS (SELECT 1 FROM principals WHERE id = referenced AND kind = 'group') THEN
      RAISE EXCEPTION 'a Group principal never acts (AZ-A12 clause 3c): %.% cannot name one', TG_TABLE_NAME, column_name
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_unassignable_group_principal ON tasks;
CREATE TRIGGER trg_tasks_unassignable_group_principal
  BEFORE INSERT OR UPDATE OF owner_principal_id, shepherd_principal_id, verifier_principal_id, creator_principal_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_actor(
    'owner_principal_id', 'shepherd_principal_id', 'verifier_principal_id', 'creator_principal_id');

DROP TRIGGER IF EXISTS trg_reports_unassignable_group_principal ON reports;
CREATE TRIGGER trg_reports_unassignable_group_principal
  BEFORE INSERT OR UPDATE OF author_principal_id ON reports
  FOR EACH ROW EXECUTE FUNCTION refuse_group_principal_actor('author_principal_id');

-- (i) Backfill: one principal row per existing Group, id = groups.id. Rows
-- only; no ownership column is written.
INSERT INTO principals (id, kind, handle, display_name, status)
SELECT g.id, 'group', 'group:' || g.id::text, left(g.name, 255), 'active'
  FROM groups g
 WHERE NOT EXISTS (SELECT 1 FROM principals p WHERE p.id = g.id);

-- (j) Every Group has its principal; a Group principal outlives its Group
-- row (terminated, kept for provenance), never the other way round.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'groups_id_principal_fkey'
       AND conrelid = 'public.groups'::regclass
  ) THEN
    ALTER TABLE groups ADD CONSTRAINT groups_id_principal_fkey
      FOREIGN KEY (id) REFERENCES principals(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- (k) POST-CHECK: every Group has exactly the principal clause 2 describes.
DO $$
DECLARE
  unpaired bigint;
BEGIN
  SELECT count(*) INTO unpaired
    FROM groups g
   WHERE NOT EXISTS (
     SELECT 1 FROM principals p
      WHERE p.id = g.id AND p.kind = 'group' AND p.handle = 'group:' || g.id::text);
  IF unpaired > 0 THEN
    RAISE EXCEPTION 'AZ-A12 migration 146 post-check: % Group(s) lack a kind=group principal with the handle group:<id>', unpaired
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
