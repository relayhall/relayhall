-- RelayHall estate vocabulary purge (task 405a77e2, RH-VOCAB.8; D-9, amendment A13).
--
-- Stored estate values move to RelayHall-native names. Non-destructive:
-- everything is rewritten in place; nothing is deleted. Guarded and
-- idempotent against upgrade and fresh-install databases alike.
--
--  1. legacy-env credential rows: the env-var NAMES live as data in
--     principal_credentials.key_id/label (revocation tracking keys off them);
--     renamed in lockstep with the RELAYHALL_* code cut so an existing
--     revocation keeps holding (A13.2 — the silent fail-open this prevents
--     is documented in inventory report bb8462db §1a).
--  2. status:write leaves stored scope arrays (A13.3 — the status-voice
--     surface was deleted; the scope left the vocabulary with it).
--  3. tasks.execution_profile accessProfile 'homelab' folds into 'network'
--     (A13.5 / DP-10).
--  4. The two seeded tools rows migration 065 missed ('clawboard',
--     'homelab-snapshots') are rewritten with 065's replace() pattern.

DO $$
BEGIN
  IF to_regclass('public.principal_credentials') IS NOT NULL THEN
    UPDATE principal_credentials
    SET key_id = replace(key_id, 'CLAWBOARD_', 'RELAYHALL_'),
        label  = replace(COALESCE(label, ''), 'env:CLAWBOARD_', 'env:RELAYHALL_')
    WHERE credential_type = 'legacy_env'
      AND (key_id LIKE 'CLAWBOARD_%' OR label LIKE 'env:CLAWBOARD_%');

    UPDATE principal_credentials
    SET scopes = COALESCE(
      (SELECT jsonb_agg(DISTINCT elem ORDER BY elem)
       FROM jsonb_array_elements_text(scopes) AS t(elem)
       WHERE elem <> 'status:write'),
      '[]'::jsonb
    )
    WHERE jsonb_typeof(scopes) = 'array' AND scopes @> '["status:write"]'::jsonb;
  END IF;

  IF to_regclass('public.tasks') IS NOT NULL THEN
    UPDATE tasks
    SET execution_profile = jsonb_set(execution_profile, '{accessProfile}', '"network"')
    WHERE execution_profile IS NOT NULL
      AND execution_profile->>'accessProfile' = 'homelab';
  END IF;

  IF to_regclass('public.tools') IS NOT NULL THEN
    UPDATE tools
    SET name = replace(replace(name, 'clawboard', 'relayhall'), 'homelab-snapshots', 'lan-snapshots'),
        usage_instructions = replace(replace(replace(replace(COALESCE(usage_instructions, ''),
          '`clawboard ', '`relayhall '), 'clawboard', 'relayhall'), 'ClawBoard', 'RelayHall'), 'homelab', 'LAN'),
        description = replace(replace(replace(COALESCE(description, ''),
          'clawboard', 'relayhall'), 'ClawBoard', 'RelayHall'), 'homelab', 'LAN')
    WHERE name IN ('clawboard', 'homelab-snapshots')
       OR usage_instructions LIKE '%clawboard%' OR usage_instructions LIKE '%ClawBoard%'
       OR usage_instructions LIKE '%homelab%';
  END IF;
END $$;
