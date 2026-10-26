// ReportAccountOwnershipService.ts — the ONE writer that moves a standalone
// Report's account owner (change-request design section 3 `report.account_owner`,
// section 12 Q31 (a), ratified by owner ruling E325; train T2 slice S5, card
// 9ce0b0b0).
//
// A Report's account owner is set once, at creation (GrantService
// .createForReportCreator records it), and until this slice had no transfer
// act at all (R1-F08). The design adds a NEW small executor rather than a
// route: the move is reachable ONLY as an approved change request, applied
// inside the decide transaction with the DECIDER as the acting principal. So
// there is no direct door here to keep in step, and nothing in this file reads
// a request body.
//
// What it writes, and nothing else: the governed column
// `reports.account_owner_principal_id`, and one audit row
// `report.account_owner.change` with the old and new owner and the decision's
// ledger, in the caller's transaction. Its refusals, all before the write:
//   - the Report is absent or tombstoned (404), archived (409), or TASK-BOUND
//     (a task-report: never account-owned, R1-F04) (422 REPORT_TASK_BOUND);
//   - the target is not an active, non-legacy, parentless HUMAN Account that
//     can read and write Reports (422 INVALID_ACCOUNT_OWNER, INEFFECTIVE_OWNER):
//     a Group, a Connector or an Agent never owns a Report this way;
//   - the target already owns it (409 ALREADY_HELD);
//   - the current owner differs from the one the decision approved against
//     (409 ACCOUNT_OWNER_STATE_CHANGED).
// Authorization is the CALLER's: the change-request decide has already run
// the ordered predicate and the decider's own reach on the Report before it
// calls this.
import type { PoolClient } from 'pg';
import { auditService, type AuditActor } from './AuditService';
import { authorizationService } from './AuthorizationService';
import { scopesForRole } from '../utils/identityScopes';
import { feedEventService } from './FeedEventService';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ReportAccountOwnershipError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ReportAccountOwnershipError';
  }
}

export interface ReportAccountOwnerMove {
  reportId: string;
  accountOwnerPrincipalId: string;
  /** The owner the decision approved against (null: the Report had none). */
  expectedAccountOwnerPrincipalId: string | null;
  actor: AuditActor;
  /** The decision's ledger, carried on the act's own audit row (section 7.1). */
  ledger: Record<string, unknown>;
}

/** Whether a principal row is an Account that may own a Report: active, human, parentless, non-legacy, with reports read and write. */
export function reportOwnerProblem(row: { kind?: unknown; status?: unknown; parent_principal_id?: unknown; legacy_identity?: unknown;
  id?: unknown; handle?: unknown; role?: unknown } | undefined): { code: string; message: string } | null {
  if (!row || row.kind !== 'human' || row.status !== 'active' || row.parent_principal_id || row.legacy_identity) {
    return { code: 'INVALID_ACCOUNT_OWNER', message: 'A Report is owned by an active human Account: not a Group, a Connector or an Agent' };
  }
  const actor = {
    authenticated: true, principalId: String(row.id), handle: String(row.handle ?? ''), role: (row.role as string | null) ?? null,
    scopes: scopesForRole((row.role as string | null) ?? null),
  };
  if (!authorizationService.authorizeRoute(actor, 'reports:read').allowed || !authorizationService.authorizeRoute(actor, 'reports:write').allowed) {
    return { code: 'INEFFECTIVE_OWNER', message: 'The selected Account cannot read and write Reports' };
  }
  return null;
}

export class ReportAccountOwnershipService {
  async changeWithin(client: PoolClient, move: ReportAccountOwnerMove): Promise<{ previous: string | null; next: string }> {
    if (!UUID.test(String(move.reportId)) || !UUID.test(String(move.accountOwnerPrincipalId))) {
      throw new ReportAccountOwnershipError(422, 'INVALID_ACCOUNT_OWNER', 'The Report and the new account owner are named by UUID');
    }
    const next = String(move.accountOwnerPrincipalId).toLowerCase();
    const found = await client.query(
      `SELECT id, project_id, status, origin, source_task_id, deleted_at, account_owner_principal_id, author_principal_id
         FROM reports WHERE id = $1 FOR UPDATE`, [move.reportId]);
    const report = found.rows[0];
    if (!report || report.deleted_at) throw new ReportAccountOwnershipError(404, 'REPORT_NOT_FOUND', 'Report not found');
    if (report.origin === 'task-report' || report.source_task_id) {
      throw new ReportAccountOwnershipError(422, 'REPORT_TASK_BOUND', 'A task-bound Report is never account-owned: it belongs to its Task');
    }
    if (report.status === 'archived') throw new ReportAccountOwnershipError(409, 'REPORT_ARCHIVED', 'The Report is archived and read-only; restore it first');
    const previous: string | null = report.account_owner_principal_id ? String(report.account_owner_principal_id).toLowerCase() : null;
    const expected = move.expectedAccountOwnerPrincipalId ? String(move.expectedAccountOwnerPrincipalId).toLowerCase() : null;
    if (previous !== expected) {
      throw new ReportAccountOwnershipError(409, 'ACCOUNT_OWNER_STATE_CHANGED', "The Report's account owner changed since the decision read it");
    }
    if (previous === next) throw new ReportAccountOwnershipError(409, 'ALREADY_HELD', 'That Account already owns the Report');
    const target = (await client.query(
      'SELECT id, handle, kind, role, status, parent_principal_id, legacy_identity FROM principals WHERE id = $1 FOR SHARE', [next])).rows[0];
    const problem = reportOwnerProblem(target);
    if (problem) throw new ReportAccountOwnershipError(422, problem.code, problem.message);
    await client.query(
      'UPDATE reports SET account_owner_principal_id = $2, updated_at = NOW() WHERE id = $1', [move.reportId, next]);
    await auditService.record({
      action: 'report.account_owner.change', actor: move.actor, resourceType: 'report', resourceId: String(report.id),
      metadata: {
        ...move.ledger,
        oldAccountOwnerPrincipalId: previous, newAccountOwnerPrincipalId: next,
        authorPrincipalId: report.author_principal_id ? String(report.author_principal_id) : null,
      },
    }, client);
    await feedEventService.emit(client, {
      name: 'report.updated', objectType: 'report', objectId: String(report.id),
      actorPrincipalId: move.actor.principalId ?? null, actorHandle: move.actor.handle ?? null,
      projectId: report.project_id ? String(report.project_id) : null,
      // The feed's owner is the author column, as every report.* event names it (ReportManager.ownerPrincipalId).
      ownerPrincipalId: report.author_principal_id ? String(report.author_principal_id) : null, payload: {},
    });
    return { previous, next };
  }
}

export const reportAccountOwnershipService = new ReportAccountOwnershipService();
