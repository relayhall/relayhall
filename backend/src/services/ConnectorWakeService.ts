/**
 * ConnectorWakeService — card 6dea3cca (split from 54407a1f by owner ruling
 * D4, 2026-10-08): the board's half of the Connector WebSocket WAKE, and the
 * RECEIPT that says truthfully what happened to it.
 *
 * ── What a wake is ──
 *
 * A Connector that subscribes to `/events/ws?wake=1` with its own credential
 * declares a WAKE ENDPOINT. When a Task assigned to that Connector becomes
 * ready (`task.ready`, the only go signal: assigned, todo, armed, dependencies
 * satisfied), the board sends an identifier-only frame on the Connector's open
 * sockets:
 *
 *   {"type":"wake","wakeId":"<uuid>","taskId":"<uuid>","cursor":"<feed cursor>","attempt":1}
 *
 * and waits for the Connector's acknowledgement on the same socket:
 *
 *   {"type":"wake.ack","wakeId":"<uuid>","telemetry":{ ...rh.ai.telemetry/1.0... }}
 *
 * The wake is a HINT, exactly like a webhook doorbell: authority travels in
 * the pull. It assigns nothing, claims nothing and carries no Task content;
 * the Connector still reads the Task and claims it through the ordinary verbs.
 *
 * ── Wake kinds, protocol 2 (universal harness connector design, owner ruling E462, section 6) ──
 *
 * `?wake=2` keeps the `implement` wake above, framed with `"kind":"implement"`,
 * and adds two kinds, each derived from the Action Center's own predicate
 * through its per-Task form (`NotificationActionsService.openTaskItems`, the
 * list's two queries narrowed to named Tasks, never a copy):
 *
 *   verify  a Verify item opens for the Connector: a Task in Review whose
 *           Verifier is in the Connector's principal subtree, or an active
 *           native review naming it. The no-Verifier arm is addressed to an
 *           Account owner and rings nothing here.
 *   stuck   a Stuck item opens for the Connector: it is the Task's exact
 *           addressee (the Shepherd, else the creator, else the Assignee).
 *
 * They are evaluated on the feed events that can open such an item (a move to
 * `review` or `stuck`, a Verifier change, `task.review_requested`,
 * `task.stuck`), for that one Task, under the Connector's own actor. One wake
 * is in flight per (Task, kind, principal), and an occurrence already rung is
 * not rung again. Each kind has its own withdrawal rule: `verify` is withdrawn
 * when the Task leaves Review, its Verifier changes or the item closes;
 * `stuck` when its item closes. A Connector is never rung to verify its own
 * work: the server-side chain guard G(Task) of slice S4b (design section 6.8,
 * utils/verificationGuardSql.ts) is the one predicate, the same one the
 * `verify` authorization arms read, so a Connector in G(Task), or a Verifier
 * the guard refuses, is never rung. `?wake=1` stays exactly as it was:
 * implement only, no kind. An endpoint is rung for `verify` and `stuck` while
 * ANY of its open sockets subscribed with protocol 2.
 *
 * On protocol 2 the acknowledgement means only "the Connector has it" (design
 * section 6.2, choice C8). What the Connector then did arrives later, on the
 * SAME socket, as a `wake.outcome` frame (section 6.7), and the board writes it
 * as a `system` stream entry `connector.trigger` with an audit row
 * `connector.trigger.<outcome>`. An outcome is accepted only for a wake this
 * socket acknowledged, in order (`started` before `finished`; `refused`,
 * `notified` and `finished` end it), and only while the Connector can still
 * read the Task.
 *
 * ── Bounded retry ──
 *
 * A wake is re-sent on a doubling backoff (waits of 1 s, 2 s, 4 s and a final
 * 8 s: four attempts, about 15 s) until it is acknowledged, the Task leaves
 * the ready state for this Connector, or the budget is spent. An attempt that
 * finds no open socket sends nothing but still counts, so a Connector that
 * reconnects inside the budget is woken on its new socket.
 *
 * ── The receipt (written once per settled wake, in one transaction) ──
 *
 *   - an audit row `connector.wake.<outcome>` on the Task, and
 *   - a `system` Task stream entry `connector.wake`,
 *   both carrying the same receipt object; and, for an acknowledgement only,
 *   - TELEMETRY: the envelope the Connector put in its acknowledgement is
 *     ingested through THE one normalization entry point
 *     (`telemetryEnvelopeStore.store`), under the binding derived from the
 *     socket's authenticated chain, after the same descriptor-product and
 *     receiver-limit checks `POST /telemetry/events` applies. The board never
 *     composes an envelope, so a negative outcome writes no telemetry at all.
 *
 * ── Truthful model identity ──
 *
 * `reported.model` is copied from the acknowledgement's VALIDATED envelope and
 * from nowhere else. `model.resolved` is the envelope field reserved for the
 * model the provider's own response named, so `modelIdentity` is
 * `provider-reported` only when it is present; `requested-only` when the
 * Connector named only the model it asked for (configured, not observed); and
 * `not-reported` otherwise. Nothing is filled in from the descriptor, the
 * execution profile or a default.
 *
 * ── Fallback ──
 *
 * `unanswered`, `offline` and `superseded` change nothing on the Task: it is
 * still assigned and, while still ready, discoverable through the Connector's
 * polling of `GET /events` and its registry delivery. The receipt says
 * `fallback: "polling"`. Nothing is re-sent after a wake settles. For `verify`
 * and `stuck` the pull is `GET /notifications/actions`, which lists exactly
 * the items these kinds ring for (design section 6.3: catch-up on every
 * reconnect and a reconcile poll, no new core state).
 *
 * ── Scope, stated rather than implied ──
 *
 *   - Wake state is held in PROCESS MEMORY. An endpoint is learned from a live
 *     `wake=1` or `wake=2` subscription and remembered for 24 h after its last
 *     socket closes, which is what lets an offline Connector's wakes be
 *     recorded as `offline`. A restart forgets endpoints, drops in-flight
 *     wakes without a receipt, and forgets which wakes may still report an
 *     outcome; polling still finds the work. RelayHall runs one backend
 *     process; a multi-process deployment would record `offline` from a
 *     process that does not hold the socket and needs sticky routing first.
 *   - PUSH NEVER EXCEEDS PULL: feed events are read through the Connector's
 *     OWN actor (`SubscriberActorService.actorForConnector`, the derivation
 *     the webhook work plane uses) under the `GET /events` route ceiling.
 *     `implement` is then narrowed to Tasks currently assigned to it
 *     (`tasks.execution_service_id`); `verify` and `stuck` to the items the
 *     Connector's own `GET /notifications/actions` would list, re-read under
 *     its current actor before every send.
 */
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { exactVerifierGuardedSql, guardedPrincipalsSql } from '../utils/verificationGuardSql';
import { WebSocket } from 'ws';
import { pool as defaultPool } from '../db/connection';
import { feedEventService, type FeedEvent, type FeedEventService } from './FeedEventService';
import { subscriberActorService, type SubscriberActorService } from './SubscriberActorService';
import { authorizationService, type AuthorizationActor, type DelegationActorLink } from './AuthorizationService';
import { authorizationRepository, type AuthorizationListScope } from './AuthorizationRepository';
import { notificationActionsService, type ActionsViewer, type NotificationActionsService } from './NotificationActionsService';
import { requiredScopeFor, scopesSatisfy } from '../utils/scopeMap';
import { DELIVERY_MIRRORED_PATH } from '../utils/credentialAcceptance';
import { GO_SIGNAL_EVENTS } from './WebhookService';
import { auditService, type AuditActor, type AuditService, type AuditWrite } from './AuditService';
import { telemetryPrincipalService } from './TelemetryPrincipalService';
import { telemetryEnvelopeStore } from './TelemetryEnvelopeStore';
import { productIsDeclared } from './TelemetryDescriptorPolicy';
import { telemetryRateLimitService } from './TelemetryRateLimitService';
import { validateTelemetryEnvelope } from '../utils/telemetryEnvelopeValidator';
import type { TelemetryEnvelope } from '../types/TelemetryEnvelope';
import { logCaughtFailure } from '../utils/secretSafeLog';
import {
  parseWakeAck, WAKE_ACK_MAX_BYTES,
  type WakeAck, type WakeKind, type WakeOutcomeReport, type WakeProtocol, type WakeTriggerOutcome,
} from '../utils/connectorWakeProtocol';

