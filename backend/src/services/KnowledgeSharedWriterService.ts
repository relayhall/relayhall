/**
 * KnowledgeSharedWriterService — the shared-area writer list of a knowledge
 * source (card 549cc51f; owner rulings E298, E299 and E310).
 *
 * A knowledge source's organisation-wide SHARED AREA is readable by everyone the
 * source admits and writable only by the Accounts on its WRITER LIST. This module
 * owns that list: who is on it (`list`), the two human acts that change it
 * (`change`), the sweep that removes a row whose expiry has passed
 * (`sweepExpired`), and the read the lifecycle exporter puts into the signed
 * snapshot (`readSharedWriterIdsForExport`).
 *
 * ── WHO MAY CHANGE IT ──
 *
 * The ROUTE decides standing before anything here runs: a root login session,
 * or an administrator login session through `administratorSessionOf` with
 * `SHARED_WRITER_ACT` (E299, the F1 repair). No bearer credential, no API key
 * and no Access profile reaches a change. What this module enforces on top is
 * the act itself: Accounts only (E298 Q1 (a)), a reason of 20-2,000
 * characters, a live single-use step-up bound to the act and the Account,
 * burned in the SAME transaction as the write, and one audit row per change
 * carrying the before and after membership, the reason and the step-up token
 * id. Every refusal is audited as denied.
 *
 * ── ONE TRANSACTION PER ACT, SERIALISED PER SOURCE ──
 *
 * An advisory transaction lock keyed by the source serialises acts on one list,
 * so the before and after an audit row records are exactly the list the act
 * changed. Rows whose expiry has passed are removed under the same lock at the
 * start of every act (each audited as actor `system`), so an act never meets a
 * row the snapshot no longer delivers.
 */
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { stepUpService } from './StepUpService';
import { notificationEndpointService } from './NotificationEndpointService';
import { logCaughtWarning } from '../utils/secretSafeLog';
import { assertDecisionEvidence, type DecisionEvidence } from '../utils/decisionEvidence';

/** The one scope this release admits (the migration 157 CHECK). */
export const SHARED_WRITER_SCOPE = 'organisation' as const;

/** The step-up actions, as the ratified design spells them (step_up_tokens.action has no CHECK). */
export const SHARED_WRITER_STEP_UP_ACTIONS = {
  add: 'knowledge.shared-writer.add',
  remove: 'knowledge.shared-writer.remove',
} as const;

/** The audit actions. The ledger's CHECK (087) admits no hyphen, so the noun is spelled with `_` here. */
export const SHARED_WRITER_AUDIT_ACTIONS = {
  add: 'knowledge.shared_writer.add',
  remove: 'knowledge.shared_writer.remove',
  expire: 'knowledge.shared_writer.expire',
} as const;

export const SHARED_WRITER_AUDIT_RESOURCE_TYPE = 'knowledge_shared_writer';
export const SHARED_WRITER_REASON_MIN = 20;
export const SHARED_WRITER_REASON_MAX = 2000;

/** The id-only notice name sent to the enabled notification endpoints on every change. */
export const SHARED_WRITER_NOTICE_NAME = 'knowledge.shared_writer.changed';

/** The actor the expiry sweep writes as (the ApprovalService sweep precedent). */
export const SHARED_WRITER_SYSTEM_ACTOR: AuditActor = { handle: 'system', authMethod: 'system' };

export type SharedWriterChangeKind = 'add' | 'remove';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refusal this module authors: status, code, field and message are literals. */
export class SharedWriterError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'SharedWriterError';
  }
}

export interface SharedWriterSource { id: string; slug: string; name: string }

export interface SharedWriterEntry {
  accountId: string;
  label: string;
}

export interface SharedWriterAdministrationEntry extends SharedWriterEntry {
  active: boolean;
  addedBy: { id: string; label: string } | null;
  addedAt: string;
  reason: string;
  expiresAt: string | null;
  approvalId: string | null;
  origin: 'direct' | 'approval';
}

