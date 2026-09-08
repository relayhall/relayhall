/**
 * WebhookDeliveryWorker — RH-P3.C2: TWO PLANES, ONE ENDPOINT.
 *
 * Owner ruling `ccd53781` (2026-08-24) settles the model this worker
 * implements. It interprets strategy 4e40f06f §2.6.4 and §2.6.2 item 2 —
 * amending neither — and both ratified sentences stay true under it:
 *
 *   R1 · WORK DELIVERY is PER-ASSIGNEE and registry-driven. Each Connector's
 *        registry descriptor (`webhook(url) | poll(interval) | none`) is the
 *        SINGLE SOURCE OF TRUTH for its endpoint and mode, and the worker
 *        dispatches per assignee. OBSERVATION survives as the §2.6
 *        triggers/watchdogs consumer: a subscription carries event-class
 *        filters and NO URL — endpoint and mode are read from the
 *        subscriber's registry row at dispatch time.
 *   R2 · `task.ready` requires ASSIGNMENT (utils/taskReadiness).
 *   R3 · Subscribers — and assignees — are Connectors.
 *
 * ── Why the previous cut was rejected, in one line ──
 *
 * It made the SUBSCRIPTION the unit of delivery, so a Connector configured
 * exactly as §2.6.4 describes (`delivery_mode='webhook'` + `delivery_endpoint`,
 * no subscription row) received nothing at all: every pass selected zero rows
 * and never queried `services` (review r2, B1). The due-set below now BEGINS
 * from the registry.
 *
 * ── The delivery guarantee (both planes) ──
 *
 * AT-LEAST-ONCE, in cursor order, per channel. The cursor moves only after a
 * 2xx, so a crash between POST and commit re-delivers rather than skips.
 * Receivers treat `cursor` as the idempotency key, and a dropped delivery is
 * recovered by pulling `GET /api/events?cursor=<cursor>` — the webhook is a
 * HINT, the feed is the TRUTH (§2.6.2 reconciliation doctrine).
 *
 * ── Replica safety ──
 *
 * Each due-set is claimed with `FOR UPDATE SKIP LOCKED` and the claimed rows'
 * `next_attempt_at` is pushed forward inside the same transaction, so two
 * replicas never work the same channel concurrently and a crashed pass
 * self-heals when the lease elapses.
 *
 * ── WHY AN ASSIGNED CONNECTOR CAN ALWAYS READ ITS OWN TASK ──
 *
 * Work delivery reads the feed THROUGH THE ASSIGNEE'S OWN ACTOR, so a
 * doorbell is only ever sent for a task the assignee could already pull. Push
 * authority never exceeds pull authority: the invariant this candidate must
 * not break, and the reason nothing here shortcuts the shared predicate.
 *
 * §2.6.4 also describes a service's effective visibility as "(its grants ∪
 * its CURRENT ASSIGNMENTS), capped by its registration's visibility tier",
 * while the ratified AUTHZ predicate (4d961e37 §1) enumerates no
 * service-assignment arm. An earlier cut of this file declared that gap a
 * limitation and deferred it to RH-P3.1 `743cf58b`; cross-family review r3
 * `840711d1` finding B1 refused that, correctly — a declared deferral does
 * not amend a ratified requirement — and raised it as an owner gate rather
 * than resolving it inside a delivery candidate.
 *
 * Owner ruling `7440b579` (2026-08-25; AUTHZ amendment AZ-A2, addendum AZ-A3
 * 2026-08-26) closed it from the other end, and the evaluator is still
 * UNCHANGED. R1: a task may not be assigned to a Connector unless the
 * assignment act SIMULTANEOUSLY ensures the assignee chain can read it
 * through the arms that already exist — a Warrant's published ceiling profile
 * carried by the live AZ-4 profile-assignment arm, or a server-materialized
 * auto-grant. `TaskManagerDB.attachExecutionVehicle()` is the choke point:
 * it runs in the SAME transaction as the write to `tasks.execution_service_id`,
 * and a refusal rolls the assignment back with it. The assigned-but-invisible
 * state is therefore UNREPRESENTABLE, and §2.6.4's union holds BY
 * CONSTRUCTION — "current assignments" contribute to effective visibility
 * because every assignment carries its access. R4 closes the loop in the
 * fail-safe direction: revoking the vehicle auto-unassigns, which silences
 * the doorbell (`ccd53781` R2).
 *
 * So this worker needs no assignment arm of its own and must not grow one.
 * What it owes instead is proof that the end state actually holds, on real
 * rows rather than by citation:
 * `backend/scripts/test-c2-b1-delivery-coupling.js` drives it against a
 * migrated PostgreSQL through the production services, the production
 * authorization predicate and this worker, with a positive control that fails
 * the script if it can no longer detect the defect B1 named.
 */
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { feedEventService, FeedEventService } from './FeedEventService';
import { subscriberActorService, SubscriberActorService } from './SubscriberActorService';
import { authorizationService } from './AuthorizationService';
import { requiredScopeFor } from '../utils/scopeMap';
import {
  webhookService, WebhookService, GO_SIGNAL_EVENTS,
  type WebhookSubscriptionRow, type DeliverableEvent, type DeliveryTarget,
} from './WebhookService';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { DELIVERY_MIRRORED_PATH } from '../utils/credentialAcceptance';

