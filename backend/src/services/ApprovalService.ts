// ApprovalService.ts — Approvals (RH-P3.AZ-S4, card aa48fb12; AUTHZ design
// 4d961e37 §6.1/§6.1a; A17.11; AZ-16/AZ-21/AZ-31c; T7/T8/T21/T27).
//
// LIFECYCLE (A17.11): pending · approved · denied · collected · lapsed. A
// Connector's mint request CREATES an Approval (pending, quota-bound per
// Connector — T21); an approver DECIDES it on the board's authenticated
// human surface after step-up (T7: board-only — no reply-to-approve in any
// channel; the deep link carries no authority, T8), possibly EDITING the
// requested authority DOWN; an approved Approval is a SINGLE-USE
// authorization consumed by COLLECT (by the SAME requesting credential) or
// expiring unused (TTL 24h post-approval, 7d pending).
//
// BINDING (AZ-31c): every Approval binds to the EXACT requesting
// credential id; the credential's revocation, expiry or entry into
// rotation grace INVALIDATES every outstanding pending/approved Approval
// bound to it (status lapsed, audited reason CREDENTIAL_ROTATED) — the
// successor credential must re-request (T27 by construction).
//
// REVALIDATION (§6.1, T27): decision AND collect both re-run the FULL mint
// validation. At collect a TERMINAL failure (task terminal, requester
// terminated, credential dead) LAPSES the Approval with an audited reason;
// a TRANSIENT failure (writer slot held) refuses WITHOUT consuming it.
//
// SESSION MINT (§6.1a): a HUMAN Account acting through its authenticated
// login session mints atomically — requester AND approver, ONE
// step-up-gated transaction recording an Approval row
// created→approved→collected with session + step-up evidence (credential
// id NULL). Base = the Account's own effective authority (§5.2 rule 1);
// the minted Agent's parent = the Account.
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { auditChainFor } from '../utils/auditChain';
import { principalService } from './PrincipalService';
import { authorizationRepository } from './AuthorizationRepository';
import type { AuthorizationActor } from './AuthorizationService';
import { validateRules, type ProfileRule } from './AccessProfileService';
import {
  agentMintService, AgentMintError, validateRequestedScopes,
  type MintedAgentPack,
} from './AgentMintService';
import { rulesCovered, scopesWithin, sourcesFromRules } from '../utils/authorityContainment';
import { invalidateApprovalsForCredentials } from '../utils/approvalInvalidation';
import { notificationEndpointService } from './NotificationEndpointService';
import { logCaughtWarning } from '../utils/secretSafeLog';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const APPROVAL_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days (§6.1)
export const APPROVAL_COLLECT_TTL_MS = 24 * 60 * 60 * 1000;       // 24h post-approval

// T21 (AZ-21a): warrant-less mint requests are quota-bound per Connector.
export const APPROVAL_QUOTA_PENDING = Number(process.env.RELAYHALL_APPROVAL_QUOTA_PENDING || 5);
export const APPROVAL_QUOTA_DAILY = Number(process.env.RELAYHALL_APPROVAL_QUOTA_DAILY || 20);
// Notification coalescing window per requesting Connector.
const APPROVAL_NOTICE_COALESCE_MS = 15 * 60 * 1000;

export class ApprovalError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

const err = (status: number, code: string, message: string) => new ApprovalError(status, code, message);

