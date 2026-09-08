-- 101: RH-P3.C2 — signed ID-only webhook subscriptions, delivery worker
-- substrate, task.ready readiness tracking, and born-parked at the schema
-- level.
--
-- Strategy §2.6.4 via analysis d8507677 §4 and runbook daf703a6 §5; AUTHZ
-- design 4d961e37 (§1 service registry / A17.8 subscription-class, §4 live
-- assignment evaluation); C1's feed_events ledger (091) is the delivery
-- source of record.
--
-- The webhooks table (044) is EXTENDED rather than replaced: it is already
-- the ratified subscription home — root-sentinel scoped (scopeMap) and
-- audited as subscription.create/update/delete — so a parallel table would
-- fork the anti-beacon plane for no gain.

-- ─────────────────────────────────────────────────────────────────────────
-- 1 · Subscriber identity: delivery is grant-scoped against THIS principal.
-- ─────────────────────────────────────────────────────────────────────────
-- A subscription delivers exactly what its subscriber could have PULLED.
-- The worker builds this principal's actor through the production derivation
-- (resolveChain -> effectiveScopes) and reads the feed through the ratified
-- shared predicate, so no authorization logic is duplicated here.
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS subscriber_principal_id UUID
  REFERENCES principals(id) ON DELETE RESTRICT;

COMMENT ON COLUMN webhooks.subscriber_principal_id IS
  'C2: the principal whose read authority scopes this subscription''s deliveries. Delivery is authorized exactly as this principal''s own feed read would be (FeedEventService.listSince), so a subscriber can never be pushed what it could not pull.';

-- ─────────────────────────────────────────────────────────────────────────
-- 1b · The CREDENTIAL the subscription delivers as (review r1, B2).
-- ─────────────────────────────────────────────────────────────────────────
-- Delivery authority must be derived from the SAME input a real request
-- carries. The first candidate substituted the principal's role maximum
-- (scopesForRole) for credential scopes, which WIDENS authority: the reviewer
-- reproduced a Connector whose only credential holds ['reports:read'] — 403 on
-- GET /events — still being delivered task IDs, because its role maximum
-- contains tasks:read. Role defaults may not stand in for credential scopes.
--
-- Binding the subscription to a credential makes the worker's derivation
-- identical to middleware/auth.ts by construction: credential.scopes ->
-- resolveChain -> effectiveScopes. It also means revoking or expiring that
-- credential stops delivery immediately, with no subscription edit.
--
-- Accounts hold no bearer credentials (design 4d961e37 A17.1) — they act
-- through login sessions, which a background worker must not synthesize — so
-- an Account cannot be a subscriber. The durable credential-bearing layer is
-- the Connector, and that is what a subscription names.
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS subscriber_credential_id UUID
  REFERENCES principal_credentials(id) ON DELETE RESTRICT;

COMMENT ON COLUMN webhooks.subscriber_credential_id IS
  'C2 (review r1 B2): the live credential whose scopes bound this subscription''s deliveries. The worker derives its actor from THIS credential exactly as the auth middleware does, so delivery authority can never exceed pull authority. Revoking or expiring the credential stops delivery on the next pass.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2 · Durable per-subscription feed cursor (the reconciliation contract).
-- ─────────────────────────────────────────────────────────────────────────
-- Advanced ONLY on delivery success, so delivery is at-least-once and a
-- dropped webhook is recovered by pulling GET /api/events?cursor=<cursor>.
-- The webhook is a HINT; the feed is the TRUTH.
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS delivery_cursor BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN webhooks.delivery_cursor IS
  'C2: the highest feed_events.cursor successfully delivered to this subscription. Advanced only after a 2xx, so a failed or dropped delivery is retried rather than skipped. Decimal BIGINT — the exact emitted cursor encoding. A NEW subscription is created at the current feed HEAD (routes/webhooks.ts): starting at 0 would replay the entire retained history at a brand-new endpoint. Replay is available by passing deliveryCursor explicitly.';

-- Existing rows predate the subscription contract and were deactivated above;
-- park their cursor at the head too, so re-activating one does not replay the
-- whole retained feed as a side effect of turning it back on.
UPDATE webhooks
   SET delivery_cursor = (SELECT COALESCE(MAX(cursor), 0) FROM feed_events)
 WHERE delivery_cursor = 0;

