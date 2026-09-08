/**
 * NotificationEndpointService — RH-P3.C8: the human notification path's
 * per-person endpoint configuration and its exception-event dispatch
 * (strategy 4e40f06f §2.12).
 *
 * SUBSCRIPTION-CLASS DATA: writes reach this service only through the
 * root-sentinel route family, and every mutation records an audit entry —
 * an agent-writable notification endpoint would be a board-originated
 * beacon.
 *
 * ID-ONLY DISPATCH: a webhook delivery carries the event name, the object
 * id, and the coarse derivation reason — never content. Authority always
 * travels in the pull: the recipient authenticates with their own
 * credential and fetches, and their grants decide what they see. Delivery
 * is best-effort with a bounded timeout and a per-endpoint interval floor;
 * the cursor feed remains the authoritative record (a missed notification
 * is late awareness, never lost work).
 */
import { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { auditService, AuditActor } from './AuditService';
import { logCaughtWarning } from '../utils/secretSafeLog';

export class NotificationEndpointValidationError extends Error {
  readonly code = 'INVALID_ENDPOINT';

  constructor(message: string) {
    super(message);
    this.name = 'NotificationEndpointValidationError';
  }
}

export const NOTIFICATION_ENDPOINT_KINDS = ['webhook', 'email'] as const;
export type NotificationEndpointKind = (typeof NOTIFICATION_ENDPOINT_KINDS)[number];

/** Bounded outbound call: a slow receiver must not wedge the sweep. */
export const NOTIFICATION_DISPATCH_TIMEOUT_MS = 5_000;
/** Per-endpoint interval floor — the human-path loop guard. */
export const NOTIFICATION_DISPATCH_MIN_INTERVAL_MS = 60_000;

export interface NotificationEndpoint {
  id: string;
  principalId: string;
  kind: NotificationEndpointKind;
  target: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExceptionNotice {
  name: string;        // e.g. 'task.stuck' — ratified derived-event names only
  objectType: string;  // 'task'
  objectId: string;
  reason?: string;     // coarse derivation reason ('lease_expired' | 'status_stale')
  occurredAt: string;
}

function mapRow(row: any): NotificationEndpoint {
  return {
    id: String(row.id),
    principalId: String(row.principal_id),
    kind: row.kind,
    target: String(row.target),
    enabled: Boolean(row.enabled),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class NotificationEndpointService {
  private lastDispatchAt = new Map<string, number>();

  constructor(private readonly pool: Pool = defaultPool) {}

  async list(): Promise<NotificationEndpoint[]> {
    const result = await this.pool.query(
      `SELECT id, principal_id, kind, target, enabled, created_at, updated_at
         FROM notification_endpoints
        ORDER BY principal_id, kind`,
    );
    return result.rows.map(mapRow);
  }

  /**
   * The audit trail must reconstruct WHERE an endpoint pointed without ever
   * storing credential-bearing URL material: the host (or the email domain)
   * is identity enough, and query strings/paths/userinfo/local-parts —
   * where tokens and private values live — never reach the audit row
   * (review 4243b06e B2). Derivation FAILS CLOSED (review f6a94595 R2-B1):
   * a target that does not parse to a clean identity is refused at the
   * surface, never committed — so no audit row can carry a null identity,
   * and a malformed email can never fall back to the verbatim target.
   */
  static destinationIdentity(kind: NotificationEndpointKind, target: string): string | null {
    try {
      if (kind === 'webhook') {
        const url = new URL(target);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.host || null;
      }
      // Email: exactly one @, non-empty local part, a dotted domain. The
      // identity is the DOMAIN alone — the local part is private data.
      const parts = target.split('@');
      if (parts.length !== 2) return null;
      const [local, domain] = parts;
      if (!local || !/^[^\s@]+\.[^\s@]+$/.test(domain)) return null;
      return domain;
    } catch {
      return null;
    }
  }

  /**
   * Upsert one (principal, kind) endpoint. Root-surface only. The mutation
   * and its audit record are ONE transaction (review 4243b06e B2): a
   * subscription-class change can never commit unaudited — an audit failure
   * rolls the change back.
   */
  async upsert(
    input: { principalId: string; kind: NotificationEndpointKind; target: string; enabled: boolean },
    actor: AuditActor,
  ): Promise<NotificationEndpoint> {
    // Fail closed BEFORE any mutation: no derivable destination identity,
    // no stored endpoint (review f6a94595 R2-B1).
    const destination = NotificationEndpointService.destinationIdentity(input.kind, input.target);
    if (destination === null) {
      throw new NotificationEndpointValidationError(
        input.kind === 'webhook'
          ? 'a webhook target must be a parseable http(s) URL'
          : 'an email target must be a plain address with a dotted domain',
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO notification_endpoints (principal_id, kind, target, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (principal_id, kind)
         DO UPDATE SET target = EXCLUDED.target, enabled = EXCLUDED.enabled, updated_at = now()
         RETURNING id, principal_id, kind, target, enabled, created_at, updated_at`,
        [input.principalId, input.kind, input.target, input.enabled],
      );
      const endpoint = mapRow(result.rows[0]);
      await auditService.record({
        action: 'notification_endpoint.set',
        actor,
        resourceType: 'principal',
        resourceId: input.principalId,
        metadata: {
          kind: input.kind,
          enabled: input.enabled,
          endpointId: endpoint.id,
          destination,
        },
      }, client);
      await client.query('COMMIT');
      return endpoint;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Remove one endpoint by id. Root-surface only; mutation + audit are one
   * transaction (review 4243b06e B2). */
  async remove(id: string, actor: AuditActor): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `DELETE FROM notification_endpoints WHERE id = $1
         RETURNING id, principal_id, kind, target, enabled`,
        [id],
      );
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await auditService.record({
        action: 'notification_endpoint.removed',
        actor,
        resourceType: 'principal',
        resourceId: String(result.rows[0].principal_id),
        metadata: {
          kind: result.rows[0].kind,
          enabled: Boolean(result.rows[0].enabled),
          endpointId: id,
          destination: NotificationEndpointService.destinationIdentity(result.rows[0].kind, String(result.rows[0].target)),
        },
      }, client);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Best-effort exception dispatch to every ENABLED webhook endpoint —
   * ID-only payload, bounded timeout, per-endpoint interval floor. Email
   * endpoints are configuration-only until a mail transport exists (the
   * declared v1 seam). Failures are logged and never propagate: the feed is
   * the authoritative record.
   */
  async dispatchException(notice: ExceptionNotice): Promise<number> {
    let dispatched = 0;
    let endpoints: NotificationEndpoint[] = [];
    try {
      const result = await this.pool.query(
        `SELECT id, principal_id, kind, target, enabled, created_at, updated_at
           FROM notification_endpoints
          WHERE enabled AND kind = 'webhook'`,
      );
      endpoints = result.rows.map(mapRow);
    } catch (err) {
      logCaughtWarning('[NotificationEndpointService] endpoint lookup failed:', err);
      return 0;
    }
    for (const endpoint of endpoints) {
      const now = Date.now();
      const last = this.lastDispatchAt.get(endpoint.id) ?? 0;
      if (now - last < NOTIFICATION_DISPATCH_MIN_INTERVAL_MS) continue;
      this.lastDispatchAt.set(endpoint.id, now);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), NOTIFICATION_DISPATCH_TIMEOUT_MS);
        await fetch(endpoint.target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: notice.name,
            objectType: notice.objectType,
            objectId: notice.objectId,
            ...(notice.reason ? { reason: notice.reason } : {}),
            occurredAt: notice.occurredAt,
          }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        dispatched += 1;
      } catch (err) {
        logCaughtWarning('[NotificationEndpointService] webhook dispatch failed:', err);
      }
    }
    return dispatched;
  }
}

export const notificationEndpointService = new NotificationEndpointService();
