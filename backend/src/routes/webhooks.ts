import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { sendApiError } from '../utils/apiErrors';
import { validateBody, UUID_RE } from '../middleware/validate';
import type { AuthRequest } from '../middleware/auth';
import { auditService } from '../services/AuditService';
import { auditActorFromRequest } from '../utils/auditActor';
import {
  OBSERVABLE_EVENTS, GO_SIGNAL_EVENTS, isObservableEvent, isRegistrableWebhookEvent,
} from '../services/WebhookService';
import { evaluateCredentialAcceptance, evaluateTransportPin, DELIVERY_MIRRORED_PATH, DELIVERY_MIRRORED_TRANSPORT } from '../utils/credentialAcceptance';
import { subscriberActorService } from '../services/SubscriberActorService';
import { authorizationService } from '../services/AuthorizationService';
import { requiredScopeFor } from '../utils/scopeMap';
import { connectorRegistryPredicateSql } from '../utils/connectorRegistry';

/**
 * OBSERVATION SUBSCRIPTION CRUD — RH-P3.C2, under ruling `ccd53781`.
 *
 * ANTI-BEACON: this whole family resolves to the `root` sentinel in the scope
 * map, exactly like /notification-endpoints (design 4d961e37 A17.8, §5.2
 * rule 5 — delegated identities never mutate subscription-class data). A
 * subscription names an identity to observe AS, so a prompt-injected
 * connector that could create one would have a choice of whose authority to
 * use. That is why the plane is root and every mutation is audited.
 *
 * ── What a subscription IS, after the ruling ──
 *
 * R1 · EVENT OBSERVATION ONLY. A subscription carries event-class filters and
 *      **no URL of its own**: the endpoint, the delivery mode and the signing
 *      secret are read from the subscriber Connector's REGISTRY row at
 *      dispatch time (`services.delivery_endpoint` / `delivery_mode` /
 *      `delivery_secret`, all subscription-class behind the root-gated
 *      owner-plane subroute). One endpoint, one secret, one source of truth —
 *      which is what makes a second record impossible to diverge from the
 *      first, the synchronization rule review r2 demanded.
 * R1 · Observation NEVER carries go-signal semantics: `task.ready` is not
 *      registrable here (below), is filtered at dispatch, and is refused by a
 *      CHECK constraint (101). Go signals are delivered PER ASSIGNEE by the
 *      work plane.
 * R3 · Subscribers are CONNECTORS. Accounts hold no bearer credentials
 *      (4d961e37 A17.1) and an Account's automation subscribes THROUGH a
 *      Connector it owns.
 *
 * An active subscription therefore requires exactly two things: the subscriber
 * Connector, and the live credential its deliveries are authorized from. Both
 * are enforced again by a CHECK constraint (101), so a row that reaches the
 * table another way still cannot deliver.
 *
 * Delivery itself is the feed-cursor worker's job (WebhookDeliveryWorker).
 */

const router = Router();

const createSchema = {
  events: { type: 'array' as const, itemsType: 'string' as const },
  description: { type: 'string' as const, maxLen: 500 },
  active: { type: 'boolean' as const },
  subscriberPrincipalId: { type: 'string' as const, maxLen: 64 },
  subscriberCredentialId: { type: 'string' as const, maxLen: 64 },
  // Opt-in replay: '0' replays the whole retained feed. Omitted, a new
  // subscription starts at the current head.
  deliveryCursor: { type: 'string' as const, maxLen: 32, pattern: /^\d+$/, patternHint: 'must be a decimal cursor' },
};

/**
 * ENUMERATED membership, never a wildcard regex (runbook §2 rejection class).
 *
 * Two distinct refusals, because they mean different things to a caller: a
 * name the feed cannot emit at all, versus a name that IS emitted but belongs
 * to the work plane.
 */
