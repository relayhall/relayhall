-- 099_assignment_access_vehicles.sql
-- RH-P3.AZ-S7 (card 446240c4): assignment-access coupling — access
-- vehicles at assignment (owner ruling 7440b579; AUTHZ amendment AZ-A2,
-- design 4d961e37 §709-745; contract note d3accc39).
--
-- R1: assigning a task to a Connector REQUIRES an access vehicle, so the
-- assigned-but-invisible state is UNREPRESENTABLE and strategy 4e40f06f
-- §2.6.4's "grants ∪ current assignments" union holds BY CONSTRUCTION.
-- The §1 shared predicate is UNCHANGED and gains no arm; this file adds
-- no scope string and no vocabulary noun (b94dd86e untouched).
--
-- NUMBERING (run packet dedc11d8 D2, resolved): the parked C2 candidate
-- (branch p3-c2-webhooks @ 3a0de7a) also drafts a 099, and its file had
-- been applied to the DEV ledger before this run — D2 ordered that ledger
-- RESET, and it now tops out at 098. On main and on this branch 099 was
-- never taken. Two ratified ledger gates require a CONTIGUOUS forward
-- sequence (projectResourceMigrationContract: no gap from 068;
-- projectResourceLegacyLedgerV2: the pinned post-089 filename list), so a
-- 100 with no 099 beneath it turns CI red. AZ-S7 integrates FIRST — C2 is
-- board-blocked on this card — so it takes 099 and the parked C2 branch
-- renumbers its own to 100 during its round-4 repair. Order-independence
-- against a ledger already carrying C2's objects is proven separately in a
-- BEGIN/ROLLBACK harness. Nothing here reads or writes any C2 object.
--
-- ── The B5-class reference-counting trap (owner default D4) ─────────────
--
-- access_profile_assignments (095) is UNIQUE (profile_id, assignee_type,
-- assignee_id) and grants (078) is UNIQUE NULLS NOT DISTINCT
-- (grantee_type, grantee_id, resource_type, resource_id, verb). NEITHER
-- carries provenance or a refcount, so an owner-plane row and a
-- vehicle-materialized row collide on ONE tuple — and naive
-- "reference-counted removal at zero" would DELETE THE OWNER'S ROW. That
-- is exactly the shape of review round-3 finding B5 (migration 099
-- nulling stored endpoints).
--
-- D4 rules the fix and this file implements it for BOTH stores: a
-- SEPARATE linkage table carries the refcount, and the vehicle NEVER
-- deletes a target row it did not itself create. Ratified 078 and 095
-- semantics stay untouched — no unique constraint is altered, no column
-- is repurposed, and `created_by_vehicle` is decided ONCE per target (the
-- first linking vehicle records whether it created the row; later
-- vehicles copy the recorded flag rather than re-deciding it).
--
-- Fresh-replay doctrine: database/init.sql untouched; every statement
-- here is idempotent so re-running the file is a no-op.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── grants provenance (AZ-A2 §3) ───────────────────────────────────────
--
-- Written ONLY on rows the vehicle machinery creates. Deliberately NOT
-- part of any unique key: a pre-existing owner-plane grant keeps
-- provenance NULL and is never adopted, overwritten or reaped.

ALTER TABLE grants ADD COLUMN IF NOT EXISTS provenance TEXT;

ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_provenance_shape;
ALTER TABLE grants ADD CONSTRAINT grants_provenance_shape
  CHECK (provenance IS NULL OR provenance IN ('assignment:grant', 'assignment:warrant'));

COMMENT ON COLUMN grants.provenance IS
  'AZ-S7 / AZ-A2 par.3: NULL for every owner-plane grant. Set only on rows materialized to carry an execution assignment, which is also the only machinery permitted to reap them (access_vehicle_links.created_by_vehicle). Never part of a unique key — a colliding owner grant keeps NULL and is never adopted. The token values reach audit_events.metadata, so they spell ratified words.';

-- ── warrant idle grace (R4 / AZ-A2 par.4) ──────────────────────────────
--
-- The ratified sweep expired a warrant the moment every anchor went
-- terminal. R4 extends that with a grace window (default 6h,
-- deployment-configurable via RELAYHALL_WARRANT_IDLE_GRACE_HOURS): the
-- sweep STAMPS the moment all anchors first read terminal and expires
-- only once the window has elapsed. An anchor that reopens inside the
-- window clears the stamp — the grace has not been consumed, and §6.2's
-- "expiry is one-way" still holds because nothing has expired yet.

