-- RelayHall Verifier personality rename (task 102187c7, RH-VOCAB.9; D-11, amendment A15.6).
--
-- The built-in personality shipped by migration 065 carried the retired role
-- word: the role is Verifier, the state is review (vocabulary §5.3). Guarded,
-- idempotent, non-destructive: renames slug + name and rewrites the row's own
-- description/content heading to the ratified word. References are by UUID,
-- so task and attempt links are untouched. Fresh-replay doctrine: 065 seeds
-- the old name when the chain replays; this file renames at the end of the
-- chain (same pattern as 069 and 072).
--
-- TARGET SELECTION (review 2be77033 blocking finding): A15.6 licenses ONLY
-- the built-in seed row. 065 seeds with ON CONFLICT (slug) DO NOTHING, so an
-- upgrade database may instead hold a managed/git/legacy personality that
-- owns the slug — that row is user data and must survive byte-for-byte. The
-- UPDATE is therefore bound to source = 'built-in' and keyed by id; a slug
-- collision with an existing 'verifier' row skips EXPLICITLY (WARNING)
-- instead of mutating anything.
--
-- Deliberately untouched: the stored TaskAutomationRole values ('reviewer',
-- 'qa', …) and the reviewer-named code identifiers — frozen wire/stored
-- vocabulary documented in taskAutomationRole.ts, outside A15's licence.

DO $$
DECLARE
  builtin_reviewer uuid;
BEGIN
  IF to_regclass('public.personalities') IS NULL THEN
    RETURN;
  END IF;

  SELECT id INTO builtin_reviewer
  FROM personalities
  WHERE slug = 'reviewer' AND source = 'built-in';

  IF builtin_reviewer IS NULL THEN
    -- Nothing to do: the built-in was already renamed, or the slug is held
    -- by a non-built-in row, which this migration is not licensed to touch.
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM personalities WHERE slug = 'verifier') THEN
    RAISE WARNING 'migration 073: built-in personality % keeps slug ''reviewer'' — slug ''verifier'' is already taken by another row; resolve the collision and re-apply the rename manually', builtin_reviewer;
    RETURN;
  END IF;

  UPDATE personalities
  SET slug = 'verifier',
      name = 'Verifier',
      description = 'Independently challenges correctness, security, and product contracts.',
      content = replace(COALESCE(content, ''), '# Reviewer', '# Verifier'),
      updated_at = now()
  WHERE id = builtin_reviewer;
END $$;