-- ─────────────────────────────────────────────────────────────────────────
-- 3 · Backoff bookkeeping (durable, so a restart does not reset a penalty).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ─────────────────────────────────────────────────────────────────────────
-- 4 · Loop guard: the per-subscriber rate limit lives HERE, not in process
--     memory — it must hold across every replica and survive restarts.
-- ─────────────────────────────────────────────────────────────────────────
-- The estate already carries three deferred cards filed against per-process
-- limiters (2b5ede8f, d22f4de2, 329dba46). This one is deployment-wide by
-- construction: the window is a row, and the claim is a conditional UPDATE.
-- The card contracts a per-SUBSCRIBER rate limit. Counters on the
-- subscription ROW gave each row its own budget, so two subscriptions for one
-- principal doubled the ceiling and N subscriptions raised it linearly
-- (review r1, B5). The window is therefore keyed by the subscriber principal.
--
-- Deployment-wide by construction: the window is a database row claimed by one
-- conditional statement, never a per-process counter — the failure mode behind
-- this estate's three deferred limiter cards (2b5ede8f, d22f4de2, 329dba46).
CREATE TABLE IF NOT EXISTS webhook_delivery_rate (
  subscriber_principal_id UUID PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deliveries INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE webhook_delivery_rate IS
  'C2 loop guard (review r1 B5): the per-SUBSCRIBER delivery window. Keyed by principal so every subscription that principal owns shares one budget — a per-row window let N subscriptions multiply the ceiling by N. Claimed by a single INSERT ... ON CONFLICT DO UPDATE ... WHERE, so it holds across replicas and restarts.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5 · Signing is mandatory, and an active subscription must name a subscriber.
-- ─────────────────────────────────────────────────────────────────────────
-- Legacy rows (044) may carry neither. They are DEACTIVATED rather than
-- silently issued a generated secret: a secret the subscriber has never seen
-- cannot be verified by it, so an auto-generated one would produce
-- deliveries that only LOOK signed. Deactivation is visible, reversible by
-- the root operator (set a secret + subscriber, re-activate), and audited on
-- the next mutation.
-- `secret <> ''` and not merely NOT NULL: an empty string is NOT NULL, so a
-- NULL-only CHECK leaves an ACTIVE subscription that can never sign and
-- therefore never deliver — the invariant would read as held while the
-- subscription was quietly bricked (pre-review F5).
UPDATE webhooks
   SET active = FALSE
 WHERE active
   AND (subscriber_principal_id IS NULL OR subscriber_credential_id IS NULL);

ALTER TABLE webhooks DROP CONSTRAINT IF EXISTS webhooks_active_requires_signing_and_subscriber;
ALTER TABLE webhooks ADD CONSTRAINT webhooks_active_requires_subscriber
  CHECK (NOT active OR (subscriber_principal_id IS NOT NULL
                        AND subscriber_credential_id IS NOT NULL));

COMMENT ON CONSTRAINT webhooks_active_requires_subscriber ON webhooks IS
  'C2 (ruling ccd53781 R1/R3): unattributed observation is not representable. An ACTIVE subscription must name a subscriber principal AND the credential its deliveries are authorized from. Signing is NOT checked here any more: under R1 the signing secret is registry data on the subscriber Connector alongside its endpoint (services.delivery_secret), because one endpoint receives one signature.';

-- The worker''s due-set scan.
CREATE INDEX IF NOT EXISTS ix_webhooks_due ON webhooks(next_attempt_at) WHERE active;

-- ─────────────────────────────────────────────────────────────────────────
-- 6 · task.ready: exactly-once emission per readiness transition.
-- ─────────────────────────────────────────────────────────────────────────
-- Readiness is DERIVED (status 'todo' AND armed AND every dependency
-- satisfied), never stored as a status. Only the ANNOUNCEMENT is recorded,
-- so re-entering the ready state announces again and staying in it does not.
--
-- This bookkeeping deliberately does NOT live on `tasks`. That table carries
-- `update_tasks_updated_at BEFORE UPDATE ... EXECUTE update_updated_at_column()`
-- (baseline schema), so ANY write to a task row bumps `updated_at` — and
-- `updated_at` is the claim path's optimistic-concurrency token
-- (TaskOrchestrationService.claimReadyTask compares it against the caller's
-- snapshot and refuses with STALE_TASK_SNAPSHOT). A readiness column on
-- `tasks` would therefore invalidate a claimant's snapshot every time the
-- board announced that the very task was ready to claim.
--
-- Presence of a row means "ready, and announced". Emission is an
-- INSERT ... ON CONFLICT DO NOTHING RETURNING, which is atomically
-- exactly-once even when two transactions evaluate readiness concurrently.
CREATE TABLE IF NOT EXISTS task_readiness (
  task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  ready_emitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE task_readiness IS
  'C2: emission bookkeeping for task.ready. A row means the current readiness transition has been announced TO THE RECORDED ASSIGNEE; it is deleted when the task leaves the ready state. Readiness is always derived from assignment + status + arming + dependency satisfaction — this table is never the truth of whether a task is ready. Kept off `tasks` because that table''s updated_at trigger would invalidate claim snapshots.';

-- Ruling ccd53781 R2 makes the go signal a doorbell for the SPECIFIC
-- assignee, so the announcement is per (task, assignee) and not merely per
-- task. Without this column a reassignment was swallowed by ON CONFLICT DO
-- NOTHING: the task was already "announced", so no new task.ready fired — and
-- the new assignee's own delivery cursor had usually moved past the original
-- event, leaving it permanently untold about work it now owns.
ALTER TABLE task_readiness ADD COLUMN IF NOT EXISTS announced_service_id UUID
  REFERENCES services(id) ON DELETE CASCADE;

COMMENT ON COLUMN task_readiness.announced_service_id IS
  'C2 (ruling ccd53781 R2): the assignee the current announcement was addressed to. A reassignment re-announces, because the doorbell belongs to the assignee and the previous one was rung for somebody else.';

-- ─────────────────────────────────────────────────────────────────────────
-- 7 · Born parked, at the schema level (arming enforcement, final arm).
-- ─────────────────────────────────────────────────────────────────────────
-- The application layer already resolves a missing autoStart to FALSE
-- (utils/taskLifecycle.ts resolveCreateAutoStart, TaskManagerDB.createTask,
-- routes/tasks.ts). The COLUMN default was still TRUE, so any insert path
-- that does not traverse the application layer — a migration, a fixture, a
-- direct SQL insert, a future service — was still born ARMED. This closes
-- that gap.
--
-- DEFAULT affects future inserts only: no existing task is disarmed by this
-- migration, and no armed task loses its arming.
ALTER TABLE tasks ALTER COLUMN auto_start SET DEFAULT FALSE;


-- ─────────────────────────────────────────────────────────────────────────
-- 8 · RULING ccd53781 — TWO PLANES, ONE ENDPOINT.
-- ─────────────────────────────────────────────────────────────────────────
-- The owner ruling of 2026-08-24 (report ccd53781) settles what the first cut
-- of this candidate got wrong. It does not amend strategy 4e40f06f; it
-- INTERPRETS §2.6.4 and §2.6.2 item 2, both of which stay true under it:
--
--   R1 · WORK DELIVERY is per-assignee and registry-driven, exactly per
--        §2.6.4: each Connector's registry descriptor (webhook | poll | none)
--        is the SINGLE SOURCE OF TRUTH for its endpoint and mode, and the
--        delivery worker dispatches PER ASSIGNEE. SUBSCRIPTIONS survive as
--        EVENT OBSERVATION ONLY: a subscription row carries event-class
--        filters and NO URL of its own; endpoint and mode are always read
--        from the subscriber's registry row at dispatch time. Observation
--        delivery never carries go-signal or claim semantics.
--   R2 · task.ready requires ASSIGNMENT (see section 11).
--   R3 · Subscribers are Connectors only.
--
-- The single-source rule is what the rest of this section implements.

-- 8a · A subscription no longer owns a URL.
-- The column is KEPT, not dropped: stored legacy bytes are held, reported and
-- never dropped (the house compatibility rule, stated at migration 077). The
-- pre-C2 rows above are already deactivated, so their URLs remain readable
-- history while no ACTIVE row can carry one. NOT NULL is relaxed because a
-- C2 subscription legitimately has nothing to put there.
ALTER TABLE webhooks ALTER COLUMN url DROP NOT NULL;

ALTER TABLE webhooks DROP CONSTRAINT IF EXISTS webhooks_active_carries_no_url;
ALTER TABLE webhooks ADD CONSTRAINT webhooks_active_carries_no_url
  CHECK (NOT active OR url IS NULL);

COMMENT ON COLUMN webhooks.url IS
  'RETIRED as a delivery target by ruling ccd53781 R1: endpoint and mode are read from the subscriber Connector''s registry row at dispatch time, never from here. Retained for the pre-C2 rows deactivated by this migration (the house rule that stored legacy bytes are never dropped); an ACTIVE subscription must leave it NULL.';

-- 8b · Observation is never a work-delivery path.
-- `task.ready` is the ONLY go signal (§2.6.4) and it belongs to the work
-- plane, addressed to the assignee. Letting a broadly-granted observer
-- subscribe to it would hand a go signal to a party the work was not assigned
-- to — precisely the premature-pickup failure arming exists to prevent. The
-- worker refuses it at dispatch as well; this CHECK makes the row
-- unrepresentable rather than merely unserved.
ALTER TABLE webhooks DROP CONSTRAINT IF EXISTS webhooks_observation_excludes_go_signals;
ALTER TABLE webhooks ADD CONSTRAINT webhooks_observation_excludes_go_signals
  CHECK (NOT active OR NOT ('task.ready' = ANY(events)));

COMMENT ON CONSTRAINT webhooks_observation_excludes_go_signals ON webhooks IS
  'C2 (ruling ccd53781 R1): the observation plane never carries go-signal semantics. task.ready is delivered per-assignee by the work plane and is not observable by subscription.';

UPDATE webhooks
   SET events = array_remove(events, 'task.ready')
 WHERE 'task.ready' = ANY(events);

-- ─────────────────────────────────────────────────────────────────────────
-- 9 · The registry carries the signing secret beside the endpoint.
-- ─────────────────────────────────────────────────────────────────────────
-- §2.6.4 already makes the endpoint and the mode switch SUBSCRIPTION-CLASS
-- data — settable only through the human surface or the admin credential
-- class, never via agent-plane `manage` on the service, because a
-- prompt-injected connector that could repoint its own delivery would
-- recreate the beacon §2.6.2 forbids. The signing secret is data of exactly
-- that class and is required by the same ratified sentence ("a registered
-- service may subscribe by SIGNED webhook"), so it lives here, behind the
-- same root-gated owner-plane subroute, and never on the agent plane.
--
-- One endpoint, one secret: both planes sign deliveries to a Connector with
-- this value, so a receiver verifies one signature on one URL instead of
-- demultiplexing per-subscription secrets arriving at the same address.
ALTER TABLE services ADD COLUMN IF NOT EXISTS delivery_secret TEXT;

COMMENT ON COLUMN services.delivery_secret IS
  'C2 (§2.6.4 + ruling ccd53781 R1): the HMAC-SHA256 signing secret for deliveries to this Connector''s delivery_endpoint. Subscription-class like the endpoint and the mode switch — owner-plane/root writes only, never agent-plane services:write. Mandatory whenever delivery_mode = webhook: unsigned delivery is not representable.';

-- A webhook-mode Connector must be both addressable and signable. Existing
-- webhook-mode rows without a secret are demoted to `none` rather than issued
-- a generated one: a secret the receiver has never seen cannot be verified by
-- it, so an auto-generated secret would produce deliveries that only LOOK
-- signed (the same reasoning that deactivates rather than re-secrets the
-- legacy subscriptions above).
--
-- The ENDPOINT IS PRESERVED (review r3, B5). An earlier spelling also set
-- `delivery_endpoint = NULL`, which silently destroyed operator data: the
-- address was configured before `delivery_secret` existed, so this migration
-- necessarily sees the secret as NULL for EVERY pre-101 webhook row, and the
-- operator could not recover the address from RelayHall afterwards. Silent
-- loss of stored data is in the review safety floor and is never waived.
-- Demoting the mode is sufficient to withhold unsigned delivery — the worker
-- selects on `delivery_mode = 'webhook'` — and the retained endpoint means
-- re-arming is "add a secret", not "find the URL again". A `none`-mode row
-- carrying an endpoint satisfies the signing CHECK below, which constrains
-- webhook-mode rows only.
UPDATE services
   SET delivery_mode = 'none'
 WHERE delivery_mode = 'webhook'
   AND (delivery_secret IS NULL OR length(delivery_secret) = 0);

ALTER TABLE services DROP CONSTRAINT IF EXISTS services_webhook_requires_signing;
ALTER TABLE services ADD CONSTRAINT services_webhook_requires_signing
  CHECK (delivery_mode <> 'webhook'
         OR (delivery_endpoint IS NOT NULL AND length(delivery_endpoint) > 0
             AND delivery_secret IS NOT NULL AND length(delivery_secret) > 0));

-- ─────────────────────────────────────────────────────────────────────────
-- 10 · Work-plane delivery state, per ASSIGNEE.
-- ─────────────────────────────────────────────────────────────────────────
-- The observation plane keeps its per-subscription cursor on `webhooks`. The
-- work plane has no subscription row by construction — its unit is the
-- assignee — so its cursor, backoff and last-delivery bookkeeping live here,
-- keyed by the Connector's registry row.
--
-- Deliberately a separate table rather than columns on `services`: `services`
-- is registration CONFIG whose every write bumps `revision` and `updated_at`
-- (the owner-plane concurrency token). Runtime delivery bookkeeping would
-- churn that token on every pass — the same reasoning that keeps
-- `task_readiness` off `tasks`, whose updated_at is the claim path's
-- optimistic-concurrency token.
CREATE TABLE IF NOT EXISTS connector_delivery_state (
  service_id UUID PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  delivery_cursor BIGINT NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_delivery_at TIMESTAMPTZ,
  last_delivery_status INTEGER,
  last_delivery_error TEXT
);

COMMENT ON TABLE connector_delivery_state IS
  'C2 (ruling ccd53781 R1): per-ASSIGNEE work-delivery bookkeeping — the feed cursor, backoff and last-delivery result for pushing task.ready doorbells to one Connector. The unit of work delivery is the assignee, not a subscription, so this is keyed by the Connector''s services row. Kept off `services` because that table''s revision/updated_at is the owner-plane concurrency token.';

COMMENT ON COLUMN connector_delivery_state.delivery_cursor IS
  'C2: the highest feed_events.cursor whose work-delivery window has been settled for this Connector. Advanced only after a 2xx (or an empty window), so a dropped doorbell is retried rather than skipped, and the Connector recovers by pulling GET /api/events?cursor=<cursor> — the webhook is a HINT, the feed is the TRUTH (§2.6.2 reconciliation doctrine). Decimal BIGINT: the exact emitted encoding.';

-- A Connector newly configured for webhook delivery starts at the feed HEAD,
-- never at 0: cursor 0 would replay the entire retained history as doorbells
-- at a brand-new endpoint. The worker seeds the row at head on first sight;
-- this backfill does the same for anything already configured.
INSERT INTO connector_delivery_state (service_id, delivery_cursor)
SELECT s.id, (SELECT COALESCE(MAX(cursor), 0) FROM feed_events)
  FROM services s
 WHERE s.kind = 'connector'
ON CONFLICT (service_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS ix_connector_delivery_due
  ON connector_delivery_state(next_attempt_at);

-- ─────────────────────────────────────────────────────────────────────────
-- 11 · task.ready requires ASSIGNMENT (ruling ccd53781 R2).
-- ─────────────────────────────────────────────────────────────────────────
-- Ratified §2.6.4: "The task.ready derived event is the only 'go' signal: it
-- fires when a task is ASSIGNED, in todo, armed, and dependency-satisfied."
-- The first cut derived readiness from status + arming + dependencies only,
-- so an armed unassigned task announced a go signal to every broadly-granted
-- subscriber (review r2, B7).
--
-- The ASSIGNMENT FIELD OF RECORD is `tasks.execution_service_id` (migration
-- 077, mirrored to task_execution_profiles.service_id by 086) — the
-- Connector-first execution profile naming the registered Service this task
-- targets. It is the only task-to-Connector link in the schema, and it is the
-- one the delivery worker resolves to a registry descriptor. Recorded here
-- because AUTHZ 4d961e37 §4's "assignment" is a different concept entirely —
-- ACCESS-PROFILE assignment (profile_id to a principal or group) — and
-- task_assignments (086) carries claimant/shepherd/verifier, of which
-- claimant is set at CLAIM time and therefore cannot gate a pre-claim go
-- signal. Owner decision D6 on run packet c17ebfff.
--
-- The predicate itself lives in backend/src/utils/taskReadiness.ts; this
-- index serves it, and the readiness bookkeeping above is unchanged.
CREATE INDEX IF NOT EXISTS ix_tasks_ready_assignment
  ON tasks(execution_service_id, status) WHERE execution_service_id IS NOT NULL;