export const WAKE_OUTCOMES = ['acknowledged', 'unanswered', 'offline', 'superseded'] as const;
export type WakeOutcome = (typeof WAKE_OUTCOMES)[number];
export type ModelIdentity = 'provider-reported' | 'requested-only' | 'not-reported';

/** The stream event type every wake receipt is written under. */
export const WAKE_STREAM_EVENT_TYPE = 'connector.wake';
/** The stream event type every reported trigger outcome is written under (design section 6.7). */
export const TRIGGER_STREAM_EVENT_TYPE = 'connector.trigger';
const SOCKET_BUFFER_LIMIT = 262144;

/** Acknowledged protocol-2 wakes one socket may still report an outcome for; the oldest is forgotten first. */
export const OUTCOME_WAKES_PER_SOCKET = 64;
/** Occurrences remembered per process so one open item is rung once; the oldest is forgotten first. */
export const RUNG_OCCURRENCES_LIMIT = 4096;

/**
 * The Verify reasons that ring the Connector (design section 6.1): the exact
 * Verifier arm and the native-review arm. `no-verifier` is addressed to an
 * Account owner and never rings a Connector.
 */
export const VERIFY_WAKE_REASONS: readonly string[] = ['verifier', 'native-review'];

/** An endpoint is rung for `verify` and `stuck` while any of its open sockets subscribed with protocol 2. */
export function speaksProtocol2(endpoint: { sockets: Map<WebSocket, WakeProtocol> }): boolean {
  for (const [ws, protocol] of endpoint.sockets) if (protocol === 2 && ws.readyState === WebSocket.OPEN) return true;
  return false;
}

/**
 * The occurrence a `verify` wake is rung for: the Verifier arm's (the move to
 * Review, and the Verifier), and the native-review arm's own review ids, so a
 * new native review on a Task is a new occurrence while the same one is rung
 * once.
 */
export function verifyOccurrence(item: { reasons: string[]; since: string; nativeReviewIds?: string[] }, verifierPrincipalId: string | null): string {
  const parts: string[] = [];
  if (item.reasons.includes('verifier')) parts.push(`${item.since}|${verifierPrincipalId ?? ''}`);
  if (item.reasons.includes('native-review')) parts.push(`review:${(item.nativeReviewIds ?? []).join(',')}`);
  return parts.join('#');
}

/**
 * Which wake kinds a feed event can open (design section 6.1): a move to
 * `review`, a Verifier change and `task.review_requested` can open a Verify
 * item; a move to `stuck` and `task.stuck` can open a Stuck item. Everything
 * else opens nothing, so it is never evaluated.
 */
export function wakeKindsOpenedBy(event: Pick<FeedEvent, 'name' | 'objectType' | 'payload'>): Array<'verify' | 'stuck'> {
  if (event.objectType !== 'task') return [];
  if (event.name === 'task.review_requested') return ['verify'];
  if (event.name === 'task.stuck') return ['stuck'];
  if (event.name !== 'task.updated' && event.name !== 'task.created') return [];
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const kinds: Array<'verify' | 'stuck'> = [];
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  if (payload.status === 'review' || fields.includes('verifierPrincipalId')) kinds.push('verify');
  if (payload.status === 'stuck') kinds.push('stuck');
  return kinds;
}

export interface ConnectorWakeConfig {
  /** Milliseconds between passes (scan, attempts, prune). */
  intervalMs: number;
  /** Sends attempted before an unacknowledged wake settles. */
  maxAttempts: number;
  /** Wait after attempt N is base * 2^(N-1), capped at backoffMaxMs. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** In-flight wakes per Connector; the feed cursor waits rather than drops. */
  maxPendingPerEndpoint: number;
  /** Endpoints remembered by this process. */
  maxEndpoints: number;
  /** How long an endpoint with no open socket is remembered. */
  offlineRetentionMs: number;
}

export const DEFAULT_WAKE_CONFIG: ConnectorWakeConfig = {
  intervalMs: 1000,
  maxAttempts: 4,
  backoffBaseMs: 1000,
  backoffMaxMs: 8000,
  maxPendingPerEndpoint: 64,
  maxEndpoints: 128,
  offlineRetentionMs: 24 * 60 * 60 * 1000,
};

/** The wait after attempt `attempt` (1-based) before the next attempt or settlement. */
export function wakeBackoffMs(attempt: number, config: ConnectorWakeConfig = DEFAULT_WAKE_CONFIG): number {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** (n - 1));
}

