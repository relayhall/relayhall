-- AZ-A10 clauses 1-14 (E43/E62): role-linked, assignee-landed task grants.
-- The link owns the role; the ordinary grant row keeps its ratified provenance.
ALTER TABLE access_vehicle_links ADD COLUMN IF NOT EXISTS role text;
ALTER TABLE access_vehicle_links DROP CONSTRAINT IF EXISTS access_vehicle_links_vehicle_kind_check;
ALTER TABLE access_vehicle_links ADD CONSTRAINT access_vehicle_links_vehicle_kind_check
  CHECK (vehicle_kind IN ('warrant', 'auto-grant', 'role'));
ALTER TABLE access_vehicle_links DROP CONSTRAINT IF EXISTS access_vehicle_links_warrant_shape;
ALTER TABLE access_vehicle_links ADD CONSTRAINT access_vehicle_links_warrant_shape CHECK (
  (vehicle_kind = 'warrant' AND warrant_id IS NOT NULL AND role IS NULL)
  OR (vehicle_kind = 'auto-grant' AND warrant_id IS NULL AND role IS NULL)
  OR (vehicle_kind = 'role' AND warrant_id IS NULL AND role IN ('implementer', 'verifier', 'shepherd'))
);
ALTER TABLE access_vehicle_links DROP CONSTRAINT IF EXISTS access_vehicle_links_expiry_shape;
ALTER TABLE access_vehicle_links ADD CONSTRAINT access_vehicle_links_expiry_shape
  CHECK (expires_at IS NULL OR (vehicle_kind IN ('auto-grant', 'role') AND target_kind = 'grant'));
ALTER TABLE access_vehicle_links DROP CONSTRAINT IF EXISTS access_vehicle_links_task_id_target_kind_target_id_key;
ALTER TABLE access_vehicle_links ADD CONSTRAINT access_vehicle_links_task_target_role_key
  UNIQUE NULLS NOT DISTINCT (task_id, target_kind, target_id, role);

ALTER TABLE principals ADD COLUMN IF NOT EXISTS bound_task_role text;
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_bound_task_role_shape;
ALTER TABLE principals ADD CONSTRAINT principals_bound_task_role_shape CHECK (
  bound_task_role IS NULL OR (kind = 'agent' AND bound_task_role IN ('implementer', 'verifier', 'shepherd'))
);
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS requested_role text;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_requested_role_shape;
ALTER TABLE approvals ADD CONSTRAINT approvals_requested_role_shape
  CHECK (requested_role IS NULL OR requested_role IN ('implementer', 'verifier', 'shepherd'));

ALTER TABLE phases ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE phases DROP CONSTRAINT IF EXISTS phases_description_length;
ALTER TABLE phases ADD CONSTRAINT phases_description_length
  CHECK (description IS NULL OR char_length(description) <= 20000);

-- The pre-AZ-A10 Batch 10 default was computed in memory. Stamp live Agents
-- before that default disappears; an explicit stored role is never rewritten.
UPDATE principals p SET bound_task_role = CASE
  WHEN EXISTS (SELECT 1 FROM principal_credentials c WHERE c.principal_id = p.id
    AND c.revoked_at IS NULL AND c.expires_at > NOW()
    AND c.scopes @> '["tasks:write"]'::jsonb) THEN 'implementer'
  ELSE 'verifier' END
WHERE p.kind = 'agent' AND p.status = 'active'
  AND p.bound_task_id IS NOT NULL AND p.bound_task_role IS NULL
  AND EXISTS (SELECT 1 FROM principal_credentials c WHERE c.principal_id = p.id
    AND c.revoked_at IS NULL AND c.expires_at > NOW());