export interface ApprovalRecord {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'collected' | 'lapsed';
  requesterPrincipalId: string;
  requesterHandle: string | null;
  requestingCredentialId: string | null;
  sessionEvidence: Record<string, unknown> | null;
  targetTaskId: string;
  targetTaskTitle: string | null;
  requestedScopes: string[];
  requestedRules: ProfileRule[];
  approvedScopes: string[] | null;
  approvedRules: ProfileRule[] | null;
  decidedByPrincipalId: string | null;
  decidedAt: string | null;
  denialReason: string | null;
  lapseReason: string | null;
  requestedAt: string;
  pendingExpiresAt: string;
  collectExpiresAt: string | null;
  collectedAt: string | null;
  mintedPrincipalId: string | null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function mapApproval(row: any): ApprovalRecord {
  return {
    id: String(row.id),
    status: row.status,
    requesterPrincipalId: String(row.requester_principal_id),
    requesterHandle: row.requester_handle ? String(row.requester_handle) : null,
    requestingCredentialId: row.requesting_credential_id ? String(row.requesting_credential_id) : null,
    sessionEvidence: parseJson<Record<string, unknown> | null>(row.session_evidence, null),
    targetTaskId: String(row.target_task_id),
    targetTaskTitle: row.target_task_title ? String(row.target_task_title) : null,
    requestedScopes: parseJson<string[]>(row.requested_scopes, []),
    requestedRules: parseJson<ProfileRule[]>(row.requested_rules, []),
    approvedScopes: parseJson<string[] | null>(row.approved_scopes, null),
    approvedRules: parseJson<ProfileRule[] | null>(row.approved_rules, null),
    decidedByPrincipalId: row.decided_by_principal_id ? String(row.decided_by_principal_id) : null,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    denialReason: row.denial_reason ?? null,
    lapseReason: row.lapse_reason ?? null,
    requestedAt: new Date(row.requested_at).toISOString(),
    pendingExpiresAt: new Date(row.pending_expires_at).toISOString(),
    collectExpiresAt: row.collect_expires_at ? new Date(row.collect_expires_at).toISOString() : null,
    collectedAt: row.collected_at ? new Date(row.collected_at).toISOString() : null,
    mintedPrincipalId: row.minted_principal_id ? String(row.minted_principal_id) : null,
  };
}

const APPROVAL_SELECT = `
  SELECT a.*, rp.handle AS requester_handle, t.title AS target_task_title
    FROM approvals a
    JOIN principals rp ON rp.id = a.requester_principal_id
    LEFT JOIN tasks t ON t.id = a.target_task_id`;

async function writeApprovalEvent(
  queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> },
  input: { approvalId: string; action: string; actor: AuditActor; metadata?: Record<string, unknown> },
): Promise<void> {
  await queryable.query(
    `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [input.approvalId, input.action, input.actor.principalId ?? null, input.actor.handle || 'unknown', JSON.stringify(input.metadata ?? {})],
  );
}

/** Deep-link path into the Access manager approval queue (T8: the link
 * carries NO authority — it lands on the login wall, then the board's
 * authenticated human surface where the act still demands step-up). */
export function approvalDeepLinkPath(approvalId: string): string {
  return `/dashboard/settings/access-manager?approval=${approvalId}`;
}

interface CoalesceState { windowStart: number; suppressed: number }

/** §5.2 rule 8: every approval-lifecycle REFUSAL is a durable denied audit
 * with the reason and the affected chain — written on the pool so a
 * transaction rollback cannot erase it. Unexpected errors (500s) are not
 * refusals and ride the error path unaudited. */
async function auditRefusal(
  action: string, e: unknown, actor: AuditActor,
  resource: { type: string; id: string | null }, chainPrincipalId: string | null,
): Promise<void> {
  const refusal = (e instanceof ApprovalError || e instanceof AgentMintError)
    ? e.code : null;
  if (!refusal) return;
  await auditService.record({
    action, actor, outcome: 'denied',
    resourceType: resource.type, resourceId: resource.id,
    metadata: {
      refusal,
      chain: chainPrincipalId ? await auditChainFor(pool, chainPrincipalId) : [],
    },
  }).catch(() => undefined);
}

export class ApprovalService {
  private noticeWindows = new Map<string, CoalesceState>();

  async get(approvalId: string): Promise<ApprovalRecord> {
    if (!UUID_PATTERN.test(approvalId)) throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
    const result = await pool.query(`${APPROVAL_SELECT} WHERE a.id = $1`, [approvalId]);
    if (result.rows.length === 0) throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
    return mapApproval(result.rows[0]);
  }

  /** SELF-SCOPE listing (§6.1/§9.1): root full view; a non-root session
   * sees only approvals whose SUBJECT (the requester) lies in its own
   * subtree, itself included. */
  async list(viewer: { principalId: string; isRoot: boolean }, statusFilter?: string): Promise<ApprovalRecord[]> {
    const params: unknown[] = [];
    let where = '';
    if (!viewer.isRoot) {
      params.push(viewer.principalId);
      where = `WHERE a.requester_principal_id IN (
        WITH RECURSIVE subtree AS (
          SELECT id FROM principals WHERE id = $1
          UNION ALL
          SELECT p.id FROM principals p JOIN subtree s ON p.parent_principal_id = s.id
        ) SELECT id FROM subtree)`;
    }
    if (statusFilter) {
      params.push(statusFilter);
      where = where ? `${where} AND a.status = $${params.length}` : `WHERE a.status = $${params.length}`;
    }
    const result = await pool.query(`${APPROVAL_SELECT} ${where} ORDER BY a.requested_at DESC LIMIT 500`, params);
    return result.rows.map(mapApproval);
  }

  async events(approvalId: string, limit = 100): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM approval_events WHERE approval_id = $1
       ORDER BY occurred_at DESC, id DESC LIMIT $2`,
      [approvalId, Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map((row) => ({
      id: row.id, occurredAt: row.occurred_at, approvalId: row.approval_id,
      action: row.action, actorPrincipalId: row.actor_principal_id ?? null,
      actorHandle: row.actor_handle, metadata: row.metadata ?? {},
    }));
  }

  /**
   * §6.1 default path: a Connector REQUESTS an Agent identity. Creates the
   * pending Approval bound to the exact presenting credential, under the
   * per-Connector quota (T21), and alerts the notification endpoints with
   * a verifiable deep link (coalesced per Connector).
   */
  async request(input: {
    requesterPrincipalId: string;
    requestingCredentialId: string;
    targetTaskId: string;
    requestedScopes: unknown;
    requestedRules?: unknown;
  }, actor: AuditActor): Promise<ApprovalRecord> {
    const requester = await principalService.getPrincipalById(input.requesterPrincipalId);
    if (!requester) throw err(404, 'REQUESTER_NOT_FOUND', 'requester resolves to no principal');
    if (requester.legacyIdentity) {
      await auditService.record({
        action: 'legacy.refused', actor, outcome: 'denied',
        resourceType: 'principal', resourceId: input.requesterPrincipalId,
        metadata: { act: 'approval.request', reason: 'legacy_identity frozen out (§10, T37)' },
      }).catch(() => undefined);
      throw err(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of Approval creation (§10, T37)');
    }
    if (requester.kind === 'agent') {
      // AZ-28: mint is Connector/Account-plane; a sub-worker is a sibling
      // minted by the Connector — Agent-layer requests refuse (T11 shape).
      throw err(422, 'AGENT_PLANE_REFUSED', 'Agent-layer credentials never request mints (AZ-28): a sub-worker is a sibling minted by the Connector');
    }
    if (!requester.parentPrincipalId) {
      throw err(422, 'CONNECTOR_PLANE_ONLY', 'bearer mint requests are the Connector plane (§6.1); human Accounts mint through their session (§6.1a)');
    }
    if (!UUID_PATTERN.test(input.targetTaskId ?? '')) {
      throw err(422, 'INVALID_MINT_REQUEST', 'targetTaskId must be a full UUID');
    }
    const scopes = validateRequestedScopes(input.requestedScopes);
    const rules = input.requestedRules === undefined || input.requestedRules === null
      ? []
      : validateRules(input.requestedRules);

    // Full validation at REQUEST time too — a request that could never be
    // approved should refuse now, loudly, not sit in the queue. Rule 8:
    // these refusals audit durably with the requester chain.
    try {
      await agentMintService.assertRequesterLive(input.requesterPrincipalId, input.requestingCredentialId);
      await agentMintService.assertTaskMintable(pool, input.targetTaskId);
    } catch (e) {
      await auditRefusal('approval.request', e, actor,
        { type: 'principal', id: input.requesterPrincipalId }, input.requesterPrincipalId);
      throw e;
    }

    // T21: per-Connector quota, refused loudly and audited.
    const quota = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE requested_at > NOW() - INTERVAL '24 hours')::int AS daily
       FROM approvals WHERE requester_principal_id = $1`,
      [input.requesterPrincipalId],
    );
    const { pending, daily } = quota.rows[0];
    if (Number(pending) >= APPROVAL_QUOTA_PENDING || Number(daily) >= APPROVAL_QUOTA_DAILY) {
      await auditService.record({
        action: 'approval.request', actor, outcome: 'denied',
        resourceType: 'principal', resourceId: input.requesterPrincipalId,
        metadata: {
          refusal: 'MINT_QUOTA_EXCEEDED', pending: Number(pending), daily: Number(daily),
          quotaPending: APPROVAL_QUOTA_PENDING, quotaDaily: APPROVAL_QUOTA_DAILY,
          chain: await auditChainFor(pool, input.requesterPrincipalId),
        },
      }).catch(() => undefined);
      throw err(429, 'MINT_QUOTA_EXCEEDED',
        `mint-request quota exceeded (AZ-21a: ${APPROVAL_QUOTA_PENDING} pending / ${APPROVAL_QUOTA_DAILY} per day) — excess refuses loudly (T21)`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query(
        `INSERT INTO approvals
           (requester_principal_id, requesting_credential_id, target_task_id,
            requested_scopes, requested_rules, pending_expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
         RETURNING id`,
        [
          input.requesterPrincipalId, input.requestingCredentialId, input.targetTaskId,
          JSON.stringify(scopes), JSON.stringify(rules),
          new Date(Date.now() + APPROVAL_PENDING_TTL_MS),
        ],
      );
      const approvalId = String(created.rows[0].id);
      await writeApprovalEvent(client, {
        approvalId, action: 'approval.requested', actor,
        metadata: { targetTaskId: input.targetTaskId, scopes, rules },
      });
      await auditService.record({
        action: 'approval.request', actor,
        resourceType: 'approval', resourceId: approvalId,
        metadata: {
          requesterPrincipalId: input.requesterPrincipalId,
          requestingCredentialId: input.requestingCredentialId,
          targetTaskId: input.targetTaskId, scopes, rules,
          chain: await auditChainFor(client, input.requesterPrincipalId),
        },
      }, client);
      await client.query('COMMIT');
      this.dispatchApprovalNotice(approvalId, input.requesterPrincipalId, requester.handle);
      return this.get(approvalId);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** T21 coalescing: at most one endpoint alert per Connector per window;
   * suppressed requests ride the next alert as a count. Fire-and-forget —
   * the Access manager queue is the authoritative surface. */
  private dispatchApprovalNotice(approvalId: string, requesterPrincipalId: string, requesterHandle: string): void {
    const now = Date.now();
    const state = this.noticeWindows.get(requesterPrincipalId);
    if (state && now - state.windowStart < APPROVAL_NOTICE_COALESCE_MS) {
      state.suppressed += 1;
      return;
    }
    const suppressed = state?.suppressed ?? 0;
    this.noticeWindows.set(requesterPrincipalId, { windowStart: now, suppressed: 0 });
    notificationEndpointService
      .dispatchException({
        name: 'approval.requested',
        objectType: 'approval',
        objectId: approvalId,
        reason: suppressed > 0
          ? `agent-mint approval requested by ${requesterHandle} (+${suppressed} coalesced); decide on the board: ${approvalDeepLinkPath(approvalId)}`
          : `agent-mint approval requested by ${requesterHandle}; decide on the board: ${approvalDeepLinkPath(approvalId)}`,
        occurredAt: new Date().toISOString(),
      })
      .catch((e) => logCaughtWarning('[ApprovalService] approval notice dispatch failed:', e));
  }

  /**
   * DECIDE (§6.1, AZ-16, T7): board-only — the ROUTE has established an
   * authenticated SESSION with a consumed step-up token and self-scope
   * containment. Approve may EDIT the authority DOWN (never up); a
   * decision re-runs the FULL mint validation and refuses loudly on
   * failure (the approval stays pending). Deny records the reason.
   */
  async decide(input: {
    approvalId: string;
    decision: 'approve' | 'deny';
    editedScopes?: unknown;
    editedRules?: unknown;
    denialReason?: unknown;
    deciderPrincipalId: string;
    stepUp: { tokenId: string; method: string };
  }, actor: AuditActor): Promise<ApprovalRecord> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT * FROM approvals WHERE id = $1 FOR UPDATE`, [input.approvalId]);
      if (locked.rows.length === 0) throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
      const row = locked.rows[0];
      if (row.status !== 'pending') {
        throw err(409, 'APPROVAL_NOT_PENDING', `this approval is ${row.status} (A17.11: single-use lifecycle)`);
      }
      if (new Date(row.pending_expires_at).getTime() <= Date.now()) {
        // Live enforcement; persist the flip on the way out.
        await this.lapse(client, String(row.id), 'PENDING_EXPIRED', actor);
        await client.query('COMMIT');
        throw err(409, 'APPROVAL_LAPSED', 'this approval passed its 7-day pending TTL (§6.1)');
      }

      if (input.decision === 'deny') {
        const reason = typeof input.denialReason === 'string' ? input.denialReason.slice(0, 500) : null;
        await client.query(
          `UPDATE approvals SET status = 'denied', decided_by_principal_id = $2, decided_at = NOW(),
                  decision_step_up = $3::jsonb, denial_reason = $4, updated_at = NOW()
            WHERE id = $1`,
          [row.id, input.deciderPrincipalId, JSON.stringify(input.stepUp), reason],
        );
        await writeApprovalEvent(client, { approvalId: String(row.id), action: 'approval.denied', actor, metadata: { reason, stepUp: input.stepUp } });
        await auditService.record({
          action: 'approval.deny', actor, resourceType: 'approval', resourceId: String(row.id),
          metadata: { reason, stepUp: input.stepUp, chain: await auditChainFor(client, String(row.requester_principal_id)) },
        }, client);
        await client.query('COMMIT');
        return this.get(String(row.id));
      }

      // Approve — possibly edited DOWN (§6.1): the edited authority must
      // lie within the request.
      const requestedScopes = parseJson<string[]>(row.requested_scopes, []);
      const requestedRules = parseJson<ProfileRule[]>(row.requested_rules, []);
      let approvedScopes = requestedScopes;
      let approvedRules = requestedRules;
      if (input.editedScopes !== undefined && input.editedScopes !== null) {
        approvedScopes = validateRequestedScopes(input.editedScopes);
        const check = scopesWithin(requestedScopes, approvedScopes);
        if (!check.within) {
          throw err(422, 'EDIT_ONLY_NARROWS', `the approver edits authority DOWN (§6.1): ${check.exceeding.join(', ')} was never requested`);
        }
      }
      if (input.editedRules !== undefined && input.editedRules !== null) {
        approvedRules = Array.isArray(input.editedRules) && input.editedRules.length === 0 ? [] : validateRules(input.editedRules);
        const check = rulesCovered(sourcesFromRules(requestedRules), approvedRules);
        if (!check.covered) {
          throw err(422, 'EDIT_ONLY_NARROWS', `the approver edits authority DOWN (§6.1): ${JSON.stringify(check.failing)} was never requested`);
        }
      }

      // The FULL mint validation at decision time (§6.1): holder live, the
      // BOUND credential live and un-graced, task mintable, authority ⊆
      // the requester's CURRENT effective set. Refuse loudly; stay pending.
      await agentMintService.assertRequesterLive(String(row.requester_principal_id), row.requesting_credential_id ? String(row.requesting_credential_id) : null);
      await agentMintService.assertTaskMintable(client, String(row.target_task_id));
      const credential = await client.query('SELECT scopes FROM principal_credentials WHERE id = $1', [row.requesting_credential_id]);
      const credentialScopes = parseJson<string[]>(credential.rows[0]?.scopes, []);
      // Review 1897c959 B2 (§6.1/T27): the decision compares against the
      // requester's CURRENT effective set — the production chain evaluator
      // over the bound credential — never the raw stored scopes, so an
      // own()/role narrowing between request and decision refuses HERE.
      const effectiveNow = await agentMintService.currentEffectiveScopes(
        String(row.requester_principal_id), credentialScopes);
      agentMintService.assertScopesWithinEffective(effectiveNow, approvedScopes);
      await agentMintService.assertObjectAuthorityCovers(String(row.requester_principal_id), approvedRules);

      await client.query(
        `UPDATE approvals SET status = 'approved', approved_scopes = $2::jsonb, approved_rules = $3::jsonb,
                decided_by_principal_id = $4, decided_at = NOW(), decision_step_up = $5::jsonb,
                collect_expires_at = $6, updated_at = NOW()
          WHERE id = $1`,
        [
          row.id, JSON.stringify(approvedScopes), JSON.stringify(approvedRules),
          input.deciderPrincipalId, JSON.stringify(input.stepUp),
          new Date(Date.now() + APPROVAL_COLLECT_TTL_MS),
        ],
      );
      await writeApprovalEvent(client, {
        approvalId: String(row.id), action: 'approval.approved', actor,
        metadata: { approvedScopes, approvedRules, edited: approvedScopes !== requestedScopes || approvedRules !== requestedRules, stepUp: input.stepUp },
      });
      await auditService.record({
        action: 'approval.approve', actor, resourceType: 'approval', resourceId: String(row.id),
        metadata: {
          approvedScopes, approvedRules, stepUp: input.stepUp,
          chain: await auditChainFor(client, String(row.requester_principal_id)),
        },
      }, client);
      await client.query('COMMIT');
      return this.get(String(row.id));
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await auditRefusal('approval.decide', e, actor,
        { type: 'approval', id: input.approvalId }, null);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * COLLECT (§6.1, AZ-31c, T27): single-use, by the SAME connector
   * credential that requested, within the 24h TTL. Re-runs the COMPLETE
   * mint validation TRANSACTIONALLY with Approval consumption and
   * Principal/Credential creation. Terminal failure → lapse with audited
   * reason; transient failure → refuse WITHOUT consuming.
   */
  async collect(input: {
    approvalId: string;
    presentingCredentialId: string;
    presentingPrincipalId: string;
    presentingEffectiveScopes: string[];
  }, actor: AuditActor): Promise<MintedAgentPack> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT * FROM approvals WHERE id = $1 FOR UPDATE`, [input.approvalId]);
      if (locked.rows.length === 0) throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
      const row = locked.rows[0];
      // Binding: the SAME credential that requested. Conceal foreign rows.
      if (!row.requesting_credential_id || String(row.requesting_credential_id) !== input.presentingCredentialId) {
        throw err(404, 'APPROVAL_NOT_FOUND', 'No such approval');
      }
      if (row.status !== 'approved') {
        throw err(409, 'APPROVAL_NOT_COLLECTABLE', `this approval is ${row.status} (A17.11: collect consumes an approved authorization exactly once)`);
      }
      if (row.collect_expires_at && new Date(row.collect_expires_at).getTime() <= Date.now()) {
        await this.lapse(client, String(row.id), 'COLLECT_TTL_EXPIRED', actor);
        await client.query('COMMIT');
        throw err(409, 'APPROVAL_LAPSED', 'this approval passed its 24h collect TTL (§6.1)');
      }

      const approvedScopes = parseJson<string[]>(row.approved_scopes, []);
      const approvedRules = parseJson<ProfileRule[]>(row.approved_rules, []);
      // ── Round-1 review finding S3-F1 (`b7348598`) ──
      //
      // COLLECT used the STORED scope list unchanged. `AgentMintService`'s
      // own header says every mint path re-runs the complete validation at
      // authority-exercise time, and every other path does: the warrant
      // request, the session mint, the approval request and the approval edit
      // all call `validateRequestedScopes`. COLLECT did not, so an approval
      // granted BEFORE a scope entered `AGENT_EXCLUDED_SCOPES` could still
      // mint that scope afterwards — the exclusion would be true of new
      // requests and false of stored ones.
      //
      // It runs FIRST inside the terminal-validation try, so nothing else
      // consumes an illegal list, and a refusal LAPSES the approval through
      // the shipped T27 path exactly as any other terminal failure does. It
      // is strictly fail-closed: a still-legal stored list is unchanged. It
      // also hardens §5.2 rules 2 and 3 on this path, which were equally
      // unchecked here — `root` and `*:admin` in a stored approval.
      let mintScopes: string[] = approvedScopes;
      try {
        mintScopes = validateRequestedScopes(approvedScopes);
        // The COMPLETE mint validation, NOW (§6.1): requester live and
        // un-graced, current authority, task mintable, writer slot free.
        await agentMintService.assertRequesterLive(String(row.requester_principal_id), String(row.requesting_credential_id));
        await agentMintService.assertTaskMintable(client, String(row.target_task_id));
        await agentMintService.assertWriterSlotFree(client, String(row.target_task_id), mintScopes);
        agentMintService.assertScopesWithinEffective(input.presentingEffectiveScopes, mintScopes);
        await agentMintService.assertObjectAuthorityCovers(String(row.requester_principal_id), approvedRules);
      } catch (validation) {
        if (validation instanceof AgentMintError && validation.disposition === 'terminal') {
          // T27: a terminal failure LAPSES the approval with the reason.
          await this.lapse(client, String(row.id), validation.code, actor);
          await client.query('COMMIT');
          throw err(409, 'APPROVAL_LAPSED', `collect failed terminally and lapsed the approval (§6.1): ${validation.message}`);
        }
        // Transient: refuse WITHOUT consuming — it stays approved until TTL.
        throw validation;
      }

      const pack = await agentMintService.executeMint(client, {
        targetTaskId: String(row.target_task_id),
        authority: { scopes: mintScopes, rules: approvedRules },
        parentPrincipalId: input.presentingPrincipalId,
        mintedUnderWarrantId: null,
        label: null,
      }, actor);
      await client.query(
        `UPDATE approvals SET status = 'collected', collected_at = NOW(), minted_principal_id = $2, updated_at = NOW()
          WHERE id = $1`,
        [row.id, pack.principalId],
      );
      await writeApprovalEvent(client, {
        approvalId: String(row.id), action: 'approval.collected', actor,
        metadata: { mintedPrincipalId: pack.principalId },
      });
      await auditService.record({
        action: 'approval.collect', actor, resourceType: 'approval', resourceId: String(row.id),
        metadata: { mintedPrincipalId: pack.principalId, chain: await auditChainFor(client, pack.principalId) },
      }, client);
      await client.query('COMMIT');
      return pack;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await auditRefusal('approval.collect', e, actor,
        { type: 'approval', id: input.approvalId }, input.presentingPrincipalId);
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * SESSION MINT (§6.1a): the atomic human-Account path. The ROUTE has
   * established the authenticated session and CONSUMED the step-up token
   * bound to this act. One transaction: Approval row
   * created→approved→collected with session evidence, full validation,
   * principal + credential creation; the pack renders once in the response.
   */
  async sessionMint(input: {
    accountPrincipalId: string;
    sessionScopes: string[];
    targetTaskId: string;
    requestedScopes: unknown;
    requestedRules?: unknown;
    label?: unknown;
    stepUp: { tokenId: string; method: string };
    /**
     * WHO IS ASKING, for the target-authority re-check below (round-1 review
     * P2). Required rather than optional: a caller that forgets it must fail
     * to compile, because the alternative is a mint that silently skips the
     * only check standing between a session and a Task it may not read.
     */
    authorizationActor: AuthorizationActor;
  }, actor: AuditActor): Promise<{ approval: ApprovalRecord; pack: MintedAgentPack }> {
    const account = await principalService.getPrincipalById(input.accountPrincipalId);
    if (!account) throw err(404, 'ACCOUNT_NOT_FOUND', 'the session principal resolves to no row');
    if (account.legacyIdentity) throw err(409, 'LEGACY_FROZEN', 'legacy identities are frozen out of the mint machinery (§10, T37)');
    if (account.kind !== 'human' || account.parentPrincipalId) {
      // Service Accounts have no session and act through Connectors (§6.1a).
      throw err(422, 'SESSION_MINT_IS_HUMAN', 'the session mint is the direct HUMAN Account → Agent path (§6.1a)');
    }
    if (account.status !== 'active') throw err(409, 'ACCOUNT_NOT_ACTIVE', `the session Account is ${account.status}`);
    if (!UUID_PATTERN.test(input.targetTaskId ?? '')) {
      throw err(422, 'INVALID_MINT_REQUEST', 'targetTaskId must be a full UUID');
    }
    const scopes = validateRequestedScopes(input.requestedScopes);
    const rules = input.requestedRules === undefined || input.requestedRules === null
      ? []
      : validateRules(input.requestedRules);
    const label = typeof input.label === 'string' ? input.label.slice(0, 128) : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // ── the target ceiling, re-evaluated ON THIS TRANSACTION (review P2) ──
      //
      // The route authorizes the target before compiling the Brief, which is
      // where the concealed refusal belongs. But that decision was reached on
      // the pool, in a separate operation, and the durable act happens here:
      // between the two sit the Task read and the Brief compile, and any
      // visibility, ownership, role, grant or profile change landing in that
      // window would have been minted straight through. So the SAME predicate
      // runs again, on THIS connection, immediately before anything durable is
      // created — `authorizedIds` takes the queryable for exactly this reason.
      //
      // What this does and does not buy, stated plainly: the window shrinks
      // from "route check, Task read, Brief compile, new transaction" to the
      // statements below, and nothing is disclosed or created before it — the
      // Brief rides the RESPONSE, which only exists if this transaction
      // commits. It is NOT serialisable: a revocation committing between this
      // SELECT and the COMMIT is still admitted under READ COMMITTED. Closing
      // that needs a locking or version protocol over the Task and the
      // authority rows, which is a design act, not a hardening edit.
      //
      // It runs BEFORE the lifecycle check on purpose: a caller with no
      // authority over the target learns nothing about its state, not even
      // whether it is terminal.
      const authorizedTargets = await authorizationRepository.authorizedIds(
        input.authorizationActor, 'task', [input.targetTaskId], 'read', client,
      );
      if (!authorizedTargets.has(String(input.targetTaskId))) {
        // The SAME words the route uses for an absent target, so the refusal
        // is one answer with one meaning wherever it is raised.
        throw err(404, 'TASK_NOT_FOUND', 'target task resolves to no row');
      }
      await agentMintService.assertTaskMintable(client, input.targetTaskId);
      await agentMintService.assertWriterSlotFree(client, input.targetTaskId, scopes);
      // §5.2 rule 1: base = the Account's OWN effective authority; step-up
      // authorized the ACT and never widened the ceiling.
      agentMintService.assertScopesWithinEffective(input.sessionScopes, scopes);
      await agentMintService.assertObjectAuthorityCovers(input.accountPrincipalId, rules);

      const sessionEvidence = { kind: 'session-mint', stepUp: input.stepUp, at: new Date().toISOString() };
      const created = await client.query(
        `INSERT INTO approvals
           (status, requester_principal_id, requesting_credential_id, session_evidence,
            target_task_id, requested_scopes, requested_rules,
            approved_scopes, approved_rules, decided_by_principal_id, decided_at,
            decision_step_up, pending_expires_at, collect_expires_at)
         VALUES ('approved', $1, NULL, $2::jsonb, $3, $4::jsonb, $5::jsonb,
                 $4::jsonb, $5::jsonb, $1, NOW(), $6::jsonb, NOW(), NOW() + INTERVAL '1 minute')
         RETURNING id`,
        [
          input.accountPrincipalId, JSON.stringify(sessionEvidence), input.targetTaskId,
          JSON.stringify(scopes), JSON.stringify(rules), JSON.stringify(input.stepUp),
        ],
      );
      const approvalId = String(created.rows[0].id);
      const pack = await agentMintService.executeMint(client, {
        targetTaskId: input.targetTaskId,
        authority: { scopes, rules },
        // §6.1a: the Account is the parent — the only legal producer of
        // the Account→Agent chain shape.
        parentPrincipalId: input.accountPrincipalId,
        mintedUnderWarrantId: null,
        label,
      }, actor);
      await client.query(
        `UPDATE approvals SET status = 'collected', collected_at = NOW(), minted_principal_id = $2, updated_at = NOW()
          WHERE id = $1`,
        [approvalId, pack.principalId],
      );
      for (const action of ['approval.requested', 'approval.approved', 'approval.collected']) {
        await writeApprovalEvent(client, {
          approvalId, action, actor, metadata: { sessionMint: true, stepUp: input.stepUp },
        });
      }
      await auditService.record({
        action: 'approval.session_mint', actor,
        resourceType: 'approval', resourceId: approvalId,
        metadata: {
          mintedPrincipalId: pack.principalId, targetTaskId: input.targetTaskId,
          scopes, rules, stepUp: input.stepUp,
          chain: await auditChainFor(client, pack.principalId),
        },
      }, client);
      await client.query('COMMIT');
      return { approval: await this.get(approvalId), pack };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await auditRefusal('approval.session_mint', e, actor,
        { type: 'principal', id: input.accountPrincipalId }, input.accountPrincipalId);
      throw e;
    } finally {
      client.release();
    }
  }

  private async lapse(
    queryable: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> },
    approvalId: string,
    reason: string,
    actor: AuditActor,
  ): Promise<void> {
    await queryable.query(
      `UPDATE approvals SET status = 'lapsed', lapse_reason = $2, updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'approved')`,
      [approvalId, reason],
    );
    await writeApprovalEvent(queryable, { approvalId, action: 'approval.lapsed', actor, metadata: { reason } });
    await auditService.record({
      action: 'approval.lapse', actor, resourceType: 'approval', resourceId: approvalId,
      metadata: { reason },
    }, queryable as any);
  }

  /** TTL sweep (§6.1): persists pending/collect TTL flips. Decide/collect
   * enforce the TTLs live regardless. */
  async sweepTtls(actor: AuditActor = { handle: 'system', authMethod: 'system' }): Promise<number> {
    const due = await pool.query(
      `SELECT id, status FROM approvals
        WHERE (status = 'pending' AND pending_expires_at <= NOW())
           OR (status = 'approved' AND collect_expires_at IS NOT NULL AND collect_expires_at <= NOW())`,
    );
    for (const row of due.rows) {
      await this.lapse(pool, String(row.id), row.status === 'pending' ? 'PENDING_EXPIRED' : 'COLLECT_TTL_EXPIRED', actor)
        .catch((e) => logCaughtWarning('[ApprovalService] TTL sweep lapse failed:', e));
    }
    // AZ-31c: a bound credential that died OUTSIDE the hooked paths (natural
    // expiry above all) still invalidates its outstanding approvals — the
    // sweep persists the flip; decide/collect refuse live regardless.
    const deadBound = await pool.query(
      `SELECT DISTINCT a.requesting_credential_id AS id
         FROM approvals a JOIN principal_credentials c ON c.id = a.requesting_credential_id
        WHERE a.status IN ('pending', 'approved')
          AND (c.revoked_at IS NOT NULL
               OR (c.expires_at IS NOT NULL AND c.expires_at <= NOW())
               OR c.grace_until IS NOT NULL)`,
    );
    if (deadBound.rows.length > 0) {
      await invalidateApprovalsForCredentials(
        pool, deadBound.rows.map((row) => String(row.id)), 'expired', actor,
      ).catch((e) => logCaughtWarning('[ApprovalService] credential-death sweep failed:', e));
    }
    return due.rows.length + deadBound.rows.length;
  }
}

export const approvalService = new ApprovalService();
