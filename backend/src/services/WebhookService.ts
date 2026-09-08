import crypto from 'crypto';

/**
 * WebhookService — RH-P3.C2: signed, ID-ONLY webhook subscriptions.
 *
 * Strategy §2.6.4 via analysis d8507677 §4 and runbook daf703a6 §5. This
 * module owns the subscription row, the payload shape and the signature; the
 * cursor loop that decides WHAT to deliver lives in WebhookDeliveryWorker.
 *
 * ── Two contract changes from the pre-C2 service, both deliberate ──
 *
 * 1. **ID-only.** A delivery carries identity and nothing else: cursor, event
 *    name, object type, object id, occurrence time. It no longer carries
 *    titles, statuses, priorities, projects or tags. Authority travels in the
 *    PULL — the same rule C1 already applies to the feed itself — so a
 *    subscriber learns that something happened and must fetch the object
 *    under its own grants to learn what. This SUPERSEDES the payload shape
 *    pinned by webhookTaskEventContract.test.ts, which recorded a VOCAB.5-era
 *    guarantee that a RENAME changed nothing observable; it was never a
 *    promise that Phase 3 would not re-cut the payload, and every governing
 *    document that speaks to this payload says ID-only.
 *
 * 2. **Signing is mandatory.** A webhook-mode Connector cannot exist without
 *    a `delivery_secret` (101 CHECK), so an unsigned delivery is not
 *    representable. The signature covers the exact serialized body that is
 *    transmitted — the body is built once and both signed and sent, never
 *    re-serialized between, because a re-serialization is where
 *    signature-vs-body drift gets in.
 *
 * ── One endpoint, one secret (ruling ccd53781 R1) ──
 *
 * Both planes deliver to the SAME address: the subscriber/assignee
 * Connector's `services.delivery_endpoint`, signed with its
 * `services.delivery_secret`. Neither is ever read from a subscription row —
 * that is the single-source rule the ruling states, and it is also what makes
 * the receiving end simple: one URL, one secret to verify, with the `plane`
 * discriminator in the body saying whether the message is a work doorbell or
 * an observation.
 *
 * Delivery is driven by the feed cursor, not by an EventEmitter: an emitter
 * dispatch is lost on restart, carries no cursor, and cannot be grant-scoped,
 * which is why the pre-C2 path could satisfy none of the C2 contract.
 */

export interface WebhookSubscriptionRow {
  id: string;
  /**
   * RETIRED as a delivery target (ruling ccd53781 R1) — the endpoint comes
   * from the subscriber Connector's registry row. Retained on pre-C2 rows,
   * which this candidate deactivates; NULL on every active subscription.
   */
  url: string | null;
  /**
   * RETIRED as the signing key (ruling ccd53781 R1): one endpoint, one
   * secret, both registry data. Retained for the deactivated pre-C2 rows.
   */
  secret: string | null;
  events: string[];
  active: boolean;
  description: string | null;
  subscriber_principal_id: string | null;
  /** The live credential this subscription delivers as (review r1, B2). */
  subscriber_credential_id: string | null;
  delivery_cursor: string;
  consecutive_failures: number;
  created_at: string;
  last_delivery_at: string | null;
  last_delivery_status: number | null;
  last_delivery_error: string | null;
}

/**
 * The registrable event set: exactly the dotted work-object lifecycle names
 * the C1 feed emits. ENUMERATED, never a wildcard regex — a wildcard would
 * silently register names the feed cannot produce, and subscribers would wait
 * forever for events that structurally cannot arrive.
 *
 * `task.ready` is added by this candidate (card subtask 2, runbook §5).
 *
 * The `*.acl_changed` family spans all six feed object types because
 * GrantService derives the name from the granted resource type, so
 * `project.acl_changed` is producible even though project LIFECYCLE events
 * are not — Project-object emission is a C1-declared, still-unimplemented
 * seam, and registering project.created/updated/deleted here would promise
 * events the tree structurally cannot emit.
 *
 * Six pre-C2 names are NOT here: report.archived, report.unarchived and the
 * five skill.version.* / skill.pin.changed names. They were emitter-only and
 * have no feed home — the skill.version.* names are three-segment and cannot
 * enter the feed without a vocabulary amendment (b94dd86e §6 requires
 * <singular>.<past-tense>, and the 091 CHECK enforces it). Nothing becomes
 * invisible: report archival and unarchival emit `report.updated` carrying a
 * status discriminator (ReportManager), and skill version/pin changes emit
 * `skill.updated` (SkillManager). Subscribers migrate to the coarser name.
 * Re-homing the finer names is follow-up work, not a silent drop.
 *
 * `webhookEventCensus.test.ts` asserts this set against every feed name the
 * tree can actually emit, so the list cannot drift out of truth silently.
 */
export const WEBHOOK_EVENTS = [
  'task.created', 'task.updated', 'task.deleted', 'task.archived',
  'task.ready', 'task.stuck', 'task.acl_changed',
  'phase.created', 'phase.updated', 'phase.deleted', 'phase.acl_changed',
  'project.acl_changed',
  'report.created', 'report.updated', 'report.deleted', 'report.acl_changed',
  'skill.created', 'skill.updated', 'skill.deleted', 'skill.acl_changed',
  'personality.created', 'personality.updated', 'personality.deleted',
  'personality.acl_changed',
] as const;

export type WebhookEvent = typeof WEBHOOK_EVENTS[number];

const WEBHOOK_EVENT_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENTS);