/** The whole budget, first send to settlement, for documentation and tests. */
export function wakeBudgetMs(config: ConnectorWakeConfig = DEFAULT_WAKE_CONFIG): number {
  let total = 0;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) total += wakeBackoffMs(attempt, config);
  return total;
}

export { parseWakeAck, WAKE_ACK_MAX_BYTES, type WakeAck };

export interface ReportedModel {
  provider?: string;
  requested?: string;
  resolved?: string;
  operation?: string;
}

export interface ReportedIdentity {
  /** The envelope's own identifiers, exactly as validated — never derived. */
  kind: string;
  phase: string | null;
  eventId: string | null;
  source: { product: string; adapter: string; adapterVersion: string | null };
  model: ReportedModel | null;
}

/** Which model claim the Connector actually made — see the header. */
export function modelIdentityOf(model: ReportedModel | null | undefined): ModelIdentity {
  if (model?.resolved) return 'provider-reported';
  if (model?.requested) return 'requested-only';
  return 'not-reported';
}

/** Copy the Connector-reported identity out of a VALIDATED envelope. */
export function reportedIdentityOf(envelope: TelemetryEnvelope): ReportedIdentity {
  const model: ReportedModel = {};
  for (const field of ['provider', 'requested', 'resolved', 'operation'] as const) {
    const value = envelope.model?.[field];
    if (typeof value === 'string' && value.length > 0) model[field] = value;
  }
  return {
    kind: String(envelope.kind),
    phase: envelope.phase ?? null,
    eventId: envelope.event_id ?? null,
    source: {
      product: envelope.source.product,
      adapter: envelope.source.adapter,
      adapterVersion: envelope.source.adapter_version ?? null,
    },
    model: Object.keys(model).length > 0 ? model : null,
  };
}

export type WakeTelemetryOutcome =
  | { stored: true; eventId: string | null; duplicate: boolean }
  | { stored: false; stage: string; code: string };

export interface WakeReceipt {
  wakeId: string;
  /** The wake kind (`implement` for every protocol-1 wake). */
  kind: WakeKind;
  outcome: WakeOutcome;
  serviceId: string;
  connectorPrincipalId: string;
  taskId: string;
  /** The feed cursor the wake was raised for. */
  feedCursor: string;
  attempts: number;
  /** Attempts that found an open socket and sent the frame. */
  sends: number;
  firstSentAt: string | null;
  acknowledgedAt: string | null;
  /** First send to acknowledgement, board clock. */
  latencyMs: number | null;
  settledAt: string;
  /** Null when acknowledged; otherwise the path the work still has. */
  fallback: 'polling' | null;
  /** For `superseded`: the Task status the board read when it withdrew the wake. */
  taskStatus: string | null;
  modelIdentity: ModelIdentity;
  reported: ReportedIdentity | null;
  telemetry: WakeTelemetryOutcome;
}

export interface PendingWake {
  wakeId: string;
  kind: WakeKind;
  serviceId: string;
  principalId: string;
  taskId: string;
  feedCursor: string;
  attempts: number;
  sends: number;
  firstSentAt: number | null;
  nextAttemptAt: number;
  settling: boolean;
  /** `verify`/`stuck`: the occurrence rung (the item's `since`, and for `verify` its Verifier); null for `implement`. */
  occurrence: string | null;
  /** `verify`: the Task's Verifier when the wake was raised; the wake is withdrawn when it changes. */
  verifierPrincipalId: string | null;
}

const NOT_ACKNOWLEDGED: WakeTelemetryOutcome = { stored: false, stage: 'wake', code: 'NOT_ACKNOWLEDGED' };
const NOT_REPORTED: WakeTelemetryOutcome = { stored: false, stage: 'ack', code: 'NOT_REPORTED' };

/** Pure receipt shaping: everything the audit row and the stream entry carry. */
export function buildWakeReceipt(
  wake: PendingWake,
  outcome: WakeOutcome,
  settledAt: number,
  detail: {
    acknowledgedAt?: number | null;
    taskStatus?: string | null;
    reported?: ReportedIdentity | null;
    telemetry?: WakeTelemetryOutcome;
  } = {},
): WakeReceipt {
  const acknowledged = outcome === 'acknowledged';
  const acknowledgedAt = acknowledged ? detail.acknowledgedAt ?? settledAt : null;
  const reported = acknowledged ? detail.reported ?? null : null;
  return {
    wakeId: wake.wakeId,
    kind: wake.kind,
    outcome,
    serviceId: wake.serviceId,
    connectorPrincipalId: wake.principalId,
    taskId: wake.taskId,
    feedCursor: wake.feedCursor,
    attempts: wake.attempts,
    sends: wake.sends,
    firstSentAt: wake.firstSentAt === null ? null : new Date(wake.firstSentAt).toISOString(),
    acknowledgedAt: acknowledgedAt === null ? null : new Date(acknowledgedAt).toISOString(),
    latencyMs: acknowledgedAt !== null && wake.firstSentAt !== null
      ? Math.max(0, acknowledgedAt - wake.firstSentAt) : null,
    settledAt: new Date(settledAt).toISOString(),
    fallback: acknowledged ? null : 'polling',
    taskStatus: outcome === 'superseded' ? detail.taskStatus ?? null : null,
    modelIdentity: modelIdentityOf(reported?.model),
    reported,
    telemetry: acknowledged ? detail.telemetry ?? NOT_REPORTED : NOT_ACKNOWLEDGED,
  };
}

/** Who a wake of each kind rings, in the board's own words. */
const KIND_ADDRESSEE: Record<WakeKind, string> = {
  implement: 'the assigned connector',
  verify: 'the Verifier connector',
  stuck: 'the addressed connector',
};

/**
 * Board-composed stream text. Connector-supplied values appear only as model
 * names, which the envelope validator has already bounded to a space-free
 * name class; everything else is the board's own words. The `implement` texts
 * are unchanged from protocol 1.
 */
