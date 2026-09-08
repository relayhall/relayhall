-- RelayHall authority re-cut (task 802e0f49, RH-VOCAB.4; D-10, amendments A5 + A12).
--
-- Stored credential scopes move to the ratified five-verb vocabulary:
--   'admin'        -> 'root'        (A12.1: the global sentinel got its own word;
--                                    admin is now only the per-object verb)
--   'tasks:prompt' -> 'tasks:read'  (§10: compiling a Brief is a disclosure act;
--                                    the authorisation survives, the scope retires)
--   'sessions:read'-> 'tasks:read'  (A12.2: the pipeline-health seed is an ops read)
--   'journal:read' / 'journal:publish' -> dropped (retired at P1.3 with no
--                                    successor; they satisfied nothing since)
-- Arrays are deduplicated after mapping and every row is rewritten, including
-- revoked and expired ones (owner ruling: scopes are live authority
-- configuration, not history — rotation copies them forward verbatim).
--
-- The seeded api-access tools row's prose names the fail-closed default; it
-- follows the sentinel rename.

DO $$
BEGIN
  IF to_regclass('public.principal_credentials') IS NOT NULL THEN
    UPDATE principal_credentials
    SET scopes = COALESCE(
      (
        SELECT jsonb_agg(DISTINCT mapped ORDER BY mapped)
        FROM (
          SELECT CASE elem
                   WHEN 'admin' THEN 'root'
                   WHEN 'tasks:prompt' THEN 'tasks:read'
                   WHEN 'sessions:read' THEN 'tasks:read'
                   ELSE elem
                 END AS mapped
          FROM jsonb_array_elements_text(scopes) AS t(elem)
          WHERE elem NOT IN ('journal:read', 'journal:publish')
        ) AS m
      ),
      '[]'::jsonb
    )
    WHERE jsonb_typeof(scopes) = 'array';
  END IF;

  IF to_regclass('public.tools') IS NOT NULL THEN
    UPDATE tools
    SET usage_instructions = replace(
      usage_instructions,
      'Unmapped scoped-key routes fail closed to `admin`.',
      'Unmapped scoped-key routes fail closed to `root`.'
    )
    WHERE usage_instructions LIKE '%Unmapped scoped-key routes fail closed to `admin`.%';
  END IF;
END $$;