ALTER TABLE warrants ADD COLUMN IF NOT EXISTS anchors_terminal_since TIMESTAMPTZ;

COMMENT ON COLUMN warrants.anchors_terminal_since IS
  'AZ-S7 (ruling 7440b579 R4): when the lifecycle sweep first observed every anchor terminal. NULL while any anchor is open. Expiry fires once NOW() - anchors_terminal_since >= the deployment idle grace (default 6h). Reopening inside the window clears the stamp; it never resurrects an already-expired warrant (§6.2).';

-- ── task -> its vehicle (R5 two-way linkage; R4 reopen) ────────────────
--
-- Which Warrant, if any, carries this task's execution assignment. NULL
-- for the R2(b) auto-grant fallback. `warrant` is ratified vocabulary
-- (A17.5) and this is a plain FK column, not a new noun.
--
-- It exists because R4's reopen rule needs a fact that OUTLIVES the link
-- rows: a task's vehicle links are reaped when it goes terminal, so
-- without this column a task reopened after its warrant was revoked could
-- not tell "my warrant died" (R4: return UNASSIGNED) from "I never had
-- one" (R2(b): take the auto-grant fallback). It is also the task/phase ->
-- its vehicle half of the R5 two-way linkage the Access manager renders.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution_warrant_id UUID REFERENCES warrants(id);

CREATE INDEX IF NOT EXISTS ix_tasks_execution_warrant
  ON tasks(execution_warrant_id) WHERE execution_warrant_id IS NOT NULL;

COMMENT ON COLUMN tasks.execution_warrant_id IS
  'AZ-S7 (ruling 7440b579 R2/R4/R5): the Warrant carrying this execution assignment, or NULL for the auto-grant fallback. Cleared with the assignment. Outlives the reaped vehicle links so a reopened task can tell a dead warrant (return UNASSIGNED) from never having had one.';

-- The coupling invariant itself is enforced in the application at the
-- single write choke point (TaskManagerDB), inside the assignment's own
-- transaction, and is PROVEN there by re-running the production predicate
-- — a CHECK constraint cannot express "the assignee chain can read this
-- task". The schema half of "unrepresentable" is this: a warrant pointer
-- may never outlive its assignment.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_execution_warrant_needs_assignment;
ALTER TABLE tasks ADD CONSTRAINT tasks_execution_warrant_needs_assignment
  CHECK (execution_warrant_id IS NULL OR execution_service_id IS NOT NULL);

-- ── the vehicle-linkage table (owner default D4) ───────────────────────
--
-- One row per (task, target) pair the vehicle machinery depends on. The
-- REFCOUNT for a target is the number of live rows naming it: several
-- assigned tasks legitimately need the same report grant, and the target
-- survives until the last of them lets go.
--
-- vehicle_kind is INTERNAL machinery, not vocabulary: ruling 7440b579
-- states plainly that "vehicle" is descriptive prose in that report and
-- not a minted noun. Review bedc25f3 B1 caught the first cut shipping it
-- anyway, on a route path and as a capitalized UI heading; it is now
-- confined to internal identifiers. No route path, event name, audit
-- action or user-facing label introduces the word.

