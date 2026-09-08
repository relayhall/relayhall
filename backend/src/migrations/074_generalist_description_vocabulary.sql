-- 074_generalist_description_vocabulary.sql
-- The 065 built-in seed described the Generalist personality with the retired
-- phrase "work items" (RH-VOCAB.2 / D-7: the product word is Task), and that
-- text is owner-visible on the Personalities page of every fresh install
-- (found during RH-P1.5c browser QA, task 796ba3f0).
--
-- Provenance-bound per the 073 doctrine: the rewrite is keyed by id after a
-- source='built-in' lookup and additionally bound to the exact 065-seeded
-- byte string, so a row whose description was changed by any other means —
-- or a non-built-in row that somehow holds the slug — is never touched.
--
-- database/init.sql deliberately keeps the old seed text (fresh-replay
-- doctrine: the baseline and historical migrations replay verbatim); a fresh
-- install reaches the ratified wording HERE, at the end of the chain.
--
-- The other 065 occurrence ("Manage work items through the RelayHall API or
-- CLI.", 065's tools-description CASE) needs no rewrite: migration 072
-- (A14.4 registry data reset) deletes every pre-072 registry row and re-seeds
-- the curated set, so that text exists only transiently mid-chain and never
-- survives to a final database state on any path.

DO $$
DECLARE
  builtin_generalist uuid;
BEGIN
  IF to_regclass('public.personalities') IS NULL THEN
    RETURN;
  END IF;

  SELECT id INTO builtin_generalist
  FROM personalities
  WHERE slug = 'generalist'
    AND source = 'built-in'
    AND description = 'A balanced default for ordinary work items.';

  IF builtin_generalist IS NULL THEN
    -- Nothing to do: the text was already rewritten, the slug is held by a
    -- non-built-in row, or the description carries different bytes — none of
    -- which this migration is licensed to touch.
    RETURN;
  END IF;

  UPDATE personalities
  SET description = 'A balanced default for ordinary tasks.',
      updated_at = now()
  WHERE id = builtin_generalist;
END $$;