/**
 * GO SIGNALS belong to the WORK plane and to it alone (ruling ccd53781 R1:
 * "Observation delivery never carries go-signal or claim semantics and is
 * never a work-delivery path").
 *
 * `task.ready` is delivered to the ASSIGNEE, per its registry descriptor. An
 * observer subscribing to it would receive a go signal for work assigned to
 * somebody else — the premature-pickup failure that arming exists to close,
 * re-opened through the observation plane. Refused at registration, refused
 * again at dispatch, and unrepresentable in the table (101 CHECK).
 */
export const GO_SIGNAL_EVENTS = ['task.ready'] as const;

const GO_SIGNAL_SET: ReadonlySet<string> = new Set(GO_SIGNAL_EVENTS);

/** The observation plane's registrable set: every feed name that is not a go signal. */
export const OBSERVABLE_EVENTS = WEBHOOK_EVENTS.filter((name) => !GO_SIGNAL_SET.has(name));

export function isGoSignalEvent(name: unknown): boolean {
  return typeof name === 'string' && GO_SIGNAL_SET.has(name);
}

export function isRegistrableWebhookEvent(name: unknown): name is WebhookEvent {
  return typeof name === 'string' && WEBHOOK_EVENT_SET.has(name);
}

/** Registrable ON A SUBSCRIPTION: in the feed's set, and not a go signal. */
export function isObservableEvent(name: unknown): name is WebhookEvent {
  return isRegistrableWebhookEvent(name) && !GO_SIGNAL_SET.has(name);
}

/** One delivered event — identity only. */
export interface DeliverableEvent {
  cursor: string;
  name: string;
  objectType: string;
  objectId: string;
  occurredAt: string;
}

/**
 * Where a delivery goes and how it is signed — resolved from the Connector's
 * registry row for BOTH planes, never from a subscription.
 *
 * `channelId` identifies the thing being delivered FOR: the Connector's
 * services.id on the work plane, the subscription's id on the observation
 * plane. It is echoed in the body and the headers so a receiver can correlate
 * and de-duplicate without inspecting event contents.
 */
export interface DeliveryTarget {
  plane: DeliveryPlane;
  channelId: string;
  url: string;
  secret: string | null;
}

/**
 * WORK delivery is the per-assignee go signal (§2.6.4: `task.ready` is the
 * only "go" signal, delivered per the assignee's registry descriptor).
 * OBSERVATION delivery is the §2.6 triggers/watchdogs consumer: event-class
 * filters over the feed, never a go signal, never a claim.
 */
export type DeliveryPlane = 'work' | 'observation';

export interface DeliveryOutcome {
  ok: boolean;
  status: number | null;
  error: string | null;
}

const DELIVERY_TIMEOUT_MS = 5000;

/**
 * Pure by design: payload shape, signature and transport only. Every durable
 * decision (which subscription, which cursor, whether the rate window allows
 * it) belongs to WebhookDeliveryWorker, so this class holds no database
 * handle and nothing here can advance a cursor as a side effect.
 */
export class WebhookService {

  /**
   * The ID-only body. Kept as a single function so there is exactly one place
   * that decides what leaves the deployment, and a reviewer has one place to
   * check that nothing content-bearing crept in.
   *
   * `cursor` is the highest cursor in the batch: a receiver that persists it
   * can reconcile a dropped delivery by pulling GET /api/events?cursor=<it>.
   * The webhook is a HINT; the feed is the TRUTH (§2.6.2 reconciliation
   * doctrine) — which is why a dropped doorbell costs latency, never work.
   */
  buildPayload(target: DeliveryTarget, events: DeliverableEvent[], deliveredAt: string): string {
    return JSON.stringify({
      // The discriminator is part of the SIGNED bytes: a receiver must never
      // have to guess whether a message is a go signal, and an observation
      // must never be replayable as one.
      plane: target.plane,
      channelId: target.channelId,
      deliveredAt,
      cursor: events.length ? events[events.length - 1].cursor : '0',
      events: events.map((event) => ({
        cursor: event.cursor,
        name: event.name,
        objectType: event.objectType,
        objectId: event.objectId,
        occurredAt: event.occurredAt,
      })),
    });
  }

  buildSignature(secret: string, body: string): string {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  /**
   * POST one batch. The body is serialized by the caller and passed through
   * unchanged so the signature provably covers the transmitted bytes.
   *
   * Two attempts with a 5s timeout each; anything beyond that is the worker's
   * durable backoff, not an inline retry loop — an inline loop would hold a
   * claimed subscription while a slow endpoint burns the pass.
   */
  async deliver(target: DeliveryTarget, body: string, highestCursor: string): Promise<DeliveryOutcome> {
    if (!target.secret) {
      // Unreachable through the 101 services CHECK for a webhook-mode
      // Connector; refused rather than sent unsigned if it is ever reached
      // another way.
      return { ok: false, status: null, error: 'DELIVERY_UNSIGNED' };
    }
    if (!target.url) return { ok: false, status: null, error: 'DELIVERY_UNADDRESSED' };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-RelayHall-Plane': target.plane,
      'X-RelayHall-Channel-Id': target.channelId,
      'X-RelayHall-Cursor': highestCursor,
      'X-RelayHall-Signature': this.buildSignature(target.secret, body),
    };

    let lastError: string | null = null;
    let status: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
        try {
          const response = await fetch(target.url, {
            method: 'POST', headers, body, signal: controller.signal,
          });
          status = response.status;
          if (response.ok) return { ok: true, status, error: null };
          lastError = `HTTP ${response.status}`;
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    return { ok: false, status, error: lastError };
  }
}

export const webhookService = new WebhookService();