export interface SharedWriterChangeResult {
  source: SharedWriterSource;
  scope: typeof SHARED_WRITER_SCOPE;
  accountId: string;
  before: string[];
  after: string[];
  auditId: string;
  expiresAt: string | null;
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** Canonical lower case: the step-up store compares target ids as text. */
export function canonicalAccountId(raw: unknown): string | null {
  return typeof raw === 'string' && UUID_PATTERN.test(raw) ? raw.toLowerCase() : null;
}

/** The label the snapshot uses (KnowledgeLifecycleExporter): display name, else handle. */
function labelOf(displayName: unknown, handle: unknown): string {
  return typeof displayName === 'string' && displayName.length ? displayName : String(handle ?? '');
}

/** How a refused target is named in words, by its kind. Lookup only: no kind is compared here. */
const NOT_AN_ACCOUNT_WORDS: Record<string, string> = {
  agent: 'an Agent',
  service: 'a Connector or service identity',
  group: 'a Group',
};

/** The reason a writer-list act carries: 20-2,000 characters after trimming. */
export function validateSharedWriterReason(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length < SHARED_WRITER_REASON_MIN || reason.length > SHARED_WRITER_REASON_MAX) {
    throw new SharedWriterError(400, 'SHARED_WRITER_INVALID',
      `reason must be ${SHARED_WRITER_REASON_MIN}-${SHARED_WRITER_REASON_MAX} characters`, 'reason');
  }
  return reason;
}

/** An optional expiry: ISO-8601, in the future. Undefined, null and '' mean never. */
export function validateSharedWriterExpiry(raw: unknown, now: number = Date.now()): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new SharedWriterError(400, 'SHARED_WRITER_INVALID', 'expiresAt must be an ISO-8601 date-time', 'expiresAt');
  }
  const at = Date.parse(raw);
  if (at <= now) {
    throw new SharedWriterError(400, 'SHARED_WRITER_INVALID', 'expiresAt must be in the future', 'expiresAt');
  }
  return new Date(at).toISOString();
}

/**
 * The source an act or a read is about. Named: any knowledge-configured,
 * unretired Service. Omitted: the ONE write-configured knowledge source, else a
 * named refusal, so a deployment with two never has one picked for it.
 */
export async function resolveSharedWriterSource(queryable: Queryable, raw: unknown): Promise<SharedWriterSource> {
  if (raw !== undefined && raw !== null && raw !== '') {
    const id = canonicalAccountId(raw);
    if (!id) throw new SharedWriterError(400, 'SHARED_WRITER_INVALID', 'source must be a knowledge source id (a UUID)', 'source');
    const row = await queryable.query(
      `SELECT id, slug, name FROM services
        WHERE id = $1 AND knowledge_query_endpoint IS NOT NULL AND retired_at IS NULL`, [id]);
    if (!row.rows.length) throw new SharedWriterError(404, 'SHARED_WRITER_SOURCE_NOT_FOUND', 'No such knowledge source');
    return { id: String(row.rows[0].id), slug: String(row.rows[0].slug), name: String(row.rows[0].name ?? row.rows[0].slug) };
  }
  const rows = await queryable.query(
    `SELECT id, slug, name FROM services
      WHERE knowledge_write_endpoint IS NOT NULL AND retired_at IS NULL
      ORDER BY id LIMIT 2`);
  if (rows.rows.length === 0) {
    throw new SharedWriterError(404, 'SHARED_WRITER_SOURCE_NOT_FOUND', 'No write-configured knowledge source exists');
  }
  if (rows.rows.length > 1) {
    throw new SharedWriterError(400, 'SHARED_WRITER_SOURCE_REQUIRED',
      'More than one knowledge source accepts writes: name one with source', 'source');
  }
  const row = rows.rows[0];
  return { id: String(row.id), slug: String(row.slug), name: String(row.name ?? row.slug) };
}

/** The Account ids on one list, sorted (the membership an audit row records). */
async function membership(queryable: Queryable, sourceId: string): Promise<string[]> {
  const rows = await queryable.query(
    `SELECT account_id FROM knowledge_shared_writers
      WHERE source_id = $1 AND scope = $2 ORDER BY account_id`, [sourceId, SHARED_WRITER_SCOPE]);
  return rows.rows.map((row) => String(row.account_id));
}

async function lockList(queryable: Queryable, sourceId: string): Promise<void> {
  await queryable.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`knowledge-shared-writers:${sourceId}`]);
}

interface ExpiredRemoval { accountId: string; before: string[]; after: string[]; expiresAt: string }

/**
 * Remove every row of one list whose expiry has passed, one `system` audit row
 * each, in the CALLER's transaction and under the caller's lock.
 */