function unknownEvents(events: unknown): string[] {
  if (!Array.isArray(events)) return [];
  return events.filter((event) => !isRegistrableWebhookEvent(event)).map(String);
}

function goSignalEvents(events: unknown): string[] {
  if (!Array.isArray(events)) return [];
  return events.filter((event) => isRegistrableWebhookEvent(event) && !isObservableEvent(event)).map(String);
}

const SELECT_COLUMNS = `id, events, active, description,
         subscriber_principal_id AS "subscriberPrincipalId",
         subscriber_credential_id AS "subscriberCredentialId",
         delivery_cursor::text AS "deliveryCursor",
         consecutive_failures AS "consecutiveFailures",
         next_attempt_at AS "nextAttemptAt",
         created_at, last_delivery_at, last_delivery_status, last_delivery_error`;

/**
 * A subscriber must be a CONNECTOR holding a credential that could actually
 * PULL what the subscription would push.
 *
 * The credential half is judged by the SAME shared predicate the delivery
 * worker and the auth middleware use (utils/credentialAcceptance), so a
 * subscription cannot be created against a credential that delivery would
 * then refuse — the caller learns at write time instead of watching a
 * silently non-delivering row.
 *
 * Refused here AND again at delivery time in SubscriberActorService, so
 * neither path alone is load-bearing.
 */
async function subscriberRefusal(
  subscriberPrincipalId: string,
  subscriberCredentialId: string | null,
): Promise<string | null> {
  const result = await pool.query(
    `SELECT p.kind, p.status,
            (${connectorRegistryPredicateSql('p.id')}) AS is_connector,
            c.id AS credential_id, c.principal_id AS credential_principal_id,
            c.credential_type, c.revoked_at, c.expires_at, c.grace_until, c.transport,
            c.key_id, c.secret_hash
       FROM principals p
       LEFT JOIN principal_credentials c ON c.id = $2
      WHERE p.id = $1`,
    [subscriberPrincipalId, subscriberCredentialId],
  );
  const row = result.rows[0];
  if (!row) return 'subscriberPrincipalId names no principal';
  if (row.status !== 'active') return 'the subscriber principal is not active';
  if (row.kind === 'agent') {
    return 'an Agent principal cannot be a subscription subscriber — Agents are task-bounded (design 4d961e37 §5.2); use its Connector';
  }
  // Ruling ccd53781 R3. A Connector is a services row with kind='connector'
  // naming this principal (A17.2) — `principals.kind` has no 'connector' value.
  if (row.is_connector !== true) {
    return 'a subscription subscriber must be a registered Connector — Accounts hold no bearer credentials (design 4d961e37 A17.1), so there is no pull authority for an observation to mirror';
  }
  if (!subscriberCredentialId) {
    return 'subscriberCredentialId is required — deliveries are authorized from the credential\'s own scopes, never from the principal\'s role';
  }
  if (!row.credential_id) return 'subscriberCredentialId names no credential';
  if (String(row.credential_principal_id) !== String(subscriberPrincipalId)) {
    return 'the credential does not belong to the subscriber principal';
  }
  const acceptance = evaluateCredentialAcceptance({
    credentialType: row.credential_type,
    keyId: row.key_id,
    secretHash: row.secret_hash,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    graceUntil: row.grace_until,
    principalStatus: row.status,
  });
  if (!acceptance.ok) {
    return `the credential is not usable for delivery (${acceptance.denial}) — deliveries are authorized exactly as a real pull is`;
  }
  const pin = evaluateTransportPin(row.transport, DELIVERY_MIRRORED_PATH, DELIVERY_MIRRORED_TRANSPORT);
  if (!pin.allowed) {
    return 'the credential is pinned to a different transport class (design 4d961e37 §7.5) and would be refused the equivalent pull';
  }

  // ── The ROUTE CEILING, run here and not only at dispatch (review r3, B2) ──
  //
  // Everything above judges the credential ROW. None of it derives the
  // credential's effective SCOPES, so a Connector credential holding only
  // `reports:read` created an active subscription successfully and then could
  // never be delivered anything: the worker refuses it with
  // SUBSCRIBER_ROUTE_* on every pass, forever, and the refusal is visible
  // only on the row. A subscription that cannot possibly deliver should not
  // be creatable.
  //
  // This runs the PRODUCTION derivation and the PRODUCTION ceiling — the same
  // two calls the worker makes — rather than a re-implementation, so the
  // write path and the dispatch path cannot disagree about who is eligible.
  const actorResult = await subscriberActorService.actorFor(subscriberPrincipalId, subscriberCredentialId);
  if (!actorResult.ok) {
    return `the credential cannot be derived into a delivery identity (${actorResult.refusal})`;
  }
  const ceiling = authorizationService.authorizeRoute(
    actorResult.actor, requiredScopeFor('GET', DELIVERY_MIRRORED_PATH),
  );
  if (!ceiling.allowed) {
    return `the credential cannot clear ${DELIVERY_MIRRORED_PATH} (${ceiling.denial ?? 'REFUSED'}) — a subscriber is only ever sent what it could have pulled, so this subscription could never deliver`;
  }
  return null;
}