export interface DeliveryWorkerConfig {
  /** Seconds between passes. */
  intervalSeconds: number;
  /** Feed rows examined per channel per pass. */
  batchSize: number;
  /** Loop guard: max deliveries per subscriber principal per window. */
  rateLimitPerWindow: number;
  /** Loop guard: the window, in seconds. */
  rateWindowSeconds: number;
  /** Backoff base; the delay is base * 2^(failures-1), capped. */
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
  /** How long a claimed channel is leased to one pass. */
  claimLeaseSeconds: number;
  /** Subscriptions claimed per pass (observation plane). */
  maxSubscriptionsPerPass: number;
  /** Connectors claimed per pass (work plane). */
  maxConnectorsPerPass: number;
  /** Loop guard: max EVENTS per subscriber principal per window. */
  rateLimitEventsPerWindow: number;
}

export const DEFAULT_DELIVERY_CONFIG: DeliveryWorkerConfig = {
  intervalSeconds: 10,
  batchSize: 200,
  rateLimitPerWindow: 60,
  rateWindowSeconds: 60,
  backoffBaseSeconds: 15,
  backoffMaxSeconds: 3600,
  claimLeaseSeconds: 60,
  maxSubscriptionsPerPass: 25,
  maxConnectorsPerPass: 25,
  // A POST cap alone does not bound amplification: one POST carries up to
  // `batchSize` events, so 60 POSTs/minute is up to 12,000 events/minute.
  // The event cap is what actually bounds a self-driving subscriber.
  rateLimitEventsPerWindow: 600,
};

export interface PassResult {
  /** Work plane: Connectors claimed from the REGISTRY this pass. */
  connectorsExamined: number;
  workDeliveries: number;
  /** Observation plane. */
  subscriptionsExamined: number;
  observationDeliveries: number;
  /** Both planes. */
  deliveries: number;
  failures: number;
  rateLimited: number;
  refusedSubscribers: number;
  /** Held because a Connector's registry descriptor says `poll` or `none`. */
  registryWithheld: number;
}

interface ConnectorDeliveryRow {
  service_id: string;
  principal_id: string;
  delivery_endpoint: string | null;
  delivery_secret: string | null;
  delivery_cursor: string;
  consecutive_failures: number;
}

function emptyResult(): PassResult {
  return {
    connectorsExamined: 0, workDeliveries: 0,
    subscriptionsExamined: 0, observationDeliveries: 0,
    deliveries: 0, failures: 0, rateLimited: 0,
    refusedSubscribers: 0, registryWithheld: 0,
  };
}

