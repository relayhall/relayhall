// AgentLifecycleService.ts — lease-tied Agent credential expiry and the
// terminal-state auto-revoke (RH-P3.AZ-S5, card bb4a5f79; AUTHZ design
// 4d961e37 §8.4, AZ-29; T5/T6).
//
// LEASE COUPLING (AZ-29): the mint fixes a MAX-AGE (default 24h, a warrant
// may set it) — the maximum FORWARD life window of the Agent credential at
// any moment. Each EXPLICIT lease renewal (the orchestration heartbeat —
// strategy §2.6.5: lease renewal only via the explicit claim-renew call)
// re-ups the credential expiry to NOW() + max-age. Nothing else extends:
// telemetry frames have zero server-side effect, and reads never renew.
//
// BLOCKED EXTENSIONS: a warrant that is revoked/suspended/expired blocks
// further extensions for the identities minted under it (§6.4: "current
// leases run out, no more"), and a terminal bound task never extends.
// A blocked extension is silent-refused for the caller (the heartbeat
// itself still succeeds — the lease is the task plane) but leaves a
// durable audit row, so the runway shortening is visible.
//
// AUTO-REVOKE (AZ-29, sol B6): fires on the ENUMERATED terminal states —
// `completed` and `archived` ONLY (never review, never stuck; `skipped`
// is Subtask-only and cannot reach this logic). Review-rejection rework
// continues on the same Agent while its lease and max-age live. The sweep
// PERSISTS the flips and emits events; the auth middleware enforces the
// terminal state LIVE on every request either way (T6 — a between-sweep
// replay dies in authentication, not here). Expiry is one-way: reopening
// a task never resurrects a revoked credential (revoked_at never clears).
import { pool } from '../db/connection';
import { auditService, type AuditActor } from './AuditService';
import { auditChainFor } from '../utils/auditChain';
import { logCaughtWarning } from '../utils/secretSafeLog';
import { invalidateApprovalsForCredentials } from '../utils/approvalInvalidation';

export const AGENT_DEFAULT_MAX_AGE_HOURS = 24;

export class AgentLifecycleService {
  /**
   * Extend the acting Agent's live credentials on an EXPLICIT lease
   * renewal for its bound task. No-op (with a durable audited refusal
   * where a block applies) in every other case. Never throws — the lease
   * plane must not fail because the credential plane declined to extend.
   */
  async extendOnLeaseRenewal(actingPrincipalId: string, taskId: string, actor: AuditActor): Promise<{ extended: boolean; blockedReason: string | null }> {
    try {
      const agent = await pool.query(
        `SELECT p.id, p.kind, p.bound_task_id, p.legacy_identity, p.minted_under_warrant_id,
                w.status AS warrant_status,
                (w.expires_at IS NOT NULL AND w.expires_at <= NOW()) AS warrant_date_past,
                t.status AS task_status
           FROM principals p
           LEFT JOIN warrants w ON w.id = p.minted_under_warrant_id
           LEFT JOIN tasks t ON t.id = p.bound_task_id
          WHERE p.id = $1`,
        [actingPrincipalId],
      );
      const row = agent.rows[0];
      if (!row || row.kind !== 'agent' || row.legacy_identity) return { extended: false, blockedReason: null };
      if (!row.bound_task_id || String(row.bound_task_id) !== taskId) return { extended: false, blockedReason: null };

      let blockedReason: string | null = null;
      if (['completed', 'archived'].includes(String(row.task_status ?? ''))) {
        blockedReason = 'TASK_TERMINAL';
      } else if (row.minted_under_warrant_id
        && (String(row.warrant_status) !== 'active' || row.warrant_date_past === true)) {
        // §6.4: warrant revocation (and suspension/expiry) blocks further
        // lease-driven extensions — the current runway runs out, no more.
        blockedReason = `WARRANT_${String(row.warrant_status ?? 'expired').toUpperCase()}`;
      }
      if (blockedReason) {
        await auditService.record({
          action: 'credential.extend', actor, outcome: 'denied',
          resourceType: 'principal', resourceId: actingPrincipalId,
          metadata: { refusal: blockedReason, taskId, chain: await auditChainFor(pool, actingPrincipalId) },
        }).catch(() => undefined);
        return { extended: false, blockedReason };
      }

      // AZ-29: re-up to NOW() + max-age (the metadata fixed at mint) —
      // never shortening an already-later expiry, never reviving a
      // revoked or already-expired credential.
      const extended = await pool.query(
        `UPDATE principal_credentials c
            SET expires_at = GREATEST(
                  c.expires_at,
                  NOW() + make_interval(hours => COALESCE((c.metadata->>'max_age_hours')::int, $2)))
          WHERE c.principal_id = $1
            AND c.revoked_at IS NULL
            AND c.grace_until IS NULL
            AND c.expires_at IS NOT NULL
            AND c.expires_at > NOW()
          RETURNING c.id, c.expires_at`,
        [actingPrincipalId, AGENT_DEFAULT_MAX_AGE_HOURS],
      );
      if (extended.rows.length === 0) return { extended: false, blockedReason: null };
      await auditService.record({
        action: 'credential.extend', actor,
        resourceType: 'principal', resourceId: actingPrincipalId,
        metadata: {
          taskId,
          credentialIds: extended.rows.map((r) => String(r.id)),
          newExpiry: new Date(extended.rows[0].expires_at).toISOString(),
          chain: await auditChainFor(pool, actingPrincipalId),
        },
      }).catch(() => undefined);
      return { extended: true, blockedReason: null };
    } catch (e) {
      logCaughtWarning('[AgentLifecycle] lease-extension pass failed:', e);
      return { extended: false, blockedReason: null };
    }
  }

  /**
   * The terminal-state auto-revoke sweep (AZ-29): persist revocations for
   * live Agent credentials whose bound task is in the ENUMERATED terminal
   * set. The middleware already refuses these live (T6); this writes the
   * durable state, the audit rows and the AZ-31c approval invalidations.
   */
  async sweepTerminalAgents(actor: AuditActor = { handle: 'system', authMethod: 'system' }): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const revoked = await client.query(
        `UPDATE principal_credentials c
            SET revoked_at = NOW(),
                metadata = jsonb_set(c.metadata, '{revoke_reason}',
                  to_jsonb('bound task terminal (AZ-29 auto-revoke)'::text))
          FROM principals p, tasks t
          WHERE c.principal_id = p.id
            AND p.kind = 'agent' AND NOT p.legacy_identity
            AND t.id = p.bound_task_id
            AND t.status IN ('completed', 'archived')
            AND c.revoked_at IS NULL
          RETURNING c.id, p.id AS principal_id, t.id AS task_id, t.status AS task_status`,
        [],
      );
      if (revoked.rows.length === 0) {
        await client.query('ROLLBACK');
        return 0;
      }
      await invalidateApprovalsForCredentials(
        client, revoked.rows.map((r) => String(r.id)), 'revoked', actor,
      );
      for (const row of revoked.rows) {
        await auditService.record({
          action: 'credential.revoke', actor,
          resourceType: 'credential', resourceId: String(row.id),
          metadata: {
            reason: 'bound task terminal (AZ-29 auto-revoke)',
            principalId: String(row.principal_id),
            taskId: String(row.task_id),
            taskStatus: String(row.task_status),
            chain: await auditChainFor(client, String(row.principal_id)),
          },
        }, client);
      }
      await client.query('COMMIT');
      return revoked.rows.length;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      logCaughtWarning('[AgentLifecycle] terminal-agent sweep failed:', e);
      return 0;
    } finally {
      client.release();
    }
  }
}

export const agentLifecycleService = new AgentLifecycleService();