CREATE TABLE IF NOT EXISTS access_vehicle_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The assignment this linkage exists for.
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- The Connector principal the task is assigned to (services.principal_id).
  assignee_principal_id UUID NOT NULL REFERENCES principals(id),
  -- The chain member the vehicle actually landed on. Per the ratified
  -- intersection (AZ-24/AZ-26) a delegated link's side reduces to its own()
  -- cap, so object authority must reach the chain ROOT Account — granting
  -- the Connector alone changes nothing. Recorded explicitly so the
  -- Access manager can show WHERE the access lives.
  landed_on_principal_id UUID NOT NULL REFERENCES principals(id),
  vehicle_kind TEXT NOT NULL CHECK (vehicle_kind IN ('warrant', 'auto-grant')),
  warrant_id UUID REFERENCES warrants(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('grant', 'profile_assignment')),
  target_id UUID NOT NULL,
  -- Decided ONCE per target (D4). TRUE only when this machinery inserted
  -- the target row; an owner-plane row that already existed is linked with
  -- FALSE and is never deleted at refcount zero.
  created_by_vehicle BOOLEAN NOT NULL,
  created_by_principal_id UUID REFERENCES principals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT access_vehicle_links_warrant_shape CHECK (
    (vehicle_kind = 'warrant' AND warrant_id IS NOT NULL)
    OR (vehicle_kind = 'auto-grant' AND warrant_id IS NULL)
  ),
  UNIQUE (task_id, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS ix_access_vehicle_links_task
  ON access_vehicle_links(task_id);
CREATE INDEX IF NOT EXISTS ix_access_vehicle_links_target
  ON access_vehicle_links(target_kind, target_id);
CREATE INDEX IF NOT EXISTS ix_access_vehicle_links_warrant
  ON access_vehicle_links(warrant_id) WHERE warrant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_access_vehicle_links_assignee
  ON access_vehicle_links(assignee_principal_id);

COMMENT ON TABLE access_vehicle_links IS
  'AZ-S7 (ruling 7440b579 R2, owner default D4): the refcounted linkage between an assignment and the grant / access_profile_assignment rows that make the assignee chain able to READ its task. The refcount for a target is the number of live rows naming it; at zero the target is dropped ONLY when created_by_vehicle is TRUE. Ratified 078 and 095 semantics are untouched.';

-- ── R6 backfill: every currently-assigned task gets its vehicle ─────────
--
-- A root act, audited. Two dispositions are recorded in the contract note
-- (d3accc39 §I) and applied here:
--
--  * Nothing is materialized where the assignee can ALREADY read the task
--    without a vehicle — an administrator/orchestrator chain root is TRUE
--    on the Account side by ratified design (§5.1), so a vehicle would
--    only create reapable rows that were never needed.
--
--  * Where NO vehicle can be materialized and the assignee cannot already
--    reach the task, the row is AUTO-UNASSIGNED rather than left
--    violating R1. That is R4's own fail-safe direction ("a reopened task
--    whose vehicle is dead returns UNASSIGNED"), and it is the only
--    treatment that respects ratified T37 — legacy identities are frozen
--    out of BOTH new grants and profile assignment, so a legacy assignee
--    cannot be handed a vehicle at all.
--
-- The walk below mirrors TWO ratified conditions, and nothing else:
--
--  * LIVENESS (§5.1, AZ-9/AZ-25, review bedc25f3 B5): chainAlive(p) is
--    p.status='active' AND, if p is DELEGATED, p holds at least one live
--    credential AND chainAlive(parent). Accounts are keyless by design, so
--    the credential condition binds only delegated links. A dead chain can
--    never be given a vehicle — the assignment is unassigned instead. The
--    first cut checked identity SHAPE but not liveness, so a Connector
--    whose last credential had been revoked kept an invisible assignment.
--
--  * The own()-OBJECTS cap for the single case (resource_type='task',
--    action='read'): 'parent' passes; an explicit rule set must carry a
--    task rule whose verbs include one of read/write/admin
--    (grantAllows(verb,'read')) and whose selector covers this task.
--
-- Both are deliberately at least as strict as the production predicate —
-- being stricter only unassigns more, which is the fail-safe direction —
-- and a real-Postgres proof compares this decision against the PRODUCTION
-- predicate for a matrix of own() and liveness shapes.
--
-- Audit and feed emission reuse the RATIFIED action names: a vehicle IS
-- grants and profile assignments, so it audits as `grant.create` with
-- `automatic: true` metadata and emits the same content-free
-- `<type>.acl_changed` feed event GrantService emits (RH-P3.C1: an ACL
-- change over a feed object is itself a feed event). No new action string
-- and no new event name is introduced anywhere.

DO $$
DECLARE
  row_rec RECORD;
  ref_rec RECORD;
  link_rec RECORD;
  chain_broken BOOLEAN;
  root_id UUID;
  root_role TEXT;
  root_legacy BOOLEAN;
  assignee_legacy BOOLEAN;
  grant_id UUID;
  created_flag BOOLEAN;
  unassigned_count INTEGER := 0;
  vehicled_count INTEGER := 0;
  skipped_count INTEGER := 0;
BEGIN
  FOR row_rec IN
    SELECT t.id AS task_id, s.principal_id AS assignee_id
      FROM tasks t
      JOIN services s ON s.id = t.execution_service_id
     WHERE t.execution_service_id IS NOT NULL
       AND s.principal_id IS NOT NULL
     ORDER BY t.id
  LOOP
    chain_broken := FALSE;
    root_id := NULL;
    root_role := NULL;
    root_legacy := FALSE;
    assignee_legacy := FALSE;

    SELECT coalesce(p.legacy_identity, FALSE) INTO assignee_legacy
      FROM principals p WHERE p.id = row_rec.assignee_id;

    -- Walk the chain (depth <= 3 by ratified constraint) checking each
    -- DELEGATED link's own()-objects cap for (task, read) and finding the
    -- Account root.
    FOR link_rec IN
      WITH RECURSIVE chain AS (
        SELECT p.*, 0 AS depth FROM principals p WHERE p.id = row_rec.assignee_id
        UNION ALL
        SELECT parent.*, chain.depth + 1
          FROM principals parent
          JOIN chain ON parent.id = chain.parent_principal_id
         WHERE chain.depth < 4
      )
      SELECT * FROM chain ORDER BY depth ASC
    LOOP
      -- §5.1 liveness, every link: a non-active principal anywhere in the
      -- chain fails it closed.
      IF link_rec.status <> 'active' AND NOT coalesce(link_rec.legacy_identity, FALSE) THEN
        chain_broken := TRUE;
      END IF;

      IF link_rec.parent_principal_id IS NULL THEN
        root_id := link_rec.id;
        root_role := lower(coalesce(link_rec.role, ''));
        root_legacy := coalesce(link_rec.legacy_identity, FALSE);
      ELSIF NOT coalesce(link_rec.legacy_identity, FALSE) THEN
        -- §5.1: a DELEGATED link holding no live credential kills the
        -- chain. Accounts are keyless and exempt.
        IF NOT EXISTS (
          SELECT 1 FROM principal_credentials c
           WHERE c.principal_id = link_rec.id
             AND c.revoked_at IS NULL
             AND (c.expires_at IS NULL OR c.expires_at > NOW())
             AND (c.grace_until IS NULL OR c.grace_until > NOW())
        ) THEN
          chain_broken := TRUE;
        END IF;
        -- Inheritance is never implicit (AZ-24): no expression, no authority.
        IF link_rec.own_expression IS NULL THEN
          chain_broken := TRUE;
        ELSIF link_rec.own_expression -> 'objects' <> '"parent"'::jsonb THEN
          IF NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements(link_rec.own_expression -> 'objects') AS rule
             WHERE rule ->> 'resourceType' = 'task'
               AND EXISTS (
                 SELECT 1 FROM jsonb_array_elements_text(rule -> 'verbs') AS v(value)
                  WHERE v.value IN ('read', 'write', 'admin'))
               AND (
                 rule ->> 'selectorForm' = 'all-of-type'
                 OR (rule ->> 'selectorForm' = 'exact'
                     AND (rule -> 'selectorIds') @> to_jsonb(row_rec.task_id::text))
                 OR (rule ->> 'selectorForm' = 'all-except'
                     AND NOT ((rule -> 'selectorIds') @> to_jsonb(row_rec.task_id::text))))
          ) THEN
            chain_broken := TRUE;
          END IF;
        END IF;
      END IF;
    END LOOP;

    IF chain_broken OR root_id IS NULL OR assignee_legacy OR root_legacy THEN
      -- No vehicle is possible. R4 fail-safe direction: unassign.
      UPDATE tasks
         SET execution_service_id = NULL,
             execution_profile = NULL,
             execution_descriptor_version = NULL,
             execution_warrant_id = NULL
       WHERE id = row_rec.task_id;
      INSERT INTO audit_events (action, actor_handle, auth_method, outcome, resource_type, resource_id, metadata)
      VALUES ('task.execution_unassign', 'system', 'system', 'success', 'task', row_rec.task_id::text,
              jsonb_build_object(
                'automatic', TRUE,
                'reason', 'AZ-S7 backfill: the assignee chain is dead or can be given neither a grant nor a profile assignment, so the assignment could never be visible (ruling 7440b579 R1/R4/R6)',
                'assigneePrincipalId', row_rec.assignee_id,
                'migration', '099_assignment_access_vehicles.sql'));
      unassigned_count := unassigned_count + 1;
      RAISE NOTICE 'AZ-S7 backfill: task % UNASSIGNED — no vehicle possible for assignee %',
        row_rec.task_id, row_rec.assignee_id;
      CONTINUE;
    END IF;

    IF root_role IN ('admin', 'orchestrator') THEN
      -- §5.1 makes the Account side board-wide TRUE for these roles, so the
      -- grants below are currently redundant. They are materialized anyway:
      -- R6 says EVERY currently-assigned task receives its vehicle, the
      -- service path materializes unconditionally for the same reason, and
      -- a vehicle that exists only while a role happens to be elevated is
      -- not the durable invariant R1 asks for.
      skipped_count := skipped_count + 1;
    END IF;

    -- Materialize the D5 read set on the chain root Account: the task
    -- itself, its ONE-HOP dependency parents, its linked reports and its
    -- referenced skills. READ verb only, no transitive closure.
    FOR ref_rec IN
      SELECT 'task'::text AS resource_type, row_rec.task_id AS resource_id
      UNION
      SELECT 'task', d.depends_on_task_id FROM task_dependencies d WHERE d.task_id = row_rec.task_id
      UNION
      SELECT 'report', r.id FROM reports r WHERE row_rec.task_id = ANY(r.task_ids)
      UNION
      SELECT 'report', tr.target_id FROM task_references tr
       WHERE tr.task_id = row_rec.task_id AND tr.kind = 'report' AND tr.target_id IS NOT NULL
      UNION
      SELECT 'skill', tr.target_id FROM task_references tr
       WHERE tr.task_id = row_rec.task_id AND tr.kind = 'skill' AND tr.target_id IS NOT NULL
    LOOP
      IF ref_rec.resource_id IS NULL THEN CONTINUE; END IF;

      grant_id := NULL;
      SELECT g.id INTO grant_id
        FROM grants g
       WHERE g.grantee_type = 'principal' AND g.grantee_id = root_id
         AND g.resource_type = ref_rec.resource_type AND g.resource_id = ref_rec.resource_id
         AND g.verb = 'read';

      IF grant_id IS NULL THEN
        INSERT INTO grants (grantee_type, grantee_id, resource_type, resource_id, verb, granted_by_principal_id, provenance)
        VALUES ('principal', root_id, ref_rec.resource_type, ref_rec.resource_id, 'read', NULL, 'assignment:grant')
        RETURNING id INTO grant_id;
        created_flag := TRUE;

        INSERT INTO audit_events (action, actor_handle, auth_method, outcome, resource_type, resource_id, metadata)
        VALUES ('grant.create', 'system', 'system', 'success', 'grant', grant_id::text,
                jsonb_build_object(
                  'automatic', TRUE,
                  'granteeId', root_id,
                  'resourceType', ref_rec.resource_type,
                  'resourceId', ref_rec.resource_id,
                  'verb', 'read',
                  'provenance', 'assignment:grant',
                  'taskId', row_rec.task_id,
                  'migration', '099_assignment_access_vehicles.sql'));

        -- RH-P3.C1: an ACL change over a feed object is itself a feed
        -- event. Content-free by constraint; the same shape GrantService
        -- emits, including the recorded grantee so the entitled party can
        -- reach the transition event.
        PERFORM pg_advisory_xact_lock(hashtext('feed_events'));
        INSERT INTO feed_events (name, object_type, object_id, actor_principal_id, actor_handle, owner_principal_id, payload)
        VALUES (ref_rec.resource_type || '.acl_changed', ref_rec.resource_type, ref_rec.resource_id,
                NULL, 'system', root_id, '{}'::jsonb);
      ELSE
        -- An owner-plane row already covers this: link it, never adopt it.
        created_flag := FALSE;
      END IF;

      INSERT INTO access_vehicle_links (
        task_id, assignee_principal_id, landed_on_principal_id, vehicle_kind,
        warrant_id, target_kind, target_id, created_by_vehicle, created_by_principal_id)
      VALUES (row_rec.task_id, row_rec.assignee_id, root_id, 'auto-grant',
              NULL, 'grant', grant_id, created_flag, NULL)
      ON CONFLICT (task_id, target_kind, target_id) DO NOTHING;
    END LOOP;

    vehicled_count := vehicled_count + 1;
  END LOOP;

  RAISE NOTICE 'AZ-S7 backfill complete: % vehicled (% of them under an administrator chain root, where the vehicle is currently redundant), % unassigned.',
    vehicled_count, skipped_count, unassigned_count;
END $$;
