-- 162_skill_owner.sql — the Skill owner column (AZ-A12 clause 15 M-c; build 4,
-- card 1942926f) and its first, owner-directed assignment (card d67e6990).
-- Reserved in backend/src/migrations/RESERVED as slot 162 in the same commit
-- as this file (ruling 0464ad54 section 2).
--
-- 1. M-c, as ratified: `skills.owner_principal_id UUID REFERENCES
--    principals(id)`. An owner is a person Account (a parentless, non-legacy
--    human principal) or a Group principal (clause 4 admits the column naming a
--    Group). The column is NULL for a Skill nobody has been assigned: such a
--    Skill keeps the registry's earlier behaviour (no owner arm, and every
--    registry manager sees its drafts).
--
-- 2. A backstop trigger refuses any other kind of owner value at the write:
--    an Agent, a Connector, a service Account, a legacy identity or an unknown
--    id never owns a Skill.
--
-- 3. The first assignment, by EXPLICIT LIST and never by inference (clause 4:
--    no historical ownership is inferred; no creator, grant or provenance is
--    read to decide an owner). The registry this deployment serves holds 27
--    imported Skill drafts that belong to a second Account; they are listed
--    below by Skill id and assigned to that Account. Every other Skill still
--    without an owner is then assigned to the first Account. Both Accounts are
--    named by principal id. Each statement assigns only while the named Account
--    exists as an active, parentless, non-legacy human principal, and only a
--    Skill whose owner is still NULL, so on any other database (a fresh
--    install, a test database, an estate where those ids are absent) nothing is
--    assigned and every Skill stays unowned. The Skill names behind the 27 ids
--    are kept in the build record, outside this tree.
--
-- One column, one index, one function, one trigger and two guarded UPDATEs in
-- one implicit transaction, no COMMIT. Every statement is replay-safe.
-- database/init.sql is untouched.

ALTER TABLE skills ADD COLUMN IF NOT EXISTS owner_principal_id UUID REFERENCES principals(id);

CREATE INDEX IF NOT EXISTS skills_owner_principal_idx ON skills (owner_principal_id)
  WHERE owner_principal_id IS NOT NULL;

COMMENT ON COLUMN skills.owner_principal_id IS
  'AZ-A12 M-c: the Skill owner, a person Account or a Group principal; NULL = unowned.';

CREATE OR REPLACE FUNCTION relayhall_skill_owner_shape() RETURNS trigger AS $$
DECLARE
  owner_row RECORD;
BEGIN
  IF NEW.owner_principal_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT kind, parent_principal_id, legacy_identity INTO owner_row
    FROM principals WHERE id = NEW.owner_principal_id;
  IF NOT FOUND
     OR NOT ((owner_row.kind = 'human' AND owner_row.parent_principal_id IS NULL
              AND NOT owner_row.legacy_identity)
             OR owner_row.kind = 'group') THEN
    RAISE EXCEPTION 'A Skill owner must be a person Account or a Group principal'
      USING ERRCODE = '23514', CONSTRAINT = 'skills_owner_shape';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS skills_owner_shape ON skills;
CREATE TRIGGER skills_owner_shape
BEFORE INSERT OR UPDATE OF owner_principal_id ON skills
FOR EACH ROW EXECUTE FUNCTION relayhall_skill_owner_shape();

-- The 27 imported drafts of the second Account (Skill ids, sorted).
UPDATE skills s
   SET owner_principal_id = a.id
  FROM principals a
 WHERE a.id = '731c8872-6773-48cb-bc46-e3a364d1c316'
   AND a.kind = 'human' AND a.status = 'active'
   AND a.parent_principal_id IS NULL AND NOT a.legacy_identity
   AND s.owner_principal_id IS NULL
   AND s.id IN (
     '142d4ddc-b081-400f-b7d3-cba136f41ea4',
     '17aea6f6-1278-47fd-b4e4-04c04e96af3d',
     '29240a0d-8472-4eeb-8a9c-eaa85ac50a79',
     '3160b3e4-dd98-4860-9b99-42f76de31daa',
     '3a8236d6-470c-4aba-9277-5b5edc4ee25a',
     '3bddd8ec-f5fd-45c8-8967-2dec195321d7',
     '40b62ef5-c02b-45be-9aab-165b9d2fc3f5',
     '43c17473-8f86-4f56-9bab-644a9d1d84ba',
     '4916f512-399e-4672-b284-8363d1029b6a',
     '508a046e-44c1-413b-95c7-e50c16762555',
     '571d9523-33ee-453a-a245-017a7105d025',
     '5cfa3a18-63b1-4489-b7a2-36aae070480c',
     '5fe8bf1b-8f49-4428-b904-ca8a55095d7c',
     '62dde256-6400-489d-babe-93e1c6af28a4',
     '6e042ac1-adfe-452a-95cc-5459111b0d66',
     '7a4c7f1e-fc92-43c5-98cd-49e001876034',
     '7d01016c-a464-4129-b4ff-1b6020b97d1d',
     '87e8dd50-ca40-49fc-a733-0e3edd54c33a',
     '8d13229a-973c-41e0-9c7b-4df9aa36016a',
     '8dac9f65-dfb4-4df9-b7a9-666659bfb784',
     '99c632e0-7b80-4400-b331-663e8121d3b2',
     'be6d8591-71a2-4344-9395-13fd296ce95a',
     'c6afbdbd-c70b-4035-9fb0-453aa9fd76fe',
     'c9ccc1e9-e78e-471e-aa1a-f0153bfa00af',
     'd5bdd3e2-c34a-4a9e-9013-3bf905408361',
     'e0b1dbcb-4e54-4fa1-8196-33f5dbb5436f',
     'efbee213-995d-4a56-b02b-f43b94f6c4d6'
   );

-- Every other Skill still without an owner goes to the first Account.
UPDATE skills s
   SET owner_principal_id = a.id
  FROM principals a
 WHERE a.id = '15e4255b-3dc9-42da-a892-b5f0a95293b4'
   AND a.kind = 'human' AND a.status = 'active'
   AND a.parent_principal_id IS NULL AND NOT a.legacy_identity
   AND s.owner_principal_id IS NULL;