export function wakeStreamContent(receipt: WakeReceipt): string {
  const sends = `${receipt.sends} send${receipt.sends === 1 ? '' : 's'}`;
  const kind = receipt.kind ?? 'implement';
  const prefix = kind === 'implement' ? 'Wake' : `${kind === 'verify' ? 'Verify' : 'Stuck'} wake`;
  const addressee = KIND_ADDRESSEE[kind] ?? KIND_ADDRESSEE.implement;
  switch (receipt.outcome) {
    case 'acknowledged': {
      const model = receipt.reported?.model;
      const identity = receipt.modelIdentity === 'provider-reported'
        ? `connector-reported provider model ${model?.resolved}${model?.provider ? ` (${model.provider})` : ''}`
        : receipt.modelIdentity === 'requested-only'
          ? `connector reported only the requested model ${model?.requested}; no provider-reported model`
          : 'no model identity reported';
      return `${prefix} acknowledged by ${addressee} after ${sends} in ${receipt.latencyMs ?? 0} ms; ${identity}.`;
    }
    case 'unanswered':
      return kind === 'implement'
        ? `Wake sent to the assigned connector (${sends} over ${receipt.attempts} attempts) and not acknowledged; the task falls back to polling.`
        : `${prefix} sent to ${addressee} (${sends} over ${receipt.attempts} attempts) and not acknowledged; the item stays on its action list.`;
    case 'offline':
      return kind === 'implement'
        ? `The assigned connector had no open notification socket across ${receipt.attempts} wake attempts; the task falls back to polling.`
        : `${addressee.charAt(0).toUpperCase()}${addressee.slice(1)} had no open wake=2 socket across ${receipt.attempts} ${kind} wake attempts; the item stays on its action list.`;
    case 'superseded':
      if (kind === 'verify') {
        return `Verify wake withdrawn before an acknowledgement: the task left Review, its Verifier changed or the item closed (status ${receipt.taskStatus ?? 'unknown'}).`;
      }
      if (kind === 'stuck') {
        return `Stuck wake withdrawn before an acknowledgement: the Stuck item closed (status ${receipt.taskStatus ?? 'unknown'}).`;
      }
      return `Wake withdrawn before an acknowledgement: the task left the ready state for this connector (status ${receipt.taskStatus ?? 'unknown'}).`;
    default:
      return 'Wake settled.';
  }
}

const SYSTEM_ACTOR: AuditActor = { handle: 'system', authMethod: 'system' };

export function wakeAuditWrite(receipt: WakeReceipt, actor: AuditActor): AuditWrite {
  return {
    action: `connector.wake.${receipt.outcome}`,
    actor,
    resourceType: 'task',
    resourceId: receipt.taskId,
    outcome: 'success',
    metadata: { ...receipt },
  };
}

/** What a Connector reported it did with an acknowledged wake (design section 6.7). */
export interface TriggerReceipt {
  wakeId: string;
  kind: WakeKind;
  outcome: WakeTriggerOutcome;
  /** A code (WAKE_TRIGGER_REASON), never prose. */
  reason: string | null;
  serviceId: string;
  connectorPrincipalId: string;
  taskId: string;
  reportedAt: string;
}

/** Board-composed text; the only Connector-supplied value is the reason code, held to an upper-case identifier. */
export function triggerStreamContent(receipt: TriggerReceipt): string {
  const reason = receipt.reason ? ` (${receipt.reason})` : '';
  switch (receipt.outcome) {
    case 'started':
      return `The connector reported that it started a run for its ${receipt.kind} wake${reason}.`;
    case 'refused':
      return `The connector reported that it refused to act on its ${receipt.kind} wake${reason}.`;
    case 'notified':
      return `The connector reported that it notified a person instead of running for its ${receipt.kind} wake${reason}.`;
    case 'finished':
      return `The connector reported that the run for its ${receipt.kind} wake finished${reason}.`;
    default:
      return 'The connector reported a trigger outcome.';
  }
}

export function triggerAuditWrite(receipt: TriggerReceipt, actor: AuditActor): AuditWrite {
  return {
    action: `connector.trigger.${receipt.outcome}`,
    actor,
    resourceType: 'task',
    resourceId: receipt.taskId,
    outcome: 'success',
    metadata: { ...receipt },
  };
}

/** The socket's authenticated identity, re-derived for the acknowledgement. */
export interface WakeAckIdentity {
  principalId: string;
  handle: string;
  credentialId: string | null;
  delegationLinks: DelegationActorLink[] | null;
  /** The live actor, for the telemetry route ceiling. */
  actor: AuthorizationActor;
}

/**
 * Ingest the acknowledgement's envelope exactly as `POST /telemetry/events`
 * would for the same credential: validate, require the route's own scope
 * (`telemetry:write`), derive the binding from the authenticated chain,
 * require a declared product, spend the receiver limit, then store through
 * the one entry point. Every refusal is returned, never thrown, so the
 * receipt can say why nothing was stored.
 */
export async function ingestWakeTelemetry(
  identity: WakeAckIdentity,
  envelope: Record<string, unknown>,
): Promise<{ reported: ReportedIdentity | null; telemetry: WakeTelemetryOutcome }> {
  const validation = validateTelemetryEnvelope(envelope);
  if (!validation.ok) {
    return { reported: null, telemetry: { stored: false, stage: 'validation', code: validation.code } };
  }
  const reported = reportedIdentityOf(validation.envelope);
  const ceiling = authorizationService.authorizeRoute(identity.actor, requiredScopeFor('POST', '/telemetry/events'));
  if (!ceiling.allowed) {
    return { reported, telemetry: { stored: false, stage: 'scope', code: 'TELEMETRY_SCOPE_REQUIRED' } };
  }
  try {
    const derived = await telemetryPrincipalService.derive({
      actingPrincipalId: identity.principalId,
      delegationLinks: identity.delegationLinks,
    });
    if (!derived.ok) return { reported, telemetry: { stored: false, stage: 'principal', code: derived.code } };
    if (!productIsDeclared(derived.descriptor, reported.source.product)) {
      return { reported, telemetry: { stored: false, stage: 'descriptor', code: 'TELEMETRY_PRODUCT_NOT_DECLARED' } };
    }
    const decision = await telemetryRateLimitService.tryAccept(
      derived.binding.agentId ?? derived.binding.connectorId, 'events',
    );
    if (!decision.accepted) return { reported, telemetry: { stored: false, stage: 'rate', code: 'RATE_LIMITED' } };
    const stored = await telemetryEnvelopeStore.store(derived.binding, envelope);
    if (!stored.accepted) return { reported, telemetry: { stored: false, stage: stored.stage, code: stored.code } };
    return { reported, telemetry: { stored: true, eventId: stored.eventId, duplicate: stored.duplicate } };
  } catch (err) {
    logCaughtFailure('[ConnectorWake] acknowledgement telemetry ingest failed', err);
    return { reported, telemetry: { stored: false, stage: 'internal', code: 'TELEMETRY_INGEST_FAILED' } };
  }
}