export class WebhookDeliveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly pool: Pool = defaultPool,
    private readonly config: DeliveryWorkerConfig = DEFAULT_DELIVERY_CONFIG,
    private readonly deps: {
      feed: FeedEventService;
      subscribers: SubscriberActorService;
      webhooks: WebhookService;
    } = { feed: feedEventService, subscribers: subscriberActorService, webhooks: webhookService },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runPass().catch((err) => logCaughtFailure('[WebhookDeliveryWorker] pass failed', err));
    }, this.config.intervalSeconds * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    console.log('🪝 WebhookDeliveryWorker delivering work per-assignee and observation per-subscription');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One full pass over BOTH planes. Never self-overlapping. */
  async runPass(): Promise<PassResult> {
    const result = emptyResult();
    if (this.running) return result;
    this.running = true;
    try {
      await this.runWorkPlane(result);
      await this.runObservationPlane(result);
    } finally {
      this.running = false;
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────
  // WORK PLANE — per assignee, from the registry (R1/R2)
  // ─────────────────────────────────────────────────────────────────────

  private async runWorkPlane(result: PassResult): Promise<void> {
    await this.seedConnectorState();
    const claimed = await this.claimDueConnectors();
    result.connectorsExamined = claimed.length;
    for (const connector of claimed) {
      try {
        await this.processConnector(connector, result);
      } catch (err) {
        result.failures += 1;
        logCaughtFailure(`[WebhookDeliveryWorker] connector ${connector.service_id} failed`, err);
        await this.recordConnectorFailure(connector, null, 'INTERNAL_ERROR');
      }
    }
  }

  /**
   * A Connector first seen by the worker starts at the feed HEAD, never at 0:
   * cursor 0 would replay the entire retained history as doorbells at an
   * endpoint that has never heard from this board. Replay stays available by
   * pull, which is the reconciliation contract.
   */
  private async seedConnectorState(): Promise<void> {
    await this.pool.query(
      `INSERT INTO connector_delivery_state (service_id, delivery_cursor)
       SELECT s.id, (SELECT COALESCE(MAX(cursor), 0) FROM feed_events)
         FROM services s
        WHERE s.kind = 'connector'
          AND NOT EXISTS (SELECT 1 FROM connector_delivery_state st WHERE st.service_id = s.id)
       ON CONFLICT (service_id) DO NOTHING`,
    ).catch((err) => logCaughtFailure('[WebhookDeliveryWorker] connector state seed failed', err));
  }

  /**
   * The due set BEGINS FROM THE REGISTRY (review r2, B1). A Connector
   * configured `delivery_mode='webhook'` with an endpoint is delivered to on
   * that configuration ALONE — no subscription row is consulted, and none is
   * required. `poll` and `none` are simply not selected: a poll-mode
   * Connector pulls "my ready tasks" on its own cron (§2.6.4), and neither
   * mode is an error.
   *
   * Only PUBLISHED Connectors receive delivery: a draft registration is not
   * yet in service, and a retired one fails dispatch closed (RH-DESIGN.5 R5,
   * the same rule that retires descriptor pins).
   */
  private async claimDueConnectors(): Promise<ConnectorDeliveryRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query(
        `SELECT st.service_id
           FROM connector_delivery_state st
           JOIN services s ON s.id = st.service_id
          WHERE s.kind = 'connector'
            AND s.status = 'published'
            AND s.delivery_mode = 'webhook'
            AND s.principal_id IS NOT NULL
            AND st.next_attempt_at <= NOW()
          ORDER BY st.next_attempt_at
          LIMIT $1
            FOR UPDATE OF st SKIP LOCKED`,
        [this.config.maxConnectorsPerPass],
      );
      const ids = due.rows.map((row: any) => String(row.service_id));
      if (ids.length === 0) {
        await client.query('COMMIT');
        return [];
      }
      const claimed = await client.query(
        `UPDATE connector_delivery_state st
            SET next_attempt_at = NOW() + ($2 * INTERVAL '1 second')
           FROM services s
          WHERE st.service_id = ANY($1::uuid[]) AND s.id = st.service_id
        RETURNING st.service_id, s.principal_id, s.delivery_endpoint, s.delivery_secret,
                  st.delivery_cursor::text AS delivery_cursor, st.consecutive_failures`,
        [ids, this.config.claimLeaseSeconds],
      );
      await client.query('COMMIT');
      return claimed.rows as ConnectorDeliveryRow[];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async processConnector(connector: ConnectorDeliveryRow, result: PassResult): Promise<void> {
    // The assignee's authority is re-derived LIVE on every pass through the
    // SAME acceptance predicate the pull path uses (utils/credentialAcceptance)
    // — credential type, usable secret, revocation, expiry, the §7.3 grace
    // watermark and the §7.5 transport pin. Disabling the principal, revoking
    // its credential or pinning it to another transport stops delivery on the
    // next pass, with nothing to edit.
    const actorResult = await this.deps.subscribers.actorForConnector(connector.service_id);
    if (!actorResult.ok) {
      result.refusedSubscribers += 1;
      await this.recordConnectorFailure(connector, null, actorResult.refusal);
      return;
    }
    const actor = actorResult.actor;

    // The ROUTE ceiling the real pull clears before any row is scoped.
    const ceiling = authorizationService.authorizeRoute(
      actor, requiredScopeFor('GET', DELIVERY_MIRRORED_PATH),
    );
    if (!ceiling.allowed) {
      result.refusedSubscribers += 1;
      await this.recordConnectorFailure(connector, null, `SUBSCRIBER_ROUTE_${ceiling.denial ?? 'REFUSED'}`);
      return;
    }

    const page = await this.deps.feed.listSince(
      actor, connector.delivery_cursor, this.config.batchSize,
    );

    // Work delivery carries GO SIGNALS and nothing else: §2.6.4 makes
    // `task.ready` "the only 'go' signal", and everything else a Connector
    // wants to watch is observation.
    const goSignals = page.events.filter(
      (event) => GO_SIGNAL_EVENTS.includes(event.name as typeof GO_SIGNAL_EVENTS[number])
        && event.objectType === 'task',
    );

    // ── The per-assignee filter, evaluated at DELIVERY time ──
    // Assignment is read now, not as it stood when the event was emitted, so
    // a reassignment routes the doorbell to the CURRENT assignee and a task
    // unassigned since the emission rings nobody. That mirrors how
    // authorization is evaluated at delivery time throughout this worker, and
    // it is what §2.6.4 means by assignment transitions carrying the same
    // visibility-gain/loss semantics as ACL changes.
    const assigned = await this.assignedSubset(
      goSignals.map((event) => String(event.objectId)), connector.service_id,
    );

    // ── No causation guard on this plane, deliberately ──
    // The observation plane suppresses a subscriber's own writes so that a
    // subscriber which writes on delivery cannot drive itself. Applying the
    // same rule here would break the ratified chain contract: §2.6.4 says
    // "chains advance by construction (a workflow connector finishing its
    // task and filing its report satisfies the dependency; the next
    // assignee's task.ready fires through ITS OWN delivery mode)" — and when
    // the next assignee is the SAME Connector, the actor that caused the
    // readiness IS the addressee. Suppressing that would stall every
    // single-assignee chain. The multi-party cycle §2.6.4 worries about is
    // bounded here by the per-subscriber rate window below, which is the
    // "multi-party backstop" the loop-guard convention names.
    const deliverable: DeliverableEvent[] = goSignals
      .filter((event) => assigned.has(String(event.objectId)))
      .map((event) => ({
        cursor: event.cursor,
        name: event.name,
        objectType: event.objectType,
        objectId: event.objectId,
        // timestamptz arrives from pg as a Date even though the feed's
        // interface types it as a string; normalize so the signed body is
        // deterministic rather than driven by Date's default stringification.
        occurredAt: new Date(event.occurredAt as unknown as string | Date).toISOString(),
      }));

    if (deliverable.length === 0) {
      await this.settleConnector(connector, page.nextCursor);
      return;
    }

    // Loop guard: the window is keyed by the PRINCIPAL, so a Connector's work
    // doorbells and its observation deliveries share one budget rather than
    // getting one each.
    const permitted = await this.claimRateSlot(String(connector.principal_id), deliverable.length);
    if (!permitted) {
      result.rateLimited += 1;
      await this.deferConnectorForRateLimit(connector.service_id, String(connector.principal_id));
      return;
    }

    const target: DeliveryTarget = {
      plane: 'work',
      channelId: String(connector.service_id),
      url: connector.delivery_endpoint ?? '',
      secret: connector.delivery_secret,
    };
    const deliveredAt = new Date().toISOString();
    const highestCursor = deliverable[deliverable.length - 1].cursor;
    // Serialize ONCE: the bytes signed are the bytes sent.
    const body = this.deps.webhooks.buildPayload(target, deliverable, deliveredAt);
    const outcome = await this.deps.webhooks.deliver(target, body, highestCursor);

    if (outcome.ok) {
      result.workDeliveries += 1;
      result.deliveries += 1;
      await this.settleConnector(connector, page.nextCursor, outcome.status);
    } else {
      result.failures += 1;
      await this.recordConnectorFailure(connector, outcome.status, outcome.error);
    }
  }

  /**
   * Which of these task ids are CURRENTLY assigned to this Connector.
   *
   * `tasks.execution_service_id` is the assignment field of record (migration
   * 077; owner decision D6 on run packet c17ebfff). One set-based statement,
   * never a per-event round trip.
   */
  private async assignedSubset(taskIds: string[], serviceId: string): Promise<Set<string>> {
    if (taskIds.length === 0) return new Set();
    const result = await this.pool.query(
      `SELECT id FROM tasks
        WHERE id = ANY($1::uuid[]) AND execution_service_id = $2`,
      [[...new Set(taskIds)], serviceId],
    );
    return new Set(result.rows.map((row: any) => String(row.id)));
  }

  // ─────────────────────────────────────────────────────────────────────
  // OBSERVATION PLANE — per subscription, endpoint from the registry (R1/R3)
  // ─────────────────────────────────────────────────────────────────────

  private async runObservationPlane(result: PassResult): Promise<void> {
    const claimed = await this.claimDue();
    result.subscriptionsExamined = claimed.length;
    for (const subscription of claimed) {
      try {
        await this.processSubscription(subscription, result);
      } catch (err) {
        result.failures += 1;
        logCaughtFailure(`[WebhookDeliveryWorker] subscription ${subscription.id} failed`, err);
        await this.recordFailure(subscription, null, 'INTERNAL_ERROR');
      }
    }
  }

  private async claimDue(): Promise<WebhookSubscriptionRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query(
        `SELECT id FROM webhooks
          WHERE active AND next_attempt_at <= NOW()
          ORDER BY next_attempt_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.config.maxSubscriptionsPerPass],
      );
      const ids = due.rows.map((row: any) => row.id);
      if (ids.length === 0) {
        await client.query('COMMIT');
        return [];
      }
      const claimed = await client.query(
        `UPDATE webhooks
            SET next_attempt_at = NOW() + ($2 * INTERVAL '1 second')
          WHERE id = ANY($1::uuid[])
        RETURNING id, url, secret, events, active, description,
                  subscriber_principal_id, subscriber_credential_id,
                  delivery_cursor::text AS delivery_cursor,
                  consecutive_failures, created_at, last_delivery_at,
                  last_delivery_status, last_delivery_error`,
        [ids, this.config.claimLeaseSeconds],
      );
      await client.query('COMMIT');
      return claimed.rows as WebhookSubscriptionRow[];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async processSubscription(subscription: WebhookSubscriptionRow, result: PassResult): Promise<void> {
    if (!subscription.subscriber_principal_id) {
      result.refusedSubscribers += 1;
      await this.recordFailure(subscription, null, 'SUBSCRIBER_MISSING');
      return;
    }

    // ── R1 · endpoint and mode come from the REGISTRY, always ──
    // The subscription carries no URL (101 CHECK) and none is consulted here.
    // A subscriber that is not a webhook-mode Connector is simply not pushed
    // to: `poll` means it pulls the feed on its own schedule, `none` means it
    // receives nothing, and a subscriber with no registry row at all is not a
    // Connector and so is not an eligible subscriber under R3.
    const registry = await this.connectorRegistry(subscription.subscriber_principal_id);
    if (!registry) {
      result.refusedSubscribers += 1;
      await this.recordFailure(subscription, null, 'SUBSCRIBER_NOT_A_CONNECTOR');
      return;
    }
    if (registry.delivery_mode !== 'webhook') {
      result.registryWithheld += 1;
      await this.holdForRegistry(subscription, registry.delivery_mode);
      return;
    }

    const actorResult = await this.deps.subscribers.actorFor(
      subscription.subscriber_principal_id, subscription.subscriber_credential_id ?? null,
    );
    if (!actorResult.ok) {
      result.refusedSubscribers += 1;
      await this.recordFailure(subscription, null, actorResult.refusal);
      return;
    }
    const actor = actorResult.actor;

    // ── The ROUTE ceiling, which object-level authorization does not apply ──
    // "A subscriber is only ever sent what it could have pulled" is only true
    // if the worker passes every gate the pull passes. The real pull is
    // GET /api/events, which clears authorizeRoute against the scope map
    // BEFORE any row is scoped; authorizeResource/authorizedIds check role,
    // ownership, claimant and grants but NO scope past the root shortcut. A
    // principal whose effective scopes do not satisfy `tasks:read` is 403'd on
    // the pull, so it must receive nothing here either — otherwise the
    // subscription is a channel around the scope ceiling.
    const ceiling = authorizationService.authorizeRoute(
      actor, requiredScopeFor('GET', DELIVERY_MIRRORED_PATH),
    );
    if (!ceiling.allowed) {
      result.refusedSubscribers += 1;
      await this.recordFailure(subscription, null, `SUBSCRIBER_ROUTE_${ceiling.denial ?? 'REFUSED'}`);
      return;
    }

    // Grant-scoped read through the ratified shared predicate. `nextCursor`
    // is computed over the rows EXAMINED, not the rows returned, so events
    // this subscriber is not entitled to are passed over permanently instead
    // of being re-examined forever.
    const page = await this.deps.feed.listSince(
      actor, subscription.delivery_cursor, this.config.batchSize,
    );

    // ── Loop guard 1: causation, over the subscriber's DESCENDANT subtree ──
    // A subscriber acts through the identities BELOW it. The first repair read
    // `actor.delegation.links`, which is the ANCESTOR chain (acting identity
    // up to the Account) — the wrong direction, and null entirely for a
    // parentless subscriber, so a subscriber was still delivered writes its
    // own child Connector performed (review r1, B4). The subtree is now
    // resolved from the principal graph itself.
    const causal = await this.deps.subscribers.causalSubtree(String(subscription.subscriber_principal_id));

    const subscribed: ReadonlySet<string> = new Set(subscription.events ?? []);
    const deliverable: DeliverableEvent[] = page.events
      // R1: observation NEVER carries go-signal semantics. Unrepresentable in
      // the table (101 CHECK) and refused at registration; refused a third
      // time here so a row that reaches the table another way still cannot
      // turn this plane into a work-delivery path.
      .filter((event) => !GO_SIGNAL_EVENTS.includes(event.name as typeof GO_SIGNAL_EVENTS[number]))
      .filter((event) => subscribed.has(event.name))
      // A subscriber is never told about a write it (or a delegated child)
      // performed: otherwise a subscriber that writes on delivery drives
      // itself. This guard is ATTRIBUTION-BASED and therefore only as good as
      // the feed's actor column — an emission that records no actor cannot be
      // attributed and is delivered. That is why the event-rate cap below is
      // load-bearing rather than decorative.
      .filter((event) => !(event.actorPrincipalId && causal.has(String(event.actorPrincipalId))))
      .map((event) => ({
        cursor: event.cursor,
        name: event.name,
        objectType: event.objectType,
        objectId: event.objectId,
        occurredAt: new Date(event.occurredAt as unknown as string | Date).toISOString(),
      }));

    if (deliverable.length === 0) {
      // Nothing to send, but the examined window is settled: advance so the
      // worker does not re-read the same rows every pass, and clear any
      // standing backoff since the subscription is healthy.
      await this.settle(subscription, page.nextCursor);
      return;
    }

    // ── Loop guard 2: per-subscriber rate limit, DEPLOYMENT-WIDE ──
    const permitted = await this.claimRateSlot(
      String(subscription.subscriber_principal_id), deliverable.length,
    );
    if (!permitted) {
      result.rateLimited += 1;
      // Do NOT advance the cursor: the events are undelivered, not skipped.
      await this.deferForRateLimit(subscription.id, String(subscription.subscriber_principal_id));
      return;
    }

    const target: DeliveryTarget = {
      plane: 'observation',
      channelId: String(subscription.id),
      url: registry.delivery_endpoint ?? '',
      secret: registry.delivery_secret,
    };
    const deliveredAt = new Date().toISOString();
    const highestCursor = deliverable[deliverable.length - 1].cursor;
    const body = this.deps.webhooks.buildPayload(target, deliverable, deliveredAt);
    const outcome = await this.deps.webhooks.deliver(target, body, highestCursor);

    if (outcome.ok) {
      result.observationDeliveries += 1;
      result.deliveries += 1;
      // Advance past the whole EXAMINED window, not merely the delivered
      // rows. The skipped rows were filtered by authorization (evaluated at
      // DELIVERY time) or by causation, and re-examining them every pass
      // would stall the subscription permanently behind events it cannot
      // receive.
      //
      // Honest limit: authorization is current-state, so a grant made AFTER
      // this pass does not retroactively push the history it would now allow
      // — the cursor has already moved past it. That is the declared
      // "visibility-gain re-emission" seam from C1 (evidence 0891bbd5), owned
      // by C5, not a property this candidate claims. A subscriber that gains
      // access to history pulls it: the feed is the truth and accepts any
      // cursor, not only this subscription's.
      await this.settle(subscription, page.nextCursor, outcome.status);
    } else {
      result.failures += 1;
      await this.recordFailure(subscription, outcome.status, outcome.error);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Shared machinery
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Atomic, deployment-wide rate claim, keyed by the SUBSCRIBER PRINCIPAL so
   * that every channel that principal owns — work doorbells and observation
   * subscriptions alike — shares ONE budget. A per-row window let N channels
   * multiply the ceiling by N (review r1, B5).
   *
   * One INSERT ... ON CONFLICT DO UPDATE ... WHERE is the whole claim, so two
   * replicas cannot both take the last slot: the conflicting writer
   * re-evaluates the WHERE against the updated tuple after its row-lock wait,
   * and gets no row back when the window is full. This is deployment-wide by
   * construction — never a per-process counter, the failure mode behind the
   * estate's three deferred limiter cards (2b5ede8f, d22f4de2, 329dba46).
   *
   * Returns false when the window is full.
   */
  private async claimRateSlot(subscriberPrincipalId: string, eventCount: number): Promise<boolean> {
    const claimed = await this.pool.query(
      `INSERT INTO webhook_delivery_rate
             (subscriber_principal_id, window_started_at, deliveries, events)
      VALUES ($1, NOW(), 1, $4::int)
      ON CONFLICT (subscriber_principal_id) DO UPDATE
         SET window_started_at = CASE
               WHEN webhook_delivery_rate.window_started_at <= NOW() - ($2 * INTERVAL '1 second')
                 THEN NOW() ELSE webhook_delivery_rate.window_started_at END,
             deliveries = CASE
               WHEN webhook_delivery_rate.window_started_at <= NOW() - ($2 * INTERVAL '1 second')
                 THEN 1 ELSE webhook_delivery_rate.deliveries + 1 END,
             events = CASE
               WHEN webhook_delivery_rate.window_started_at <= NOW() - ($2 * INTERVAL '1 second')
                 THEN $4::int ELSE webhook_delivery_rate.events + $4::int END
       WHERE webhook_delivery_rate.window_started_at <= NOW() - ($2 * INTERVAL '1 second')
          OR (webhook_delivery_rate.deliveries < $3
              AND webhook_delivery_rate.events + $4::int <= $5)
      RETURNING subscriber_principal_id`,
      [subscriberPrincipalId, this.config.rateWindowSeconds, this.config.rateLimitPerWindow,
        Math.max(0, eventCount), this.config.rateLimitEventsPerWindow],
    );
    return (claimed.rowCount ?? 0) > 0;
  }

  /**
   * The Connector registry row for a principal — the SINGLE SOURCE OF TRUTH
   * for where that Connector receives delivery, how, and under which signing
   * secret (R1). A principal with no such row is not a Connector.
   *
   * Deliberately NOT filtered on registration status, unlike the work plane
   * (live-QA finding Q1). Observation is watching; the ruling makes it
   * conditional on being a Connector (R3) and on the registry descriptor
   * (R1), and on nothing else. Requiring `published` here made a subscription
   * the CRUD path had just ACCEPTED — it checks Connector-ness, not
   * publication — silently undeliverable, which is the worst of both: a row
   * that looks configured and never fires.
   *
   * The work plane keeps `status = 'published'` because dispatch there drives
   * EXECUTION against a pinned capability descriptor (RH-DESIGN.5 R5: retired
   * pins fail dispatch closed), and an assignment can only name a published
   * Connector in the first place — validateConnectorProfile refuses anything
   * else. The asymmetry is the difference between being told and being told
   * to work.
   */
  private async connectorRegistry(
    principalId: string,
  ): Promise<{ delivery_mode: string; delivery_endpoint: string | null; delivery_secret: string | null } | null> {
    const result = await this.pool.query(
      `SELECT delivery_mode, delivery_endpoint, delivery_secret
         FROM services
        WHERE principal_id = $1 AND kind = 'connector'
        LIMIT 1`,
      [principalId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * A Connector whose registry mode is `poll` or `none` is not an error and
   * not a failure: it simply is not pushed to. The cursor stays put so that
   * flipping the registry back to `webhook` resumes from where the
   * subscription actually stood.
   */
  private async holdForRegistry(subscription: WebhookSubscriptionRow, mode: string): Promise<void> {
    await this.pool.query(
      `UPDATE webhooks
          SET next_attempt_at = NOW() + ($2 * INTERVAL '1 second'),
              last_delivery_error = $3
        WHERE id = $1`,
      [subscription.id, this.config.rateWindowSeconds, `REGISTRY_DELIVERY_MODE_${mode.toUpperCase()}`],
    ).catch(() => undefined);
  }

  private async deferForRateLimit(subscriptionId: string, subscriberPrincipalId: string): Promise<void> {
    await this.pool.query(
      `UPDATE webhooks
          SET next_attempt_at = COALESCE(
                (SELECT window_started_at + ($3 * INTERVAL '1 second')
                   FROM webhook_delivery_rate WHERE subscriber_principal_id = $2),
                NOW() + ($3 * INTERVAL '1 second')),
              last_delivery_error = 'RATE_LIMITED'
        WHERE id = $1`,
      [subscriptionId, subscriberPrincipalId, this.config.rateWindowSeconds],
    );
  }

  private async deferConnectorForRateLimit(serviceId: string, principalId: string): Promise<void> {
    await this.pool.query(
      `UPDATE connector_delivery_state
          SET next_attempt_at = COALESCE(
                (SELECT window_started_at + ($3 * INTERVAL '1 second')
                   FROM webhook_delivery_rate WHERE subscriber_principal_id = $2),
                NOW() + ($3 * INTERVAL '1 second')),
              last_delivery_error = 'RATE_LIMITED'
        WHERE service_id = $1`,
      [serviceId, principalId, this.config.rateWindowSeconds],
    );
  }

  /** Success (or an empty window): advance the cursor and clear the penalty. */
  private async settle(
    subscription: WebhookSubscriptionRow,
    cursor: string,
    status: number | null = null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE webhooks
          SET delivery_cursor = GREATEST(delivery_cursor, $2::bigint),
              consecutive_failures = 0,
              next_attempt_at = NOW(),
              last_delivery_at = CASE WHEN $3::int IS NULL THEN last_delivery_at ELSE NOW() END,
              last_delivery_status = COALESCE($3::int, last_delivery_status),
              last_delivery_error = NULL
        WHERE id = $1`,
      [subscription.id, this.exactCursor(cursor), status],
    );
  }

  private async settleConnector(
    connector: ConnectorDeliveryRow,
    cursor: string,
    status: number | null = null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE connector_delivery_state
          SET delivery_cursor = GREATEST(delivery_cursor, $2::bigint),
              consecutive_failures = 0,
              next_attempt_at = NOW(),
              last_delivery_at = CASE WHEN $3::int IS NULL THEN last_delivery_at ELSE NOW() END,
              last_delivery_status = COALESCE($3::int, last_delivery_status),
              last_delivery_error = NULL
        WHERE service_id = $1`,
      [connector.service_id, this.exactCursor(cursor), status],
    );
  }

  /**
   * Failure: durable exponential backoff, cursor UNMOVED so the batch is
   * retried rather than lost.
   */
  private async recordFailure(
    subscription: WebhookSubscriptionRow,
    status: number | null,
    error: string | null,
  ): Promise<void> {
    const failures = (subscription.consecutive_failures ?? 0) + 1;
    await this.pool.query(
      `UPDATE webhooks
          SET consecutive_failures = $2,
              next_attempt_at = NOW() + ($3 * INTERVAL '1 second'),
              last_delivery_at = NOW(),
              last_delivery_status = $4,
              last_delivery_error = $5
        WHERE id = $1`,
      [subscription.id, failures, this.backoffFor(failures), status, error],
    ).catch((err) => logCaughtFailure('[WebhookDeliveryWorker] failure bookkeeping failed', err));
  }

  private async recordConnectorFailure(
    connector: ConnectorDeliveryRow,
    status: number | null,
    error: string | null,
  ): Promise<void> {
    const failures = (connector.consecutive_failures ?? 0) + 1;
    await this.pool.query(
      `UPDATE connector_delivery_state
          SET consecutive_failures = $2,
              next_attempt_at = NOW() + ($3 * INTERVAL '1 second'),
              last_delivery_at = NOW(),
              last_delivery_status = $4,
              last_delivery_error = $5
        WHERE service_id = $1`,
      [connector.service_id, failures, this.backoffFor(failures), status, error],
    ).catch((err) => logCaughtFailure('[WebhookDeliveryWorker] connector failure bookkeeping failed', err));
  }

  private backoffFor(failures: number): number {
    return Math.min(
      this.config.backoffBaseSeconds * Math.pow(2, Math.max(0, failures - 1)),
      this.config.backoffMaxSeconds,
    );
  }

  /**
   * Cursors validate to the EXACT emitted encoding — a decimal BIGINT string.
   * A permissive parse (parseInt, Number, a coercing cast) would accept
   * '12abc' or '1e3' and silently move a channel's position in the feed,
   * which is the "cursors validate to the exact emitted encoding" rejection
   * class in runbook §2.
   */
  private exactCursor(value: string): string {
    return /^\d+$/.test(String(value)) ? String(value) : '0';
  }
}

export const webhookDeliveryWorker = new WebhookDeliveryWorker();