-- A deliberately narrow proof of an historical assigner's CURRENT effective
-- cap. It accepts a live Account's owner-plane grant (or its real admin role),
-- and delegated chains whose every live credential and stored own() expression
-- says `parent`. Other shapes need the runtime predicate at a new assigning
-- act; guessing their effective authority in a migration would widen access.
CREATE OR REPLACE FUNCTION az_a10_backfill_proven_cap(
  principal uuid, resource_type_arg text, resource_id_arg uuid, verb_arg text
) RETURNS boolean LANGUAGE plpgsql AS $az_cap$
DECLARE
  link record;
  next_id uuid := principal;
  hops integer := 0;
  required_scope text := CASE resource_type_arg
    WHEN 'task' THEN 'tasks:' || verb_arg
    WHEN 'phase' THEN 'phases:' || verb_arg
    WHEN 'report' THEN 'reports:' || verb_arg
    WHEN 'skill' THEN 'skills:' || verb_arg
    ELSE NULL END;
BEGIN
  IF required_scope IS NULL THEN RETURN FALSE; END IF;
  LOOP
    IF next_id IS NULL OR hops > 3 THEN RETURN FALSE; END IF;
    SELECT p.id, p.kind, p.status, p.role, p.parent_principal_id, p.own_expression
      INTO link FROM principals p WHERE p.id = next_id;
    IF NOT FOUND OR link.status <> 'active' THEN RETURN FALSE; END IF;
    IF link.parent_principal_id IS NULL THEN
      IF link.kind NOT IN ('human','service') THEN RETURN FALSE; END IF;
      IF lower(coalesce(link.role, '')) IN ('admin','operator','orchestrator') THEN RETURN TRUE; END IF;
      RETURN EXISTS (
        SELECT 1 FROM grants cap WHERE cap.grantee_type = 'principal'
          AND cap.grantee_id = link.id AND cap.provenance IS NULL
          AND cap.resource_type = resource_type_arg
          AND (cap.resource_id = resource_id_arg OR cap.resource_id IS NULL)
          AND (cap.expires_at IS NULL OR cap.expires_at > NOW())
          AND (cap.verb = 'admin' OR cap.verb = 'write'
               OR (verb_arg = 'read' AND cap.verb = 'read'))
      );
    END IF;
    IF link.own_expression -> 'scopes' IS DISTINCT FROM '"parent"'::jsonb
      AND NOT COALESCE(link.own_expression -> 'scopes' ? required_scope, FALSE) THEN RETURN FALSE; END IF;
    IF NOT EXISTS (SELECT 1 FROM principal_credentials c WHERE c.principal_id = link.id
      AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > NOW())
      AND (c.grace_until IS NULL OR c.grace_until > NOW())
      AND c.scopes ? required_scope) THEN RETURN FALSE; END IF;
    IF link.own_expression -> 'objects' IS DISTINCT FROM '"parent"'::jsonb THEN RETURN FALSE; END IF;
    next_id := link.parent_principal_id;
    hops := hops + 1;
  END LOOP;
END $az_cap$;

-- Backfill is one transaction with the schema. Only nonterminal tasks acquire
-- rows. Existing owner-plane tuples are linked with FALSE and never edited.
DO $az_a10$
DECLARE
  holder record;
  ref record;
  grant_id uuid;
  created_flag boolean;
  link_expiry timestamptz;
  old_link record;
  assigner_id uuid;
  cap_proved boolean;
  ceiling_proved boolean;
  unresolved_reason text;