export type WakeAttachResult =
  | { enabled: true; serviceId: string }
  | { enabled: false; reason: 'NOT_A_PUBLISHED_CONNECTOR' | 'AMBIGUOUS_CONNECTOR' | 'WAKE_CAPACITY' | 'WAKE_UNAVAILABLE' };

interface WakeEndpoint {
  serviceId: string;
  principalId: string;
  cursor: string;
  /** Each open socket and the protocol it subscribed with: the endpoint is rung for
   * `verify` and `stuck` while any open socket is protocol 2 (`speaksProtocol2`). */
  sockets: Map<WebSocket, WakeProtocol>;
  lastClosedAt: number | null;
}

/** An acknowledged protocol-2 wake that may still report what the Connector did with it. */
interface OutcomeWake {
  wakeId: string;
  kind: WakeKind;
  taskId: string;
  serviceId: string;
  principalId: string;
  socket: WebSocket;
  started: boolean;
}

/** What the wake reads about a Task besides the item itself: its Verifier, and whether it is the Connector's own work. */
interface TaskFacts {
  status: string;
  verifierPrincipalId: string | null;
  ownWork: boolean;
}

export interface ConnectorWakeDeps {
  feed: Pick<FeedEventService, 'listSince'>;
  subscribers: Pick<SubscriberActorService, 'actorForConnector'>;
  audit: Pick<AuditService, 'record'>;
  ingestTelemetry: typeof ingestWakeTelemetry;
  clock: () => number;
  /** The Action Center's per-Task form: the one source of the `verify` and `stuck` predicates. */
  actions: Pick<NotificationActionsService, 'openTaskItems'>;
  /** The task read scope of an actor (the shared list predicate). */
  taskScope: (actor: AuthorizationActor) => AuthorizationListScope<'task'>;
  /** May this actor read this Task now (the shared point predicate)? */
  canReadTask: (actor: AuthorizationActor, taskId: string) => Promise<boolean>;
}

export class ConnectorWakeService {
  private readonly endpoints = new Map<string, WakeEndpoint>();
  private readonly pending = new Map<string, PendingWake>();
  private readonly outcomeWakes = new Map<string, OutcomeWake>();
  /** (Task, kind, principal) -> the occurrence last rung, so an open item is rung once. */
  private readonly rung = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly deps: ConnectorWakeDeps;