async function expireRowsLocked(client: Queryable, source: { id: string }): Promise<ExpiredRemoval[]> {
  const removed = await client.query(
    `DELETE FROM knowledge_shared_writers
      WHERE source_id = $1 AND scope = $2 AND expires_at IS NOT NULL AND expires_at <= now()
      RETURNING account_id, expires_at`, [source.id, SHARED_WRITER_SCOPE]);
  if (!removed.rows.length) return [];
  const remaining = await membership(client, source.id);
  const gone = removed.rows
    .map((row) => ({ accountId: String(row.account_id), expiresAt: new Date(row.expires_at).toISOString() }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
  // Replayed in id order, so each row's before/after is the list one step at a time.
  let current = [...remaining, ...gone.map((row) => row.accountId)].sort();
  const out: ExpiredRemoval[] = [];
  for (const row of gone) {
    const before = current;
    const after = current.filter((id) => id !== row.accountId);
    await auditService.record({
      action: SHARED_WRITER_AUDIT_ACTIONS.expire,
      actor: SHARED_WRITER_SYSTEM_ACTOR,
      resourceType: SHARED_WRITER_AUDIT_RESOURCE_TYPE,
      resourceId: row.accountId,
      metadata: { source: source.id, scope: SHARED_WRITER_SCOPE, accountId: row.accountId, before, after, expiresAt: row.expiresAt },
    }, client);
    out.push({ accountId: row.accountId, before, after, expiresAt: row.expiresAt });
    current = after;
  }
  return out;
}

function notifyChange(accountId: string, verb: string, sourceSlug: string, actorHandle: string): void {
  notificationEndpointService
    .dispatchException({
      name: SHARED_WRITER_NOTICE_NAME,
      objectType: SHARED_WRITER_AUDIT_RESOURCE_TYPE,
      objectId: accountId,
      reason: `shared-area writer ${verb} on ${sourceSlug} by ${actorHandle}`,
      occurredAt: new Date().toISOString(),
    })
    .catch((e) => logCaughtWarning('[KnowledgeSharedWriterService] change notice dispatch failed:', e));
}

export class KnowledgeSharedWriterService {
  /**
   * The list of one source, without the rows whose expiry has passed (the sweep
   * removes them within a minute; the snapshot already omits them). The default
   * view is the Account and its label; `administration` adds the row's
   * provenance and is served by the route to root and administrator sessions only.
   */
  async list(
    source: SharedWriterSource, viewerAccountId: string | null, queryable: Queryable = pool,
  ): Promise<{ writers: SharedWriterAdministrationEntry[]; youCanWrite: boolean }> {
    const rows = await queryable.query(
      `SELECT w.account_id, w.added_at, w.reason, w.expires_at, w.approval_id, w.added_by,
              p.handle, p.display_name, p.status,
              a.handle AS added_by_handle, a.display_name AS added_by_display_name
         FROM knowledge_shared_writers w
         JOIN principals p ON p.id = w.account_id
         LEFT JOIN principals a ON a.id = w.added_by
        WHERE w.source_id = $1 AND w.scope = $2
          AND (w.expires_at IS NULL OR w.expires_at > now())
        ORDER BY w.added_at, w.account_id`, [source.id, SHARED_WRITER_SCOPE]);
    const writers: SharedWriterAdministrationEntry[] = rows.rows.map((row) => ({
      accountId: String(row.account_id),
      label: labelOf(row.display_name, row.handle),
      active: row.status === 'active',
      addedBy: row.added_by ? { id: String(row.added_by), label: labelOf(row.added_by_display_name, row.added_by_handle) } : null,
      addedAt: new Date(row.added_at).toISOString(),
      reason: String(row.reason),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      approvalId: row.approval_id ? String(row.approval_id) : null,
      origin: row.approval_id ? 'approval' : 'direct',
    }));
    const youCanWrite = viewerAccountId !== null
      && writers.some((writer) => writer.accountId === viewerAccountId && writer.active);
    return { writers, youCanWrite };
  }

  /**
   * ADD or REMOVE one Account. The caller has already decided standing (the
   * route's gate); everything else is decided here, in one transaction.
   */
  async change(kind: SharedWriterChangeKind, input: {
    source: unknown;
    accountId: unknown;
    reason: unknown;
    expiresAt?: unknown;
    stepUpToken: unknown;
    principalId: string;
    actor: AuditActor;
    standing: 'root' | 'administrator';
  }): Promise<SharedWriterChangeResult> {
    const auditAction = SHARED_WRITER_AUDIT_ACTIONS[kind];
    const accountId = canonicalAccountId(input.accountId);
    if (!accountId) throw new SharedWriterError(400, 'SHARED_WRITER_INVALID', 'accountId must be an Account id (a UUID)', 'accountId');
    const reason = validateSharedWriterReason(input.reason);
    const expiresAt = kind === 'add' ? validateSharedWriterExpiry(input.expiresAt) : null;
    if (kind === 'remove' && input.expiresAt !== undefined) {
      throw new SharedWriterError(400, 'SHARED_WRITER_INVALID', 'expiresAt applies to an add only', 'expiresAt');
    }

    const client = await pool.connect();
    const expired: Array<ExpiredRemoval & { sourceSlug: string }> = [];
    let sourceForAudit: string | null = null;
    try {
      await client.query('BEGIN');
      const source = await resolveSharedWriterSource(client, input.source);
      sourceForAudit = source.id;
      await lockList(client, source.id);
      for (const row of await expireRowsLocked(client, source)) expired.push({ ...row, sourceSlug: source.slug });
      const before = await membership(client, source.id);
      const listed = before.includes(accountId);

      if (kind === 'add') {
        const target = await client.query(
          'SELECT id, kind, status, parent_principal_id FROM principals WHERE id = $1', [accountId]);
        const row = target.rows[0];
        if (!row) throw new SharedWriterError(404, 'SHARED_WRITER_ACCOUNT_NOT_FOUND', 'No such Account', 'accountId');
        if (row.kind !== 'human' || row.parent_principal_id) {
          const words = row.parent_principal_id ? 'a parented identity' : (NOT_AN_ACCOUNT_WORDS[String(row.kind)] ?? 'not an Account');
          throw new SharedWriterError(422, 'SHARED_WRITER_NOT_AN_ACCOUNT',
            `A shared-area writer is an Account (a parentless human identity); this id names ${words}`, 'accountId');
        }
        if (row.status !== 'active') {
          throw new SharedWriterError(422, 'SHARED_WRITER_ACCOUNT_INACTIVE',
            'A shared-area writer must be an active Account', 'accountId');
        }
        if (listed) {
          throw new SharedWriterError(409, 'SHARED_WRITER_ALREADY_LISTED',
            'This Account is already on the shared-area writer list', 'accountId');
        }
      } else if (!listed) {
        throw new SharedWriterError(404, 'SHARED_WRITER_NOT_LISTED',
          'This Account is not on the shared-area writer list', 'accountId');
      }

      // The step-up is spent only by an act that will be written: every
      // refusal above runs first and leaves the token live.
      const stepUp = await stepUpService.consume(client, {
        token: typeof input.stepUpToken === 'string' ? input.stepUpToken : '',
        principalId: input.principalId,
        action: SHARED_WRITER_STEP_UP_ACTIONS[kind],
        targetId: accountId,
      });

      if (kind === 'add') {
        await client.query(
          `INSERT INTO knowledge_shared_writers (source_id, scope, account_id, added_by, reason, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [source.id, SHARED_WRITER_SCOPE, accountId, input.principalId, reason, expiresAt]);
      } else {
        await client.query(
          'DELETE FROM knowledge_shared_writers WHERE source_id = $1 AND scope = $2 AND account_id = $3',
          [source.id, SHARED_WRITER_SCOPE, accountId]);
      }
      const after = await membership(client, source.id);
      const audit = await auditService.record({
        action: auditAction,
        actor: input.actor,
        resourceType: SHARED_WRITER_AUDIT_RESOURCE_TYPE,
        resourceId: accountId,
        metadata: {
          source: source.id, scope: SHARED_WRITER_SCOPE, accountId, before, after, reason,
          stepUpTokenId: stepUp.tokenId, stepUpMethod: stepUp.method, standing: input.standing,
          ...(kind === 'add' ? { expiresAt } : {}),
        },
      }, client);
      await client.query('COMMIT');

      for (const row of expired) notifyChange(row.accountId, 'expired', row.sourceSlug, SHARED_WRITER_SYSTEM_ACTOR.handle);
      notifyChange(accountId, kind === 'add' ? 'added' : 'removed', source.slug, input.actor.handle);
      return { source, scope: SHARED_WRITER_SCOPE, accountId, before, after, auditId: audit.id, expiresAt };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = error instanceof SharedWriterError ? error.code
        : (error as { code?: unknown })?.code === 'STEP_UP_REQUIRED' ? 'STEP_UP_REQUIRED' : null;
      if (code) {
        await auditService.record({
          action: auditAction,
          actor: input.actor,
          outcome: 'denied',
          resourceType: SHARED_WRITER_AUDIT_RESOURCE_TYPE,
          resourceId: accountId,
          metadata: { refusal: code, source: sourceForAudit, scope: SHARED_WRITER_SCOPE, accountId, standing: input.standing },
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * THE APPLY OF AN APPROVED CHANGE REQUEST (card 502fb19e; owner rulings E310
   * and E325, change-request design section 3 `knowledge.shared_writer`): ADD one
   * Account to a list INSIDE the decide transaction `client` holds. The approvals
   * route decided the decider's standing and the decision consumed its one
   * step-up there; this seam accepts that pre-consumed evidence (section 5.3)
   * and consumes no second token. The row names its approval and carries the
   * approved expiry (a request-made row always expires, E298 Q5). The checks
   * of `change` on the Account and the list run here too, under the same lock.
   */
  async addApprovedWithin(client: Queryable, input: {
    source: SharedWriterSource;
    accountId: string;
    reason: string;
    expiresAt: string;
    approvalId: string;
    deciderPrincipalId: string;
    actor: AuditActor;
    standing: 'root' | 'administrator';
    evidence: DecisionEvidence;
  }): Promise<SharedWriterChangeResult> {
    await assertDecisionEvidence(client, input.evidence);
    const accountId = canonicalAccountId(input.accountId);
    if (!accountId) throw new SharedWriterError(400, 'SHARED_WRITER_INVALID', 'accountId must be an Account id (a UUID)', 'accountId');
    const reason = validateSharedWriterReason(input.reason);
    const expiresAt = validateSharedWriterExpiry(input.expiresAt);
    if (!expiresAt) throw new SharedWriterError(400, 'SHARED_WRITER_INVALID', 'a request-made row always expires (E298 Q5)', 'expiresAt');
    await lockList(client, input.source.id);
    await expireRowsLocked(client, input.source);
    const before = await membership(client, input.source.id);
    const target = (await client.query(
      'SELECT id, kind, status, parent_principal_id FROM principals WHERE id = $1', [accountId])).rows[0];
    if (!target) throw new SharedWriterError(404, 'SHARED_WRITER_ACCOUNT_NOT_FOUND', 'No such Account', 'accountId');
    if (target.kind !== 'human' || target.parent_principal_id) {
      throw new SharedWriterError(422, 'SHARED_WRITER_NOT_AN_ACCOUNT',
        'A shared-area writer is an Account (a parentless human identity)', 'accountId');
    }
    if (target.status !== 'active') {
      throw new SharedWriterError(422, 'SHARED_WRITER_ACCOUNT_INACTIVE', 'A shared-area writer must be an active Account', 'accountId');
    }
    if (before.includes(accountId)) {
      throw new SharedWriterError(409, 'SHARED_WRITER_ALREADY_LISTED', 'This Account is already on the shared-area writer list', 'accountId');
    }
    await client.query(
      `INSERT INTO knowledge_shared_writers (source_id, scope, account_id, added_by, reason, approval_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.source.id, SHARED_WRITER_SCOPE, accountId, input.deciderPrincipalId, reason, input.approvalId, expiresAt]);
    const after = await membership(client, input.source.id);
    const audit = await auditService.record({
      action: SHARED_WRITER_AUDIT_ACTIONS.add,
      actor: input.actor,
      resourceType: SHARED_WRITER_AUDIT_RESOURCE_TYPE,
      resourceId: accountId,
      metadata: {
        source: input.source.id, scope: SHARED_WRITER_SCOPE, accountId, before, after, reason, expiresAt,
        approvalId: input.approvalId, kind: 'change', standing: input.standing,
        stepUpTokenId: input.evidence.tokenId, stepUpMethod: input.evidence.method, evidence: 'approval.decide',
      },
    }, client);
    return { source: input.source, scope: SHARED_WRITER_SCOPE, accountId, before, after, auditId: audit.id, expiresAt };
  }

  /**
   * The expiry sweep (E298 Q5): remove every row whose expiry has passed, one
   * transaction per list, each removal audited as actor `system` and noticed.
   * Run by the server's 60-second lifecycle sweep. Returns the rows removed.
   */
  async sweepExpired(): Promise<number> {
    const due = await pool.query(
      `SELECT DISTINCT w.source_id, s.slug FROM knowledge_shared_writers w
         JOIN services s ON s.id = w.source_id
        WHERE w.expires_at IS NOT NULL AND w.expires_at <= now()
        ORDER BY w.source_id`);
    let total = 0;
    for (const row of due.rows) {
      const source = { id: String(row.source_id), slug: String(row.slug) };
      const client = await pool.connect();
      let removed: ExpiredRemoval[] = [];
      try {
        await client.query('BEGIN');
        await lockList(client, source.id);
        removed = await expireRowsLocked(client, source);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      for (const entry of removed) notifyChange(entry.accountId, 'expired', source.slug, SHARED_WRITER_SYSTEM_ACTOR.handle);
      total += removed.length;
    }
    return total;
  }
}

export const knowledgeSharedWriterService = new KnowledgeSharedWriterService();