BEGIN
  FOR holder IN
    SELECT t.id AS task_id, s.principal_id AS principal_id, 'implementer'::text AS role
      FROM tasks t JOIN services s ON s.id = t.execution_service_id
     WHERE t.status NOT IN ('completed','archived') AND s.principal_id IS NOT NULL
    UNION ALL
    SELECT t.id, t.verifier_principal_id, 'verifier' FROM tasks t
     WHERE t.status NOT IN ('completed','archived') AND t.verifier_principal_id IS NOT NULL
    UNION ALL
    SELECT t.id, t.shepherd_principal_id, 'shepherd' FROM tasks t
     WHERE t.status NOT IN ('completed','archived') AND t.shepherd_principal_id IS NOT NULL
    UNION ALL
    SELECT t.id, p.id, p.bound_task_role FROM principals p JOIN tasks t ON t.id = p.bound_task_id
     WHERE p.kind = 'agent' AND p.status = 'active' AND p.bound_task_role IS NOT NULL
       AND t.status NOT IN ('completed','archived')
       AND EXISTS (SELECT 1 FROM principal_credentials c WHERE c.principal_id = p.id
         AND c.revoked_at IS NULL AND c.expires_at > NOW())
  LOOP
    IF NOT EXISTS (SELECT 1 FROM principals p WHERE p.id = holder.principal_id
      AND p.status = 'active' AND NOT (p.kind = 'human' AND p.role IN ('admin','orchestrator'))) THEN
      CONTINUE;
    END IF;
    SELECT CASE WHEN p.kind = 'agent' THEN (
      SELECT MAX(c.expires_at) FROM principal_credentials c
       WHERE c.principal_id = p.id AND c.revoked_at IS NULL AND c.expires_at > NOW()
    ) ELSE NOW() + INTERVAL '3 months' END INTO link_expiry
      FROM principals p WHERE p.id = holder.principal_id;
    IF link_expiry IS NULL THEN CONTINUE; END IF;
    -- A field holder does not identify who assigned it. The old execution
    -- vehicle does, when every one of its links names the same real actor.
    -- A bound Agent's parent is the requester stored by executeMint. Other
    -- historical field writes without attributable evidence stay unresolved.
    assigner_id := NULL;
    SELECT CASE WHEN COUNT(*) > 0 AND COUNT(DISTINCT l.created_by_principal_id) = 1
                   AND BOOL_AND(l.created_by_principal_id IS NOT NULL)
                THEN MIN(l.created_by_principal_id::text)::uuid ELSE NULL END
      INTO assigner_id
      FROM access_vehicle_links l
     WHERE l.task_id = holder.task_id AND l.vehicle_kind = 'auto-grant'
       AND l.assignee_principal_id = holder.principal_id AND holder.role = 'implementer';
    IF assigner_id IS NULL THEN
      SELECT p.parent_principal_id INTO assigner_id FROM principals p
       WHERE p.id = holder.principal_id AND p.kind = 'agent'
         AND p.bound_task_id = holder.task_id;
    END IF;
    IF EXISTS (SELECT 1 FROM principals p WHERE p.id = holder.principal_id
               AND p.kind = 'agent' AND p.minted_under_warrant_id IS NOT NULL) THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM unnest(CASE WHEN holder.role = 'implementer'
          THEN ARRAY['read','write']::text[] ELSE ARRAY['read']::text[] END) AS required(verb)
        WHERE NOT EXISTS (
          SELECT 1 FROM principals p JOIN warrants w ON w.id = p.minted_under_warrant_id
            JOIN access_profile_rules rule ON rule.version_id = w.ceiling_profile_version_id
           WHERE p.id = holder.principal_id AND w.status = 'active'
             AND (w.expires_at IS NULL OR w.expires_at > NOW())
             AND rule.resource_type = 'task' AND required.verb = ANY(rule.verbs)
             AND (rule.selector_form = 'all-of-type'
               OR (rule.selector_form = 'exact' AND holder.task_id = ANY(rule.selector_ids))
               OR (rule.selector_form = 'all-in-project' AND
                   (SELECT project_id FROM tasks WHERE id = holder.task_id) = ANY(rule.selector_ids)))
        )
      ) INTO ceiling_proved;
      IF NOT ceiling_proved THEN
        RAISE EXCEPTION 'AZ-A10 backfill refuses Agent % on task %: bound row exceeds pinned warrant ceiling',
          holder.principal_id, holder.task_id;
      END IF;
    END IF;
    -- The bound-task row is load-bearing. Never give a holder only its
    -- attached references when that row cannot be attributed and capped.
    IF assigner_id IS NULL OR NOT az_a10_backfill_proven_cap(
      assigner_id, 'task', holder.task_id,
      CASE WHEN holder.role = 'implementer' THEN 'write' ELSE 'read' END) THEN
      INSERT INTO audit_events (action, actor_handle, auth_method, outcome, resource_type, resource_id, metadata)
      VALUES ('grant.reference_skipped', 'system', 'system', 'success', 'task', holder.task_id::text,
        jsonb_build_object('taskId', holder.task_id, 'assigneePrincipalId', holder.principal_id,
          'role', holder.role, 'assignerPrincipalId', assigner_id,
          'reason', 'bound task exceeds provable assigner cap or attribution is missing',
          'migration', '149_az_a10_role_grants.sql'));
      IF EXISTS (SELECT 1 FROM principals p WHERE p.id = holder.principal_id AND p.kind = 'agent') THEN
        RAISE EXCEPTION 'AZ-A10 backfill refuses Agent % on task %: original assigner cap is unprovable',
          holder.principal_id, holder.task_id;
      END IF;
      CONTINUE;
    END IF;
    FOR ref IN
      SELECT 'task'::text AS resource_type, holder.task_id AS resource_id, 'read'::text AS verb
      UNION SELECT 'task', holder.task_id, 'write' WHERE holder.role = 'implementer'
      UNION SELECT 'phase', t.phase_id, 'read' FROM tasks t
        WHERE t.id = holder.task_id AND t.phase_id IS NOT NULL
      UNION SELECT 'task', d.depends_on_task_id, 'read' FROM task_dependencies d WHERE d.task_id = holder.task_id
      UNION SELECT 'report', r.id, 'read' FROM reports r WHERE holder.task_id = ANY(r.task_ids)
      UNION SELECT 'report', tr.target_id, 'read' FROM task_references tr
        WHERE tr.task_id = holder.task_id AND tr.kind = 'report' AND tr.target_id IS NOT NULL
      UNION SELECT 'skill', tr.target_id, 'read' FROM task_references tr
        WHERE tr.task_id = holder.task_id AND tr.kind = 'skill' AND tr.target_id IS NOT NULL
    LOOP
      -- The helper proves a deliberately narrow subset of the full runtime
      -- predicate. An unprovable reference is omitted, never materialized.
      cap_proved := az_a10_backfill_proven_cap(assigner_id, ref.resource_type,
        ref.resource_id, ref.verb);
      unresolved_reason := NULL;
      IF NOT cap_proved THEN unresolved_reason := 'reference exceeds provable assigner cap'; END IF;
      -- Pinned ceiling is an independent mandatory AND for warrant Agents.
      -- A missing/retired warrant or an unrecognized selector fails closed.
      ceiling_proved := TRUE;
      IF EXISTS (SELECT 1 FROM principals p WHERE p.id = holder.principal_id
                 AND p.minted_under_warrant_id IS NOT NULL) THEN
        SELECT EXISTS (
          SELECT 1 FROM principals p JOIN warrants w ON w.id = p.minted_under_warrant_id
            JOIN access_profile_rules rule ON rule.version_id = w.ceiling_profile_version_id
           WHERE p.id = holder.principal_id AND w.status = 'active'
             AND (w.expires_at IS NULL OR w.expires_at > NOW())
             AND rule.resource_type = ref.resource_type AND ref.verb = ANY(rule.verbs)
             AND (rule.selector_form = 'all-of-type'
               OR (rule.selector_form = 'exact' AND ref.resource_id = ANY(rule.selector_ids))
               OR (rule.selector_form = 'all-in-project' AND ref.resource_type IN ('task','phase')
                 AND EXISTS (SELECT 1 FROM projects project
                   WHERE project.id = ANY(rule.selector_ids)
                     AND project.id = CASE WHEN ref.resource_type = 'task'
                       THEN (SELECT target.project_id FROM tasks target WHERE target.id = ref.resource_id)
                       ELSE (SELECT target.project_id FROM phases target WHERE target.id = ref.resource_id)
                     END)))
        ) INTO ceiling_proved;
        IF NOT ceiling_proved THEN unresolved_reason := 'reference exceeds pinned warrant ceiling'; END IF;
      END IF;
      IF NOT cap_proved OR NOT ceiling_proved THEN
        INSERT INTO audit_events (action, actor_handle, auth_method, outcome, resource_type, resource_id, metadata)
        VALUES ('grant.reference_skipped', 'system', 'system', 'success', ref.resource_type, ref.resource_id::text,
          jsonb_build_object('taskId', holder.task_id, 'assigneePrincipalId', holder.principal_id,
            'role', holder.role, 'assignerPrincipalId', assigner_id,
            'reason', unresolved_reason, 'migration', '149_az_a10_role_grants.sql'));
        CONTINUE;
      END IF;
      SELECT g.id INTO grant_id FROM grants g WHERE g.grantee_type = 'principal'
        AND g.grantee_id = holder.principal_id AND g.resource_type = ref.resource_type
        AND g.resource_id = ref.resource_id AND g.verb = ref.verb;
      IF grant_id IS NULL THEN
        INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb,
          granted_by_principal_id, provenance, expires_at)
        VALUES ('principal', holder.principal_id, ref.resource_type, ref.resource_id,
          ref.verb, assigner_id, 'assignment:grant', link_expiry) RETURNING id INTO grant_id;
        created_flag := TRUE;
        INSERT INTO audit_events (action, actor_handle, auth_method, outcome, resource_type, resource_id, metadata)
        VALUES ('grant.create', 'system', 'system', 'success', 'grant', grant_id::text,
          jsonb_build_object('automatic', true, 'carriedBy', 'role', 'role', holder.role,
            'taskId', holder.task_id, 'assigneePrincipalId', holder.principal_id,
            'expiresAt', link_expiry, 'assignerPrincipalId', assigner_id,
            'migration', '149_az_a10_role_grants.sql'));
      ELSE
        SELECT COALESCE(BOOL_OR(l.created_by_vehicle), FALSE) INTO created_flag
          FROM access_vehicle_links l WHERE l.target_kind = 'grant' AND l.target_id = grant_id;
      END IF;
      INSERT INTO access_vehicle_links (task_id, assignee_principal_id, landed_on_principal_id,
        vehicle_kind, role, warrant_id, target_kind, target_id, created_by_vehicle,
        created_by_principal_id, expires_at)
      VALUES (holder.task_id, holder.principal_id, holder.principal_id,
        'role', holder.role, NULL, 'grant', grant_id, created_flag, assigner_id, link_expiry)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

  -- Replace the Account-landed fallback only after the assignee rows exist.
  -- The link flag is the D4 owner-plane guard; a shared target is retained.
  FOR old_link IN
    DELETE FROM access_vehicle_links old WHERE vehicle_kind = 'auto-grant'
      AND EXISTS (SELECT 1 FROM access_vehicle_links fresh WHERE fresh.task_id = old.task_id
        AND fresh.vehicle_kind = 'role' AND fresh.role = 'implementer'
        AND fresh.target_kind = 'grant')
      RETURNING target_kind, target_id, created_by_vehicle
  LOOP
    IF old_link.target_kind <> 'grant' OR NOT old_link.created_by_vehicle THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM access_vehicle_links l WHERE l.target_kind = 'grant'
      AND l.target_id = old_link.target_id) THEN
      DELETE FROM grants WHERE id = old_link.target_id AND provenance = 'assignment:grant';
      IF FOUND THEN
        INSERT INTO audit_events (action, actor_handle, auth_method, outcome, resource_type, resource_id, metadata)
        VALUES ('grant.revoke', 'system', 'system', 'success', 'grant', old_link.target_id::text,
          jsonb_build_object('reason', 'superseded by AZ-A10', 'migration', '149_az_a10_role_grants.sql'));
      END IF;
    END IF;
  END LOOP;
  UPDATE grants g SET expires_at = x.latest
    FROM (SELECT l.target_id AS grant_id,
      CASE WHEN BOOL_OR(l.expires_at IS NULL) THEN NULL ELSE MAX(l.expires_at) END AS latest
      FROM access_vehicle_links l WHERE l.target_kind = 'grant' AND l.vehicle_kind = 'role'
      GROUP BY l.target_id HAVING BOOL_AND(l.created_by_vehicle)) x
   WHERE g.id = x.grant_id AND g.provenance = 'assignment:grant'
     AND g.expires_at IS DISTINCT FROM x.latest;
END $az_a10$;
DROP FUNCTION az_a10_backfill_proven_cap(uuid, text, uuid, text);
