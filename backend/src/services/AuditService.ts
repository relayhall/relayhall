import { pool } from '../db/connection';

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export type AuditAuthMethod =
  | 'local_admin' | 'dashboard_jwt' | 'principal_api_key'
  | 'legacy_api_key' | 'reports_read_key' | 'session' | 'system' | 'unknown';

export interface AuditActor {
  principalId?: string | null;
  handle: string;
  authMethod: AuditAuthMethod;
  credentialId?: string | null;
}

export interface AuditWrite {
  action: string;
  actor: AuditActor;
  resourceType: string;
  resourceId?: string | null;
  outcome?: 'success' | 'denied';
  metadata?: Record<string, unknown>;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  action: string;
  outcome: 'success' | 'denied';
  actorPrincipalId: string | null;
  actorHandle: string;
  authMethod: AuditAuthMethod;
  credentialId: string | null;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
}

function mapRow(row: any): AuditEvent {
  return {
    id: String(row.id),
    occurredAt: new Date(row.occurred_at).toISOString(),
    action: String(row.action),
    outcome: row.outcome,
    actorPrincipalId: row.actor_principal_id ?? null,
    actorHandle: String(row.actor_handle),
    authMethod: row.auth_method,
    credentialId: row.credential_id ?? null,
    resourceType: String(row.resource_type),
    resourceId: row.resource_id ?? null,
    metadata: row.metadata ?? {},
  };
}

export class AuditService {
  async record(write: AuditWrite, queryable: Queryable = pool): Promise<AuditEvent> {
    const result = await queryable.query(
      `INSERT INTO audit_events
         (action, outcome, actor_principal_id, actor_handle, auth_method,
          credential_id, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING *`,
      [
        write.action,
        write.outcome ?? 'success',
        write.actor.principalId ?? null,
        write.actor.handle || 'unknown',
        write.actor.authMethod,
        write.actor.credentialId ?? null,
        write.resourceType,
        write.resourceId ?? null,
        JSON.stringify(write.metadata ?? {}),
      ],
    );
    return mapRow(result.rows[0]);
  }

  async list(input: {
    limit: number;
    before?: string;
    action?: string;
    /** The HEAD of an action, so a person can browse one family (card 96aeacb7). */
    actionPrefix?: string;
    outcome?: 'success' | 'denied';
    /** Half-open window [since, until) over `occurred_at`, UTC ISO-8601. */
    since?: string;
    until?: string;
    actorPrincipalId?: string;
    resourceType?: string;
    resourceId?: string;
  }): Promise<{ events: AuditEvent[]; nextCursor: string | null }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (input.before) {
      const p = bind(input.before);
      clauses.push(`(occurred_at, id) < (SELECT occurred_at, id FROM audit_events WHERE id = ${p}::uuid)`);
    }
    if (input.action) clauses.push(`action = ${bind(input.action)}`);
    if (input.actionPrefix) {
      // `left(action, length($n)) = $n`, NOT `action LIKE $n || '%'`.
      //
      // The action alphabet (migration 087's CHECK) contains `_`, and `_` is a
      // single-character LIKE wildcard. A LIKE prefix would therefore make
      // `task_arm` match `taskXarm` — a widening produced by punctuation, on
      // the surface whose whole job is to report exactly what happened. `left`
      // has no pattern language at all, so the parameter cannot be a pattern.
      //
      // HONEST COST: this predicate cannot use ix_audit_events_action_order, so
      // a prefix that matches little makes PostgreSQL walk further down
      // ix_audit_events_order before filling the page. The bounded LIMIT (<=200
      // + 1) caps the work, and the exact `action` filter — which does use that
      // index — remains available beside it.
      const p = bind(input.actionPrefix);
      clauses.push(`left(action, length(${p})) = ${p}`);
    }
    if (input.outcome) clauses.push(`outcome = ${bind(input.outcome)}`);
    // Half-open, so adjacent windows tile the ledger exactly once: an
    // inclusive upper bound either double-counts or drops an event landing on
    // the boundary, and `occurred_at` has sub-second precision.
    if (input.since) clauses.push(`occurred_at >= ${bind(input.since)}::timestamptz`);
    if (input.until) clauses.push(`occurred_at < ${bind(input.until)}::timestamptz`);
    if (input.actorPrincipalId) clauses.push(`actor_principal_id = ${bind(input.actorPrincipalId)}::uuid`);
    if (input.resourceType) clauses.push(`resource_type = ${bind(input.resourceType)}`);
    if (input.resourceId) clauses.push(`resource_id = ${bind(input.resourceId)}`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limitParam = bind(input.limit + 1);
    const result = await pool.query(
      `SELECT * FROM audit_events ${where}
       ORDER BY occurred_at DESC, id DESC LIMIT ${limitParam}`,
      params,
    );
    const hasMore = result.rows.length > input.limit;
    const rows = hasMore ? result.rows.slice(0, input.limit) : result.rows;
    return {
      events: rows.map(mapRow),
      nextCursor: hasMore && rows.length ? String(rows[rows.length - 1].id) : null,
    };
  }
}

export const auditService = new AuditService();