  constructor(
    private readonly pool: Pool = defaultPool,
    private readonly config: ConnectorWakeConfig = DEFAULT_WAKE_CONFIG,
    deps: Partial<ConnectorWakeDeps> = {},
  ) {
    this.deps = {
      feed: feedEventService,
      subscribers: subscriberActorService,
      audit: auditService,
      ingestTelemetry: ingestWakeTelemetry,
      clock: () => Date.now(),
      actions: notificationActionsService,
      taskScope: (actor) => authorizationRepository.listScope(actor, 'task', 'read'),
      canReadTask: async (actor, taskId) =>
        (await authorizationRepository.authorizedIds(actor, 'task', [taskId], 'read')).has(taskId),
      ...deps,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runPass().catch((err) => logCaughtFailure('[ConnectorWake] pass failed', err));
    }, this.config.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** In-flight wakes, for operators and tests. Never includes settled ones. */
  pendingWakes(): PendingWake[] {
    return [...this.pending.values()].map((wake) => ({ ...wake }));
  }

  /**
   * Register an authenticated `wake=1` or `wake=2` socket. The endpoint is the
   * PUBLISHED Connector registered for this principal; anything else is told
   * why it gets no wakes and keeps its ordinary event stream.
   */
  async attach(ws: WebSocket, principalId: string, protocol: WakeProtocol = 1): Promise<WakeAttachResult> {
    const services = await this.pool.query(
      `SELECT id FROM services
        WHERE principal_id = $1 AND kind = 'connector' AND status = 'published'
        ORDER BY id LIMIT 2`,
      [principalId],
    );
    if (services.rows.length === 0) return { enabled: false, reason: 'NOT_A_PUBLISHED_CONNECTOR' };
    if (services.rows.length > 1) return { enabled: false, reason: 'AMBIGUOUS_CONNECTOR' };
    const serviceId = String(services.rows[0].id);

    let endpoint = this.endpoints.get(principalId);
    if (!endpoint || endpoint.serviceId !== serviceId) {
      // A new endpoint starts at the feed HEAD: wakes are for readiness that
      // happens from now on, never a replay of retained history.
      const head = await this.pool.query('SELECT COALESCE(MAX(cursor), 0)::text AS cursor FROM feed_events');
      // Re-read after the await: a sibling socket may have registered first.
      const existing = this.endpoints.get(principalId);
      if (existing && existing.serviceId === serviceId) {
        endpoint = existing;
      } else {
        if (!existing && this.endpoints.size >= this.config.maxEndpoints && !this.evictOneOffline()) {
          return { enabled: false, reason: 'WAKE_CAPACITY' };
        }
        endpoint = {
          serviceId, principalId, cursor: String(head.rows[0]?.cursor ?? '0'),
          sockets: existing?.sockets ?? new Map<WebSocket, WakeProtocol>(), lastClosedAt: null,
        };
        this.endpoints.set(principalId, endpoint);
      }
    }
    // The socket may have closed while the lookups ran; never hold a dead one.
    if (ws.readyState !== WebSocket.OPEN) return { enabled: false, reason: 'WAKE_UNAVAILABLE' };
    endpoint.sockets.set(ws, protocol);
    endpoint.lastClosedAt = null;
    return { enabled: true, serviceId };
  }

  detach(ws: WebSocket, principalId: string): void {
    // A closed socket reports no outcome: its acknowledged wakes are forgotten.
    for (const [wakeId, wake] of this.outcomeWakes) if (wake.socket === ws) this.outcomeWakes.delete(wakeId);
    const endpoint = this.endpoints.get(principalId);
    if (!endpoint || !endpoint.sockets.delete(ws)) return;
    if (endpoint.sockets.size === 0) endpoint.lastClosedAt = this.deps.clock();
  }

  /**
   * Settle a wake the board sent to this principal. Returns false — and
   * changes nothing — for an id that is unknown, already settled, issued to
   * another principal, or never actually sent. `via` names the protocol-2
   * socket the acknowledgement arrived on; without it the acknowledgement is
   * a protocol-1 one, which settles `implement` wakes only. A protocol-2
   * acknowledgement leaves the wake able to report its outcome on that socket.
   */
  async acknowledge(identity: WakeAckIdentity, ack: WakeAck, via?: { socket: WebSocket }): Promise<boolean> {
    const wake = this.pending.get(ack.wakeId);
    if (!wake || wake.settling || wake.principalId !== identity.principalId || wake.sends === 0) return false;
    const protocol: WakeProtocol | null = via
      ? this.endpoints.get(identity.principalId)?.sockets.get(via.socket) ?? null
      : 1;
    if (protocol === null || (wake.kind !== 'implement' && protocol !== 2)) return false;
    wake.settling = true;
    const acknowledgedAt = this.deps.clock();
    const ingested = ack.telemetry
      ? await this.deps.ingestTelemetry(identity, ack.telemetry)
      : { reported: null, telemetry: NOT_REPORTED };
    await this.settle(wake, 'acknowledged', {
      acknowledgedAt, reported: ingested.reported, telemetry: ingested.telemetry,
    }, {
      principalId: identity.principalId,
      handle: identity.handle,
      authMethod: 'principal_api_key',
      credentialId: identity.credentialId,
    });
    if (via && protocol === 2) this.rememberOutcomeWake(wake, via.socket);
    return true;
  }

  /**
   * Record what the Connector reported it did with a wake (design section
   * 6.7). Returns false — and writes nothing — unless the wake was
   * acknowledged on THIS socket by this principal, the outcome is next in
   * order (`started` before `finished`; `refused`, `notified` and `finished`
   * end the wake), and the Connector can still read the Task now.
   */
  async recordOutcome(identity: WakeAckIdentity, report: WakeOutcomeReport, socket: WebSocket): Promise<boolean> {
    const wake = this.outcomeWakes.get(report.wakeId);
    if (!wake || wake.principalId !== identity.principalId || wake.socket !== socket) return false;
    if (report.outcome === 'finished' ? !wake.started : wake.started) return false;
    // A stream write never outlives the read: the Connector must still see the Task.
    const readable = await this.deps.canReadTask(identity.actor, wake.taskId);
    if (this.outcomeWakes.get(report.wakeId) !== wake) return false;
    if (!readable) {
      this.outcomeWakes.delete(report.wakeId);
      return false;
    }
    if (report.outcome === 'started') wake.started = true;
    else this.outcomeWakes.delete(report.wakeId);
    const receipt: TriggerReceipt = {
      wakeId: wake.wakeId,
      kind: wake.kind,
      outcome: report.outcome,
      reason: report.reason,
      serviceId: wake.serviceId,
      connectorPrincipalId: wake.principalId,
      taskId: wake.taskId,
      reportedAt: new Date(this.deps.clock()).toISOString(),
    };
    await this.writeEntry(
      triggerAuditWrite(receipt, {
        principalId: identity.principalId,
        handle: identity.handle,
        authMethod: 'principal_api_key',
        credentialId: identity.credentialId,
      }),
      TRIGGER_STREAM_EVENT_TYPE, triggerStreamContent(receipt), receipt, '[ConnectorWake] trigger outcome write failed',
    );
    return true;
  }

  /** One pass: discover new ready work, make due attempts, forget stale endpoints. */
  async runPass(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const endpoint of [...this.endpoints.values()]) {
        try {
          await this.scan(endpoint);
        } catch (err) {
          logCaughtFailure('[ConnectorWake] ready-work scan failed', err);
        }
      }
      for (const wake of [...this.pending.values()]) {
        if (wake.settling || this.deps.clock() < wake.nextAttemptAt) continue;
        try {
          await this.attempt(wake);
        } catch (err) {
          logCaughtFailure('[ConnectorWake] wake attempt failed', err);
        }
      }
      this.prune();
    } finally {
      this.running = false;
    }
  }

  private async scan(endpoint: WakeEndpoint): Promise<void> {
    const inFlight = [...this.pending.values()].filter((wake) => wake.serviceId === endpoint.serviceId);
    let room = this.config.maxPendingPerEndpoint - inFlight.length;
    // Backpressure, not loss: the cursor does not move while there is no room.
    if (room <= 0) return;

    const actorResult = await this.deps.subscribers.actorForConnector(endpoint.serviceId);
    if (!actorResult.ok || actorResult.principalId !== endpoint.principalId) return;
    const ceiling = authorizationService.authorizeRoute(
      actorResult.actor, requiredScopeFor('GET', DELIVERY_MIRRORED_PATH),
    );
    if (!ceiling.allowed) return;

    const page = await this.deps.feed.listSince(actorResult.actor, endpoint.cursor, Math.min(200, room));
    const ready = page.events.filter((event) => event.objectType === 'task'
      && GO_SIGNAL_EVENTS.includes(event.name as typeof GO_SIGNAL_EVENTS[number]));
    let assignedIds = new Set<string>();
    if (ready.length > 0) {
      const assigned = await this.pool.query(
        `SELECT id FROM tasks WHERE id = ANY($1::uuid[]) AND execution_service_id = $2`,
        [[...new Set(ready.map((event) => String(event.objectId)))], endpoint.serviceId],
      );
      assignedIds = new Set(assigned.rows.map((row: any) => String(row.id)));
    }
    // Protocol 2 only: the Verify and Stuck items these events may have opened.
    const kinds = speaksProtocol2(endpoint)
      ? await this.openKinds(endpoint, actorResult.actor, page.events)
      : null;
    const now = this.deps.clock();
    let cursor = page.nextCursor;
    let handled = endpoint.cursor;
    for (const event of page.events) {
      const taskId = String(event.objectId);
      const raise: Array<{ kind: WakeKind; occurrence: string | null; verifierPrincipalId: string | null }> = [];
      if (ready.includes(event) && assignedIds.has(taskId)
        && !inFlight.some((wake) => wake.taskId === taskId && wake.kind === 'implement')) {
        raise.push({ kind: 'implement', occurrence: null, verifierPrincipalId: null });
      }
      if (kinds) {
        for (const kind of wakeKindsOpenedBy(event)) {
          const open = kinds.occurrence(kind, taskId);
          if (!open) continue;
          if (raise.some((item) => item.kind === kind)) continue;
          const key = this.rungKey(taskId, kind, endpoint.principalId);
          const flying = inFlight.find((wake) => wake.taskId === taskId && wake.kind === kind);
          if (flying && flying.occurrence === open.occurrence) continue;
          if (!flying && this.rung.get(key) === open.occurrence) continue;
          raise.push({ kind, occurrence: open.occurrence, verifierPrincipalId: open.verifierPrincipalId });
        }
      }
      if (raise.length > room) {
        // No room for every wake this event raises: stop before it, so the
        // next pass reads it again rather than losing part of it.
        cursor = handled;
        break;
      }
      for (const item of raise) {
        const flying = inFlight.find((wake) => wake.taskId === taskId && wake.kind === item.kind);
        if (flying) {
          // A new occurrence of the same item replaces the one still in flight
          // (unless its acknowledgement is being settled right now).
          if (!flying.settling) {
            await this.settle(flying, 'superseded', { taskStatus: kinds?.status(taskId) ?? null }, SYSTEM_ACTOR);
          }
          inFlight.splice(inFlight.indexOf(flying), 1);
          room += 1;
        }
        const wake: PendingWake = {
          wakeId: randomUUID(),
          kind: item.kind,
          serviceId: endpoint.serviceId,
          principalId: endpoint.principalId,
          taskId,
          feedCursor: String(event.cursor),
          attempts: 0,
          sends: 0,
          firstSentAt: null,
          nextAttemptAt: now,
          settling: false,
          occurrence: item.occurrence,
          verifierPrincipalId: item.verifierPrincipalId,
        };
        this.pending.set(wake.wakeId, wake);
        inFlight.push(wake);
        room -= 1;
        if (item.kind !== 'implement' && item.occurrence !== null) {
          this.remember(this.rungKey(taskId, item.kind, endpoint.principalId), item.occurrence);
        }
      }
      handled = String(event.cursor);
    }
    endpoint.cursor = cursor;
  }

  private rungKey(taskId: string, kind: WakeKind, principalId: string): string {
    return `${taskId}|${kind}|${principalId}`;
  }

  private remember(key: string, occurrence: string): void {
    this.rung.delete(key);
    this.rung.set(key, occurrence);
    while (this.rung.size > RUNG_OCCURRENCES_LIMIT) {
      const oldest = this.rung.keys().next().value;
      if (oldest === undefined) break;
      this.rung.delete(oldest);
    }
  }

  /** The Action Center viewer for a Connector's own actor: a bearer, never a session. */
  private kindsViewer(principalId: string, actor: AuthorizationActor): ActionsViewer {
    return {
      principalId,
      isSession: false,
      taskScope: this.deps.taskScope(actor),
      projectScope: null,
      hub: {
        principalId,
        isRoot: scopesSatisfy(actor.scopes, 'root'),
        administratorOk: false,
        principalKind: null,
        scopes: actor.scopes,
        actor,
        authMethod: 'principal_api_key',
      },
    };
  }

  /**
   * The Task's Verifier and whether it is the Connector's own work: the
   * Connector is in G(Task), or the Task's exact Verifier is a non-person the
   * chain guard refuses (design section 6.8; the one guard SQL).
   */
  private async taskFacts(taskIds: string[], endpoint: Pick<WakeEndpoint, 'serviceId' | 'principalId'>): Promise<Map<string, TaskFacts>> {
    const facts = new Map<string, TaskFacts>();
    if (taskIds.length === 0) return facts;
    const result = await this.pool.query(
      `SELECT t.id::text AS id, t.status, t.verifier_principal_id::text AS verifier_id,
              ($2::uuid IN ${guardedPrincipalsSql('t.id')} OR ${exactVerifierGuardedSql('t.id')}) AS own_work
         FROM tasks t
        WHERE t.id = ANY($1::uuid[])`,
      [taskIds, endpoint.principalId],
    );
    for (const row of result.rows) {
      facts.set(String(row.id), {
        status: String(row.status),
        verifierPrincipalId: row.verifier_id ? String(row.verifier_id) : null,
        ownWork: row.own_work === true,
      });
    }
    return facts;
  }

  /**
   * Which Verify and Stuck items are open for this Connector now, for the
   * Tasks these events could have opened one on. Read under the Connector's
   * own actor and the `GET /notifications/actions` ceiling (the pull these
   * kinds mirror), through the Action Center's per-Task form.
   */
  private async openKinds(
    endpoint: Pick<WakeEndpoint, 'serviceId' | 'principalId'>,
    actor: AuthorizationActor,
    events: Array<Pick<FeedEvent, 'name' | 'objectType' | 'objectId' | 'payload'>>,
  ): Promise<{
    occurrence: (kind: 'verify' | 'stuck', taskId: string) => { occurrence: string; verifierPrincipalId: string | null } | null;
    status: (taskId: string) => string | null;
  }> {
    const ids = [...new Set(events.filter((event) => wakeKindsOpenedBy(event).length > 0)
      .map((event) => String(event.objectId)))];
    const none = { occurrence: () => null, status: () => null };
    if (ids.length === 0) return none;
    if (!authorizationService.authorizeRoute(actor, requiredScopeFor('GET', '/notifications/actions')).allowed) return none;
    const open = await this.deps.actions.openTaskItems(this.kindsViewer(endpoint.principalId, actor), ids);
    const facts = await this.taskFacts(ids, endpoint);
    return {
      occurrence: (kind, taskId) => {
        const fact = facts.get(taskId);
        if (!fact) return null;
        if (kind === 'verify') {
          const item = open.verify.get(taskId);
          if (!item || !item.reasons.some((reason) => VERIFY_WAKE_REASONS.includes(reason))) return null;
          // Never ring a Connector to verify its own work (see the header).
          if (fact.ownWork) return null;
          return { occurrence: verifyOccurrence(item, fact.verifierPrincipalId), verifierPrincipalId: fact.verifierPrincipalId };
        }
        const item = open.stuck.get(taskId);
        return item ? { occurrence: item.since, verifierPrincipalId: null } : null;
      },
      status: (taskId) => facts.get(taskId)?.status ?? null,
    };
  }

  /**
   * The `verify`/`stuck` withdrawal rule (design section 6.1, B4), re-read
   * under the Connector's CURRENT actor before every send: the item is still
   * open for this Connector and, for `verify`, its Verifier is the one the
   * wake was raised for. Anything else withdraws the wake. (A new occurrence of
   * the same item is raised by the scan, which replaces the one in flight.)
   */
  private async kindStillOpen(wake: PendingWake): Promise<{ open: boolean; taskStatus: string | null }> {
    const endpoint = { serviceId: wake.serviceId, principalId: wake.principalId };
    const facts = await this.taskFacts([wake.taskId], endpoint);
    const taskStatus = facts.get(wake.taskId)?.status ?? null;
    const actorResult = await this.deps.subscribers.actorForConnector(wake.serviceId);
    if (!actorResult.ok || actorResult.principalId !== wake.principalId) return { open: false, taskStatus };
    if (!authorizationService.authorizeRoute(actorResult.actor, requiredScopeFor('GET', DELIVERY_MIRRORED_PATH)).allowed) {
      return { open: false, taskStatus };
    }
    const kinds = await this.openKinds(endpoint, actorResult.actor, [{
      name: wake.kind === 'verify' ? 'task.review_requested' : 'task.stuck',
      objectType: 'task', objectId: wake.taskId, payload: {},
    }]);
    // The item closed (left Review, episode over) or is no longer this Connector's to see.
    const itemOpen = kinds.occurrence(wake.kind as 'verify' | 'stuck', wake.taskId) !== null;
    // `verify` only: the Verifier is still the one the wake was raised for.
    const sameVerifier = wake.kind !== 'verify'
      || (facts.get(wake.taskId)?.verifierPrincipalId ?? null) === wake.verifierPrincipalId;
    return { open: itemOpen && sameVerifier, taskStatus };
  }

  private async attempt(wake: PendingWake): Promise<void> {
    if (wake.attempts >= this.config.maxAttempts) {
      await this.settle(wake, wake.sends > 0 ? 'unanswered' : 'offline', {}, SYSTEM_ACTOR);
      return;
    }
    if (wake.kind === 'implement') {
      // Still this Connector's ready work? Claimed, reassigned, disarmed or
      // moved on: the wake is withdrawn and says so, rather than ringing on.
      const current = await this.pool.query(
        'SELECT status, auto_start, execution_service_id FROM tasks WHERE id = $1',
        [wake.taskId],
      );
      if (wake.settling) return;
      const row = current.rows[0];
      if (!row || String(row.execution_service_id ?? '') !== wake.serviceId
        || row.status !== 'todo' || row.auto_start !== true) {
        await this.settle(wake, 'superseded', { taskStatus: row ? String(row.status) : null }, SYSTEM_ACTOR);
        return;
      }
    } else {
      const still = await this.kindStillOpen(wake);
      if (wake.settling) return;
      if (!still.open) {
        await this.settle(wake, 'superseded', { taskStatus: still.taskStatus }, SYSTEM_ACTOR);
        return;
      }
    }
    wake.attempts += 1;
    const now = this.deps.clock();
    const endpoint = this.endpoints.get(wake.principalId);
    const open = endpoint
      ? [...endpoint.sockets].filter(([ws, protocol]) => ws.readyState === WebSocket.OPEN
        && ws.bufferedAmount <= SOCKET_BUFFER_LIMIT && (wake.kind === 'implement' || protocol === 2))
      : [];
    if (open.length > 0) {
      const v1 = JSON.stringify({
        type: 'wake', wakeId: wake.wakeId, taskId: wake.taskId, cursor: wake.feedCursor, attempt: wake.attempts,
      });
      const v2 = JSON.stringify({
        type: 'wake', wakeId: wake.wakeId, taskId: wake.taskId, kind: wake.kind, cursor: wake.feedCursor, attempt: wake.attempts,
      });
      for (const [ws, protocol] of open) ws.send(protocol === 2 ? v2 : v1, () => undefined);
      wake.sends += 1;
      if (wake.firstSentAt === null) wake.firstSentAt = now;
    }
    wake.nextAttemptAt = now + wakeBackoffMs(wake.attempts, this.config);
  }

  private rememberOutcomeWake(wake: PendingWake, socket: WebSocket): void {
    const ofSocket = [...this.outcomeWakes.values()].filter((entry) => entry.socket === socket);
    if (ofSocket.length >= OUTCOME_WAKES_PER_SOCKET) this.outcomeWakes.delete(ofSocket[0].wakeId);
    this.outcomeWakes.set(wake.wakeId, {
      wakeId: wake.wakeId, kind: wake.kind, taskId: wake.taskId, serviceId: wake.serviceId,
      principalId: wake.principalId, socket, started: false,
    });
  }

  private async settle(
    wake: PendingWake,
    outcome: WakeOutcome,
    detail: Parameters<typeof buildWakeReceipt>[3],
    actor: AuditActor,
  ): Promise<void> {
    wake.settling = true;
    this.pending.delete(wake.wakeId);
    const receipt = buildWakeReceipt(wake, outcome, this.deps.clock(), detail);
    await this.writeEntry(
      wakeAuditWrite(receipt, actor), WAKE_STREAM_EVENT_TYPE, wakeStreamContent(receipt), receipt,
      '[ConnectorWake] receipt write failed',
    );
  }

  /** The audit row and the `system` stream entry, in one transaction. */
  private async writeEntry(
    audit: AuditWrite,
    eventType: string,
    content: string,
    metadata: WakeReceipt | TriggerReceipt,
    failure: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.deps.audit.record(audit, client);
      await client.query(
        `INSERT INTO task_stream_entries (task_id, provenance, event_type, content, metadata)
         VALUES ($1, 'system', $2, $3, $4)`,
        [metadata.taskId, eventType, content, metadata],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      logCaughtFailure(failure, err);
    } finally {
      client.release();
    }
  }

  /** Evict the longest-offline endpoint with nothing in flight, if any. */
  private evictOneOffline(): boolean {
    let oldest: WakeEndpoint | null = null;
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.sockets.size > 0 || endpoint.lastClosedAt === null) continue;
      if ([...this.pending.values()].some((wake) => wake.principalId === endpoint.principalId)) continue;
      if (!oldest || endpoint.lastClosedAt < (oldest.lastClosedAt ?? 0)) oldest = endpoint;
    }
    if (!oldest) return false;
    this.endpoints.delete(oldest.principalId);
    return true;
  }

  private prune(): void {
    const now = this.deps.clock();
    for (const endpoint of [...this.endpoints.values()]) {
      if (endpoint.sockets.size > 0 || endpoint.lastClosedAt === null) continue;
      if (now - endpoint.lastClosedAt < this.config.offlineRetentionMs) continue;
      if ([...this.pending.values()].some((wake) => wake.principalId === endpoint.principalId)) continue;
      this.endpoints.delete(endpoint.principalId);
    }
  }
}

export const connectorWakeService = new ConnectorWakeService();
