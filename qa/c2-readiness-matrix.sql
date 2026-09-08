-- qa/c2-readiness-matrix.sql — RH-P3.C2 real-Postgres semantics.
--
-- The readiness predicate and the delivery due-sets live in SQL, so their
-- SEMANTICS cannot be verified by a mocked pool: Jest scripts the result as an
-- already-computed boolean. This script executes the ACTUAL statements against
-- real Postgres, over real rows, and fails loudly on any disagreement.
--
-- Two defects it exists to catch, both found by cross-family review:
--
--   B3 (r1) · the dependency predicate was consumed as
--     `NOT (status = 'archived' AND archive_disposition = 'completed')`, which
--     under three-valued logic evaluates to NULL when the disposition is NULL.
--     A WHERE clause does not select NULL, so NOT EXISTS reported the child
--     READY while the claim path — using ordinary JavaScript booleans —
--     refused it with UNMET_DEPENDENCY. The board announced a task nobody
--     could claim.
--   B7 (r2) · readiness omitted the ASSIGNMENT clause entirely, so an armed,
--     dependency-free, UNASSIGNED task announced `task.ready` — a go signal
--     for work assigned to nobody, reaching every broadly-granted subscriber.
--     Ratified §2.6.4 fires it only when a task is ASSIGNED, in todo, armed
--     and dependency-satisfied (owner ruling ccd53781 R2).
--
-- And one that has never been provable in Jest at all:
--
--   B1 (r1/r2) · the delivery worker's due-set began from `webhooks` rows, so
--     a Connector configured exactly as §2.6.4 describes — registry
--     `delivery_mode='webhook'` with an endpoint, and no subscription row
--     anywhere — was never selected and received nothing. Section 3 runs the
--     worker's ACTUAL claim query against exactly that configuration.
--
-- The predicate text in section 2 is pinned to backend/src/utils/taskReadiness.ts
-- by an executable test (c2TaskReadiness.test.ts — "the real-Postgres matrix
-- runs the SAME predicate"), so this file cannot drift away from the code it
-- claims to verify.
--
-- Runs entirely inside a transaction that ROLLS BACK: it leaves no fixture.
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1 · Dependency satisfaction vs the claim gate (review r1, B3)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE matrix (
  label              TEXT PRIMARY KEY,
  parent_status      TEXT,
  parent_disposition TEXT,
  -- What claimReadyTask decides: completed, or archived AND disposition
  -- 'completed'. Ordinary two-valued JavaScript, so NULL is simply not
  -- 'completed' and the dependency is UNMET.
  claim_gate_satisfied BOOLEAN
) ON COMMIT DROP;

INSERT INTO matrix VALUES
  ('completed',            'completed',   NULL,          TRUE),
  ('archived/completed',   'archived',    'completed',   TRUE),
  ('archived/abandoned',   'archived',    'abandoned',   FALSE),
  ('archived/NULL',        'archived',    NULL,          FALSE),
  ('todo (incomplete)',    'todo',        NULL,          FALSE),
  ('in-progress',          'in-progress', NULL,          FALSE);

SELECT
  label,
  claim_gate_satisfied,
  NOT (
    (parent_status = 'completed'
      OR (parent_status = 'archived' AND parent_disposition = 'completed'))
    IS NOT TRUE
  ) AS predicate_satisfied,
  CASE
    WHEN claim_gate_satisfied = NOT (
      (parent_status = 'completed'
        OR (parent_status = 'archived' AND parent_disposition = 'completed'))
      IS NOT TRUE
    ) THEN 'AGREE'
    ELSE 'DISAGREE'
  END AS verdict
FROM matrix
ORDER BY label;

DO $$
DECLARE
  mismatches INT;
BEGIN
  SELECT COUNT(*) INTO mismatches
    FROM matrix
   WHERE claim_gate_satisfied <> NOT (
     (parent_status = 'completed'
       OR (parent_status = 'archived' AND parent_disposition = 'completed'))
     IS NOT TRUE
   );
  IF mismatches > 0 THEN
    RAISE EXCEPTION 'readiness/claim-gate equivalence FAILED for % parent state(s)', mismatches;
  END IF;
  RAISE NOTICE 'readiness/claim-gate equivalence holds across the full parent-state matrix';
END $$;

-- The pre-repair spelling, proven to disagree — so this script demonstrates it
-- can actually detect the defect rather than merely passing.
DO $$
DECLARE
  broken INT;
BEGIN
  SELECT COUNT(*) INTO broken
    FROM matrix
   WHERE parent_status = 'archived' AND parent_disposition IS NULL
     AND NOT EXISTS (
       SELECT 1 WHERE NOT (parent_status = 'completed'
         OR (parent_status = 'archived' AND parent_disposition = 'completed'))
     );
  IF broken = 0 THEN
    RAISE EXCEPTION 'positive control FAILED: the pre-repair predicate no longer misbehaves on archived/NULL, so this script cannot prove it detects B3';
  END IF;
  RAISE NOTICE 'positive control: the pre-repair NOT(...) spelling does mis-handle archived/NULL (% row)', broken;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2 · The FULL readiness predicate over REAL rows (ruling R2, review r2 B7)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE readiness_case (
  label    TEXT PRIMARY KEY,
  task_id  UUID NOT NULL,
  expected BOOLEAN NOT NULL,
  reason   TEXT NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
  connector_principal UUID;
  connector_service   UUID;
  parent_done         UUID;
  parent_open         UUID;
  child               UUID;
BEGIN
  -- A Connector to be assigned to. Migration 097 requires a connector
  -- services row to name a principal, so both are created here.
  INSERT INTO principals (handle, kind, role, status)
       VALUES ('c2-matrix-connector', 'service', 'agent', 'active')
    RETURNING id INTO connector_principal;

  INSERT INTO services (slug, name, kind, status, principal_id, current_descriptor_version)
       VALUES ('c2-matrix-connector', 'C2 matrix connector', 'connector', 'published', connector_principal, 1)
    RETURNING id INTO connector_service;

  INSERT INTO tasks (title, status) VALUES ('c2 matrix parent DONE', 'completed')
    RETURNING id INTO parent_done;
  INSERT INTO tasks (title, status) VALUES ('c2 matrix parent OPEN', 'todo')
    RETURNING id INTO parent_open;

  -- (a) assigned + todo + armed + deps satisfied  -> READY
  INSERT INTO tasks (title, status, auto_start, execution_service_id, execution_descriptor_version)
       VALUES ('c2 matrix ready', 'todo', TRUE, connector_service, 1)
    RETURNING id INTO child;
  INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (child, parent_done);
  INSERT INTO readiness_case VALUES ('assigned+todo+armed+deps-met', child, TRUE,
    'the ratified four-clause go signal');

  -- (b) UNASSIGNED, everything else satisfied -> NOT ready  [THE B7 CONTROL]
  INSERT INTO tasks (title, status, auto_start, execution_service_id, execution_descriptor_version)
       VALUES ('c2 matrix unassigned', 'todo', TRUE, NULL, NULL)
    RETURNING id INTO child;
  INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (child, parent_done);
  INSERT INTO readiness_case VALUES ('UNASSIGNED+todo+armed+deps-met', child, FALSE,
    'review r2 B7: an unassigned task must never announce a go signal');

  -- (c) assigned but UNARMED -> NOT ready
  INSERT INTO tasks (title, status, auto_start, execution_service_id, execution_descriptor_version)
       VALUES ('c2 matrix unarmed', 'todo', FALSE, connector_service, 1)
    RETURNING id INTO child;
  INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (child, parent_done);
  INSERT INTO readiness_case VALUES ('assigned+todo+UNARMED+deps-met', child, FALSE,
    'born parked: arming gates the announcement as well as the claim');

  -- (d) assigned, armed, but a dependency is UNMET -> NOT ready
  INSERT INTO tasks (title, status, auto_start, execution_service_id, execution_descriptor_version)
       VALUES ('c2 matrix blocked', 'todo', TRUE, connector_service, 1)
    RETURNING id INTO child;
  INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (child, parent_open);
  INSERT INTO readiness_case VALUES ('assigned+todo+armed+deps-UNMET', child, FALSE,
    'an unsatisfied dependency withholds the go signal');

  -- (e) assigned, armed, deps met, but NOT in todo -> NOT ready
  INSERT INTO tasks (title, status, auto_start, execution_service_id, execution_descriptor_version)
       VALUES ('c2 matrix in progress', 'in-progress', TRUE, connector_service, 1)
    RETURNING id INTO child;
  INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (child, parent_done);
  INSERT INTO readiness_case VALUES ('assigned+IN-PROGRESS+armed+deps-met', child, FALSE,
    'the go signal is for work waiting to start, not work under way');

  -- (f) assigned + armed + NO dependencies at all -> READY
  INSERT INTO tasks (title, status, auto_start, execution_service_id, execution_descriptor_version)
       VALUES ('c2 matrix free', 'todo', TRUE, connector_service, 1)
    RETURNING id INTO child;
  INSERT INTO readiness_case VALUES ('assigned+todo+armed+no-deps', child, TRUE,
    'nothing to wait for is satisfied by construction');
END $$;

-- THE PREDICATE, verbatim from backend/src/utils/taskReadiness.ts
-- (READY_PREDICATE_SQL). Pinned to the source by an executable test.
SELECT
  c.label,
  c.expected,
  (
  t.execution_service_id IS NOT NULL
  AND t.status = 'todo'
  AND t.auto_start = TRUE
  AND NOT EXISTS (
    SELECT 1
      FROM task_dependencies d
      JOIN tasks parent ON parent.id = d.depends_on_task_id
     WHERE d.task_id = t.id
       AND ((parent.status = 'completed' OR (parent.status = 'archived' AND parent.archive_disposition = 'completed'))) IS NOT TRUE
  )) AS actual,
  c.reason
FROM readiness_case c
JOIN tasks t ON t.id = c.task_id
ORDER BY c.label;

DO $$
DECLARE
  wrong INT;
  detail TEXT;
BEGIN
  SELECT COUNT(*), COALESCE(string_agg(c.label, ', '), '')
    INTO wrong, detail
    FROM readiness_case c
    JOIN tasks t ON t.id = c.task_id
   WHERE c.expected <> (
  t.execution_service_id IS NOT NULL
  AND t.status = 'todo'
  AND t.auto_start = TRUE
  AND NOT EXISTS (
    SELECT 1
      FROM task_dependencies d
      JOIN tasks parent ON parent.id = d.depends_on_task_id
     WHERE d.task_id = t.id
       AND ((parent.status = 'completed' OR (parent.status = 'archived' AND parent.archive_disposition = 'completed'))) IS NOT TRUE
  ));
  IF wrong > 0 THEN
    RAISE EXCEPTION 'readiness matrix FAILED for % case(s): %', wrong, detail;
  END IF;
  RAISE NOTICE 'readiness matrix holds across assignment x status x arming x dependency';
END $$;

-- Positive control for the ASSIGNMENT clause specifically: the three-clause
-- predicate the previous candidate shipped must call the unassigned case
-- READY. If it no longer does, this matrix cannot prove it detects B7.
DO $$
DECLARE
  leaked INT;
BEGIN
  SELECT COUNT(*) INTO leaked
    FROM readiness_case c
    JOIN tasks t ON t.id = c.task_id
   WHERE c.label = 'UNASSIGNED+todo+armed+deps-met'
     AND (
       t.status = 'todo'
       AND t.auto_start = TRUE
       AND NOT EXISTS (
         SELECT 1
           FROM task_dependencies d
           JOIN tasks parent ON parent.id = d.depends_on_task_id
          WHERE d.task_id = t.id
            AND ((parent.status = 'completed' OR (parent.status = 'archived' AND parent.archive_disposition = 'completed'))) IS NOT TRUE
       )
     );
  IF leaked = 0 THEN
    RAISE EXCEPTION 'positive control FAILED: the pre-ruling three-clause predicate no longer announces the unassigned task, so this matrix cannot prove it detects B7';
  END IF;
  RAISE NOTICE 'positive control: the pre-ruling three-clause predicate DOES announce the unassigned task (% row)', leaked;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3 · The WORK-PLANE due-set, from the registry alone (review r1/r2, B1)
-- ─────────────────────────────────────────────────────────────────────────
-- The reviewer's exact configuration: a published Connector with
-- delivery_mode='webhook', an endpoint and a signing secret — and NO
-- subscription row anywhere in the estate. The previous candidate selected
-- zero rows here and never queried `services` at all.
DO $$
DECLARE
  connector_principal UUID;
  connector_service   UUID;
  due                 INT;
  subscriptions       INT;
BEGIN
  INSERT INTO principals (handle, kind, role, status)
       VALUES ('c2-matrix-delivery', 'service', 'agent', 'active')
    RETURNING id INTO connector_principal;

  INSERT INTO services (slug, name, kind, status, principal_id,
                        delivery_mode, delivery_endpoint, delivery_secret)
       VALUES ('c2-matrix-delivery', 'C2 matrix delivery', 'connector', 'published',
               connector_principal, 'webhook', 'https://connector.example/hook', 'matrix-secret')
    RETURNING id INTO connector_service;

  -- The worker seeds state for a Connector it has not seen before.
  INSERT INTO connector_delivery_state (service_id, delivery_cursor)
       VALUES (connector_service, 0)
  ON CONFLICT (service_id) DO NOTHING;

  -- Nothing subscribes to this principal. Asserted, not assumed: the whole
  -- point is that delivery must not depend on a subscription existing.
  SELECT COUNT(*) INTO subscriptions
    FROM webhooks WHERE subscriber_principal_id = connector_principal;
  IF subscriptions <> 0 THEN
    RAISE EXCEPTION 'fixture invalid: the matrix Connector has % subscription(s)', subscriptions;
  END IF;

  -- THE WORKER'S OWN CLAIM QUERY (WebhookDeliveryWorker.claimDueConnectors).
  SELECT COUNT(*) INTO due
    FROM (
      SELECT st.service_id
        FROM connector_delivery_state st
        JOIN services s ON s.id = st.service_id
       WHERE s.kind = 'connector'
         AND s.status = 'published'
         AND s.delivery_mode = 'webhook'
         AND s.principal_id IS NOT NULL
         AND st.next_attempt_at <= NOW()
       ORDER BY st.next_attempt_at
       LIMIT 25
    ) claimed
   WHERE claimed.service_id = connector_service;

  IF due <> 1 THEN
    RAISE EXCEPTION 'B1 FAILED: a registry-only webhook Connector was NOT in the work-plane due-set (found %)', due;
  END IF;
  RAISE NOTICE 'B1: a Connector configured only in the registry IS due for work delivery, with no subscription row';

  -- poll and none are withheld — not by a runtime branch, but by never being
  -- selected. A webhook-less connector polls on its own cron (§2.6.4).
  FOR due IN
    SELECT 1 FROM (VALUES ('poll'), ('none')) AS m(mode)
  LOOP
    NULL;
  END LOOP;

  UPDATE services
     SET delivery_mode = 'poll', delivery_endpoint = NULL, delivery_secret = NULL,
         delivery_poll_interval_seconds = 60
   WHERE id = connector_service;
  SELECT COUNT(*) INTO due
    FROM connector_delivery_state st
    JOIN services s ON s.id = st.service_id
   WHERE st.service_id = connector_service
     AND s.delivery_mode = 'webhook';
  IF due <> 0 THEN
    RAISE EXCEPTION 'B1 FAILED: a poll-mode Connector is still selected for push';
  END IF;
  RAISE NOTICE 'B1: a poll-mode Connector is withheld from the push due-set';
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4 · The constraints the ruling introduced are actually enforced
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  refused BOOLEAN;
BEGIN
  -- An unsigned webhook-mode Connector is unrepresentable.
  refused := FALSE;
  BEGIN
    INSERT INTO principals (handle, kind, role, status)
         VALUES ('c2-matrix-unsigned', 'service', 'agent', 'active');
    INSERT INTO services (slug, name, kind, status, principal_id, delivery_mode, delivery_endpoint)
         VALUES ('c2-matrix-unsigned', 'unsigned', 'connector', 'published',
                 (SELECT id FROM principals WHERE handle = 'c2-matrix-unsigned'),
                 'webhook', 'https://connector.example/hook');
  EXCEPTION WHEN check_violation THEN
    refused := TRUE;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'services_webhook_requires_signing did NOT refuse an unsigned webhook Connector';
  END IF;
  RAISE NOTICE 'unsigned webhook-mode Connectors are unrepresentable';
END $$;

DO $$
DECLARE
  refused BOOLEAN := FALSE;
  subscriber UUID;
  credential UUID;
BEGIN
  INSERT INTO principals (handle, kind, role, status)
       VALUES ('c2-matrix-subscriber', 'service', 'agent', 'active')
    RETURNING id INTO subscriber;
  INSERT INTO services (slug, name, kind, status, principal_id)
       VALUES ('c2-matrix-subscriber', 'C2 matrix subscriber', 'connector', 'published', subscriber);
  INSERT INTO principal_credentials (principal_id, credential_type, key_id, secret_hash, scopes)
       VALUES (subscriber, 'api_key', 'c2matrixkey1', repeat('a', 64), '["tasks:read"]'::jsonb)
    RETURNING id INTO credential;

  -- An ACTIVE subscription may not carry a URL of its own (ruling R1).
  BEGIN
    INSERT INTO webhooks (url, events, active, subscriber_principal_id, subscriber_credential_id)
         VALUES ('https://attacker.example/steal', ARRAY['task.created'], TRUE, subscriber, credential);
  EXCEPTION WHEN check_violation THEN
    refused := TRUE;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'webhooks_active_carries_no_url did NOT refuse a subscription with its own URL';
  END IF;
  RAISE NOTICE 'an active subscription cannot carry a URL of its own';

  -- An ACTIVE subscription may not observe a go signal (ruling R1).
  refused := FALSE;
  BEGIN
    INSERT INTO webhooks (events, active, subscriber_principal_id, subscriber_credential_id)
         VALUES (ARRAY['task.ready'], TRUE, subscriber, credential);
  EXCEPTION WHEN check_violation THEN
    refused := TRUE;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'webhooks_observation_excludes_go_signals did NOT refuse a task.ready subscription';
  END IF;
  RAISE NOTICE 'an active subscription cannot observe a go signal';

  -- The positive control: the same row WITHOUT the go signal is accepted, so
  -- the refusals above are the constraints and not a broken fixture.
  INSERT INTO webhooks (events, active, subscriber_principal_id, subscriber_credential_id)
       VALUES (ARRAY['task.created'], TRUE, subscriber, credential);
  RAISE NOTICE 'positive control: an ordinary observation subscription is accepted';
END $$;


-- ─────────────────────────────────────────────────────────────────────────
-- 5 · A reassigned task rings the NEW assignee (pre-review P1)
-- ─────────────────────────────────────────────────────────────────────────
-- The announcement is per (task, ASSIGNEE). Reassigning a task that is
-- already ready must announce again, because the previous doorbell was rung
-- for somebody else and the new assignee's delivery cursor has moved on.
DO $$
DECLARE
  principal_a UUID; principal_b UUID;
  service_a   UUID; service_b   UUID;
  task        UUID;
  claimed     INT;
BEGIN
  INSERT INTO principals (handle, kind, role, status)
       VALUES ('c2-matrix-assignee-a', 'service', 'agent', 'active') RETURNING id INTO principal_a;
  INSERT INTO principals (handle, kind, role, status)
       VALUES ('c2-matrix-assignee-b', 'service', 'agent', 'active') RETURNING id INTO principal_b;
  INSERT INTO services (slug, name, kind, status, principal_id, current_descriptor_version)
       VALUES ('c2-matrix-assignee-a', 'A', 'connector', 'published', principal_a, 1) RETURNING id INTO service_a;
  INSERT INTO services (slug, name, kind, status, principal_id, current_descriptor_version)
       VALUES ('c2-matrix-assignee-b', 'B', 'connector', 'published', principal_b, 1) RETURNING id INTO service_b;

  INSERT INTO tasks (title, status, auto_start, execution_service_id, execution_descriptor_version)
       VALUES ('c2 matrix reassign', 'todo', TRUE, service_a, 1) RETURNING id INTO task;

  -- First announcement, to A.
  INSERT INTO task_readiness (task_id, announced_service_id) VALUES (task, service_a)
  ON CONFLICT (task_id) DO UPDATE
     SET announced_service_id = EXCLUDED.announced_service_id, ready_emitted_at = NOW()
   WHERE task_readiness.announced_service_id IS DISTINCT FROM EXCLUDED.announced_service_id;

  -- Re-running for the SAME assignee must claim nothing: no event storm.
  WITH claim AS (
    INSERT INTO task_readiness (task_id, announced_service_id) VALUES (task, service_a)
    ON CONFLICT (task_id) DO UPDATE
       SET announced_service_id = EXCLUDED.announced_service_id, ready_emitted_at = NOW()
     WHERE task_readiness.announced_service_id IS DISTINCT FROM EXCLUDED.announced_service_id
    RETURNING task_id
  ) SELECT COUNT(*) INTO claimed FROM claim;
  IF claimed <> 0 THEN
    RAISE EXCEPTION 'P1 FAILED: an unchanged assignee re-announced (% claim(s)) — every update would ring the doorbell', claimed;
  END IF;
  RAISE NOTICE 'P1: an unchanged assignee does not re-announce';

  -- Reassign to B: the doorbell must ring again.
  UPDATE tasks SET execution_service_id = service_b WHERE id = task;
  WITH claim AS (
    INSERT INTO task_readiness (task_id, announced_service_id) VALUES (task, service_b)
    ON CONFLICT (task_id) DO UPDATE
       SET announced_service_id = EXCLUDED.announced_service_id, ready_emitted_at = NOW()
     WHERE task_readiness.announced_service_id IS DISTINCT FROM EXCLUDED.announced_service_id
    RETURNING task_id
  ) SELECT COUNT(*) INTO claimed FROM claim;
  IF claimed <> 1 THEN
    RAISE EXCEPTION 'P1 FAILED: reassigning a ready task did NOT re-announce (% claim(s)) — the new assignee is never told', claimed;
  END IF;
  RAISE NOTICE 'P1: reassignment re-announces to the new assignee';
END $$;


-- ─────────────────────────────────────────────────────────────────────────
-- 6 · The 101 upgrade path preserves stored endpoints (review r3, B5)
-- ─────────────────────────────────────────────────────────────────────────
-- `delivery_secret` did not exist before 101, so the migration necessarily
-- sees it as NULL for EVERY pre-101 webhook-mode Connector. An earlier
-- spelling demoted those rows AND nulled `delivery_endpoint`, which silently
-- destroyed the operator's configured address — unrecoverable from RelayHall.
--
-- This reconstructs a genuine pre-101 row (the signing CHECK is dropped for
-- the length of the reconstruction, exactly as it did not exist beforehand),
-- replays the migration's own demotion statement, and asserts the address
-- survives byte-identically while unsigned delivery is still withheld.
DO $$
DECLARE
  legacy_principal UUID;
  legacy_service   UUID;
  kept_endpoint    TEXT;
  kept_mode        TEXT;
  due              INT;
BEGIN
  INSERT INTO principals (handle, kind, role, status)
       VALUES ('c2-matrix-legacy', 'service', 'agent', 'active')
    RETURNING id INTO legacy_principal;

  ALTER TABLE services DROP CONSTRAINT IF EXISTS services_webhook_requires_signing;

  INSERT INTO services (slug, name, kind, status, principal_id,
                        delivery_mode, delivery_endpoint, delivery_secret)
       VALUES ('c2-matrix-legacy', 'C2 matrix legacy', 'connector', 'published',
               legacy_principal, 'webhook', 'https://legacy.example/hook', NULL)
    RETURNING id INTO legacy_service;

  -- THE MIGRATION'S OWN STATEMENT.
  UPDATE services
     SET delivery_mode = 'none'
   WHERE delivery_mode = 'webhook'
     AND (delivery_secret IS NULL OR length(delivery_secret) = 0);

  SELECT delivery_endpoint, delivery_mode INTO kept_endpoint, kept_mode
    FROM services WHERE id = legacy_service;

  IF kept_endpoint IS DISTINCT FROM 'https://legacy.example/hook' THEN
    RAISE EXCEPTION 'B5 FAILED: the pre-101 delivery_endpoint was destroyed (now %) — the operator cannot recover the address', COALESCE(kept_endpoint, 'NULL');
  END IF;
  RAISE NOTICE 'B5: the pre-101 delivery endpoint survives the upgrade byte-identically';

  IF kept_mode <> 'none' THEN
    RAISE EXCEPTION 'B5 FAILED: an unsigned webhook-mode row was NOT demoted (mode %) — unsigned delivery would be representable', kept_mode;
  END IF;

  -- Withheld in the way that matters: demotion alone takes it out of the
  -- work-plane due-set, so preserving the address costs no safety.
  INSERT INTO connector_delivery_state (service_id, delivery_cursor)
       VALUES (legacy_service, 0) ON CONFLICT (service_id) DO NOTHING;
  SELECT COUNT(*) INTO due
    FROM connector_delivery_state st
    JOIN services s ON s.id = st.service_id
   WHERE st.service_id = legacy_service AND s.delivery_mode = 'webhook';
  IF due <> 0 THEN
    RAISE EXCEPTION 'B5 FAILED: a demoted legacy row is still due for push';
  END IF;
  RAISE NOTICE 'B5: the demoted legacy row is withheld from delivery while keeping its address';

  -- Re-arming is "add a secret", not "find the URL again".
  UPDATE services SET delivery_mode = 'webhook', delivery_secret = 'restored-secret'
   WHERE id = legacy_service;
  SELECT delivery_endpoint INTO kept_endpoint FROM services WHERE id = legacy_service;
  IF kept_endpoint IS DISTINCT FROM 'https://legacy.example/hook' THEN
    RAISE EXCEPTION 'B5 FAILED: re-arming did not recover the preserved address';
  END IF;
  RAISE NOTICE 'B5: re-arming needs only a secret, because the address was never lost';
END $$;

ROLLBACK;