/** Shared event validation for both create and update. Returns true if it answered. */
function refusedEvents(res: Response, events: unknown): boolean {
  const unknown = unknownEvents(events);
  if (unknown.length) {
    sendApiError(res, 400, 'UNKNOWN_EVENT', `Unknown event(s): ${unknown.join(', ')}`,
      `Valid events: ${OBSERVABLE_EVENTS.join(', ')}`);
    return true;
  }
  const goSignals = goSignalEvents(events);
  if (goSignals.length) {
    sendApiError(res, 400, 'GO_SIGNAL_NOT_OBSERVABLE',
      `Go signals cannot be observed by subscription: ${goSignals.join(', ')}`,
      `${GO_SIGNAL_EVENTS.join(', ')} are delivered per-assignee by the work plane, per each Connector's registry descriptor (strategy 4e40f06f §2.6.4, ruling ccd53781 R1). Configure the Connector's delivery_mode instead of subscribing.`);
    return true;
  }
  return false;
}

router.get('/', async (_req: Request, res: Response) => {
  const result = await pool.query(`SELECT ${SELECT_COLUMNS} FROM webhooks ORDER BY created_at`);
  res.json({ success: true, webhooks: result.rows });
});

router.post('/', validateBody(createSchema), async (req: AuthRequest, res: Response) => {
  if (refusedEvents(res, req.body.events)) return;

  const { events, description, active, subscriberPrincipalId,
    subscriberCredentialId, deliveryCursor } = req.body;
  const wantsActive = active === undefined ? true : active === true;

  // An ACTIVE subscription must be attributable. Refused here with a named
  // reason rather than left to the CHECK, so the caller learns WHICH
  // requirement it missed.
  if (wantsActive && (typeof subscriberPrincipalId !== 'string' || !UUID_RE.test(subscriberPrincipalId))) {
    sendApiError(res, 400, 'SUBSCRIPTION_UNATTRIBUTED',
      'An active subscription requires subscriberPrincipalId (a Connector principal UUID)',
      'Deliveries are grant-scoped against this principal — a subscriber is only ever sent what it could have pulled — and its registry row supplies the endpoint, mode and signing secret.');
    return;
  }
  if (wantsActive && (typeof subscriberCredentialId !== 'string' || !UUID_RE.test(subscriberCredentialId))) {
    sendApiError(res, 400, 'SUBSCRIPTION_UNATTRIBUTED',
      'An active subscription requires subscriberCredentialId (a credential UUID)',
      'Delivery authority is derived from that credential\'s own scopes, exactly as a real request is, so a subscription can never be pushed more than the credential could pull.');
    return;
  }
  if (typeof subscriberPrincipalId === 'string' && UUID_RE.test(subscriberPrincipalId)) {
    const refusal = await subscriberRefusal(
      subscriberPrincipalId,
      typeof subscriberCredentialId === 'string' && UUID_RE.test(subscriberCredentialId)
        ? subscriberCredentialId : null,
    );
    if (refusal) { sendApiError(res, 400, 'INVALID_SUBSCRIBER', refusal); return; }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A new subscription starts at the CURRENT feed head. Starting at 0 would
    // replay the entire retained history at an endpoint before it saw
    // anything current — on DEV that was already 7,360 events, roughly six
    // minutes of pure backlog at the worker's batch rate, and unbounded on a
    // real estate. `deliveryCursor: "0"` asks for that replay deliberately.
    const result = await client.query(
      `INSERT INTO webhooks (events, description, active, subscriber_principal_id, subscriber_credential_id, delivery_cursor)
       VALUES (COALESCE($1, ARRAY['task.created','task.updated','task.deleted','task.archived']), $2, COALESCE($3, true), $4, $5,
               COALESCE($6::bigint, (SELECT COALESCE(MAX(cursor), 0) FROM feed_events)))
       RETURNING ${SELECT_COLUMNS}`,
      [events && events.length ? events : null, description ?? null,
        active, subscriberPrincipalId ?? null, subscriberCredentialId ?? null,
        typeof deliveryCursor === 'string' && /^\d+$/.test(deliveryCursor) ? deliveryCursor : null],
    );
    const webhook = result.rows[0];
    await auditService.record({
      action: 'subscription.create', actor: auditActorFromRequest(req),
      resourceType: 'subscription', resourceId: webhook.id,
      metadata: {
        events: webhook.events, active: webhook.active,
        subscriberPrincipalId: webhook.subscriberPrincipalId,
      },
    }, client);
    await client.query('COMMIT');
    res.status(201).json({ success: true, webhook });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

router.patch('/:id', validateBody(createSchema, { allowUnknown: false }), async (req: AuthRequest, res: Response) => {
  if (!UUID_RE.test(req.params.id)) {
    sendApiError(res, 400, 'INVALID_WEBHOOK_ID', 'Webhook id must be a UUID'); return;
  }
  if (refusedEvents(res, req.body.events)) return;

  const { events, description, active, subscriberPrincipalId, subscriberCredentialId } = req.body;
  if (subscriberCredentialId !== undefined
      && (typeof subscriberCredentialId !== 'string' || !UUID_RE.test(subscriberCredentialId))) {
    sendApiError(res, 400, 'INVALID_SUBSCRIBER', 'subscriberCredentialId must be a credential UUID'); return;
  }
  if (subscriberPrincipalId !== undefined
      && (typeof subscriberPrincipalId !== 'string' || !UUID_RE.test(subscriberPrincipalId))) {
    sendApiError(res, 400, 'INVALID_SUBSCRIBER', 'subscriberPrincipalId must be a principal UUID'); return;
  }
  // ── Every transition INTO active revalidates (review r3, B4) ──
  //
  // Validating only when a subscriber id appears in the body let
  // `{ "active": true }` alone reactivate a subscription whose stored
  // credential had since been revoked, expired, or been re-pinned to another
  // transport: the non-null FK CHECK still passed, so the route returned 200
  // and active:true while the worker refused every subsequent pass. Arming a
  // channel is exactly when its identity must be re-proven.
  const touchesSubscriber = subscriberPrincipalId !== undefined || subscriberCredentialId !== undefined;
  const activating = active === true;
  if (touchesSubscriber || activating) {
    // Re-validate the PAIR as it will stand after the update, not just the
    // field that changed: swapping either half alone could otherwise leave a
    // credential paired with a principal it does not belong to.
    const existing = await pool.query(
      'SELECT subscriber_principal_id, subscriber_credential_id, active FROM webhooks WHERE id = $1',
      [req.params.id],
    );
    if (!existing.rowCount) { sendApiError(res, 404, 'WEBHOOK_NOT_FOUND', 'No webhook with that id'); return; }
    const nextPrincipal = subscriberPrincipalId ?? existing.rows[0].subscriber_principal_id;
    const nextCredential = subscriberCredentialId ?? existing.rows[0].subscriber_credential_id;
    const nextActive = active === undefined ? existing.rows[0].active === true : activating;
    if (nextActive && !nextPrincipal) {
      sendApiError(res, 400, 'SUBSCRIPTION_UNATTRIBUTED',
        'An active subscription requires a subscriber principal and its delivery credential');
      return;
    }
    if (nextPrincipal) {
      const refusal = await subscriberRefusal(String(nextPrincipal), nextCredential ? String(nextCredential) : null);
      if (refusal) { sendApiError(res, 400, 'INVALID_SUBSCRIBER', refusal); return; }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE webhooks SET
         events = COALESCE($2, events),
         description = COALESCE($3, description),
         active = COALESCE($4, active),
         subscriber_principal_id = COALESCE($5, subscriber_principal_id),
         subscriber_credential_id = COALESCE($6, subscriber_credential_id)
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [req.params.id, events && events.length ? events : null,
        description ?? null, active ?? null, subscriberPrincipalId ?? null,
        subscriberCredentialId ?? null],
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      sendApiError(res, 404, 'WEBHOOK_NOT_FOUND', 'No webhook with that id');
      return;
    }
    const webhook = result.rows[0];
    await auditService.record({
      action: 'subscription.update', actor: auditActorFromRequest(req),
      resourceType: 'subscription', resourceId: webhook.id,
      metadata: {
        changedFields: Object.keys(req.body),
        events: webhook.events,
        active: webhook.active,
        subscriberPrincipalId: webhook.subscriberPrincipalId,
      },
    }, client);
    await client.query('COMMIT');
    res.json({ success: true, webhook });
  } catch (error) {
    await client.query('ROLLBACK');
    // The 101 CHECKs are the last line of defence: activating a subscription
    // with no subscriber, with a URL of its own, or carrying a go signal is
    // refused by the database even if a future caller reaches this UPDATE
    // without passing the checks above.
    const constraint = (error as { constraint?: string })?.constraint;
    if (constraint === 'webhooks_active_requires_subscriber') {
      sendApiError(res, 400, 'SUBSCRIPTION_NOT_ACTIVATABLE',
        'An active subscription requires both a subscriber principal and its delivery credential');
      return;
    }
    if (constraint === 'webhooks_active_carries_no_url') {
      sendApiError(res, 400, 'SUBSCRIPTION_NOT_ACTIVATABLE',
        'An active subscription carries no URL of its own — the endpoint is read from the subscriber Connector\'s registry row (ruling ccd53781 R1)');
      return;
    }
    if (constraint === 'webhooks_observation_excludes_go_signals') {
      sendApiError(res, 400, 'GO_SIGNAL_NOT_OBSERVABLE',
        `Go signals cannot be observed by subscription: ${GO_SIGNAL_EVENTS.join(', ')} are delivered per-assignee by the work plane`);
      return;
    }
    throw error;
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  if (!UUID_RE.test(req.params.id)) {
    sendApiError(res, 400, 'INVALID_WEBHOOK_ID', 'Webhook id must be a UUID'); return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'DELETE FROM webhooks WHERE id = $1 RETURNING id, events, active',
      [req.params.id],
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      sendApiError(res, 404, 'WEBHOOK_NOT_FOUND', 'No webhook with that id');
      return;
    }
    const webhook = result.rows[0];
    await auditService.record({
      action: 'subscription.delete', actor: auditActorFromRequest(req),
      resourceType: 'subscription', resourceId: webhook.id,
      metadata: { events: webhook.events, active: webhook.active },
    }, client);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

export default router;
