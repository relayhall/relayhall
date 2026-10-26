// accessRequestTerminal.ts — AZ-A9 clause 12a (ratified 2026-10-10, E43; card
// 785e1eed P1-B and P1-B-2): request-made authority is revoked at
// task-terminal or phase-terminal and never reused.
//
// E15, verbatim: "any grant or credential attached to a task is REVOKED
// immediately when that task is completed or archived and is never reused"
// (OWNER-DECISIONS-2026-10-09.md:219). This extends §8.4's enumerated set
// ("`completed` and `archived` ONLY … NOT review, NOT stuck") and its one-way
// rule ("reopening a task never resurrects a revoked credential") to the grant
// rows a grant-kind Approval wrote and the credential a credential-kind
// Approval issued.
//
// THE CALLERS. There are TWO writers that move a Task into a terminal status,
// and both call this inside their own transaction, after the AZ-S7 vehicle
// detach:
//   - `TaskManagerDB.updateTask` — PATCH, archive (`TaskManagerDB` archive
//     path) and auto-archive (`autoArchive.ts`) all reach it;
//   - `TaskReviewAttemptService.recordVerdict` — the verifier's verdict, the
//     authoritative review -> terminal write that a later updateTask never sees.
// A hard delete of the Task (`TaskManagerDB.deleteTask`) is terminal too: it
// runs here before the DELETE, because the related FK is ON DELETE SET NULL
// and would otherwise detach the request from the rows it wrote.
//
// THE PHASE ARM (E43 Q3, binding). A request that names a phase and no task is
// attached to that phase: when the phase reaches completed or archived, the
// same acts happen in the phase write's own transaction, with reason
// PHASE_TERMINAL. `PhaseService.update`, `PhaseService.archive` and
// `PhaseService.remove` are its three callers. Reversing it needs a new
// amendment.
//
// WHAT HAPPENS, in the caller's transaction:
//   1. every grant row whose `approval_id` names a grant-kind Approval related
//      to the subject is revoked (`grant.revoke` {reason, approvalId}), and the
//      Approval records one `approval.revoked` event. The Approval stays
//      'approved' (terminal for kind grant — migration 142), so nothing can
//      bring the rows back: new authority needs a new request;
//   2. every credential a collected credential-kind Approval related to the
//      subject issued is revoked "through the existing credential revoke"
//      (`PrincipalService.revokeCredentialById`, on THIS transaction, through
//      `issued_credential_id`), and the Approval records one `approval.revoked`
//      event. It stays 'collected' (terminal), so nothing restores it;
//   3. every still-pending or approved-uncollected request related to the
//      subject lapses with the reason (TASK_TERMINAL / PHASE_TERMINAL);
//   4. (AZ-A13 clause 6j, E94; card 1a38270d) every edit approved "until this
//      task ends" with this task as its related task is REVERTED: only what
//      its widening added and is still present is removed, through
//      `AuthorityEditExecutor` as a narrowing, each under a SAVEPOINT so a
//      failed revert never blocks the task's terminal (the periodic sweep
//      retries it). It runs at completed, archived AND a hard delete, before
//      the delete's ON DELETE SET NULL detaches the record from its task.
//
// An `authority-edit` request is NOT lapsed at step 3: clauses 6a and 6f make
// its related task and phase references only. Clause 12a does not apply to it
// (D-14): its approval wrote no grant row and issued no credential.
//
// ONE SHARED ROW (checker's v2 log, "not verified", left to this lane). An
// assignment vehicle LINKS an existing tuple instead of inserting a second one
// (`AccessVehicleService.ensureGrant`, created_by_vehicle = FALSE), and both
// land on the chain-root Account. So a request-made row can be the very row
// another Task's assignee reads through. Deleting it would recreate the
// assigned-but-invisible state ruling 7440b579 R1 makes unrepresentable. Such a
// row is HANDED OVER instead: the approval's claim on it ends (approval_id
// NULL, an `approval.revoked` event and a `grant.handover` audit), and the
// vehicle that links it owns it from now on (provenance set, its links marked
// created_by_vehicle), so it is reaped when that assignment ends. The grant
// rows are taken FOR UPDATE before their links are read; the vehicle takes its
// target rows NOWAIT, so a vehicle meeting this transaction refuses
// ASSIGNMENT_REFERENCE_BUSY and retries against the settled row.
import type { PoolClient } from 'pg';
import { auditService, type AuditActor } from '../services/AuditService';
import { feedEventService, type FeedObjectType } from '../services/FeedEventService';
import { principalService } from '../services/PrincipalService';

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

export const TASK_TERMINAL_REASON = 'TASK_TERMINAL';
export const PHASE_TERMINAL_REASON = 'PHASE_TERMINAL';

export interface AccessRequestTerminalSubject {
  type: 'task' | 'phase';
  id: string;
  /** The status reached, or `deleted` for a hard delete. */
  to: 'completed' | 'archived' | 'deleted';
  /** Which writer got there — recorded on every event so the ledger can tell
   * the verdict path from a PATCH (`finish`: a `none` Task's finish, E462 S4b). */
  via: 'updateTask' | 'recordVerdict' | 'deleteTask' | 'finish' | 'phase.update' | 'phase.archive' | 'phase.remove';
}

export interface AccessRequestTerminalResult {
  revokedGrantIds: string[];
  handedOverGrantIds: string[];
  revokedCredentialIds: string[];
  revokedApprovalIds: string[];
  lapsedApprovalIds: string[];
  /** AZ-A13 clause 6j: the until-task edits reverted (or closed) at this terminal. */
  revertedEditApprovalIds: string[];
}

const FEED_OBJECT_TYPES = new Set(['task', 'phase', 'project', 'report', 'skill', 'personality']);

export async function reapAccessRequestsAtTerminal(
  client: Queryable,
  subject: AccessRequestTerminalSubject,
  actor: AuditActor,
): Promise<AccessRequestTerminalResult> {
  const reason = subject.type === 'task' ? TASK_TERMINAL_REASON : PHASE_TERMINAL_REASON;
  const result: AccessRequestTerminalResult = {
    revokedGrantIds: [], handedOverGrantIds: [], revokedCredentialIds: [], revokedApprovalIds: [], lapsedApprovalIds: [],
    revertedEditApprovalIds: [],
  };
  // 4. (AZ-A13 clause 6j) the until-task reverts of this task's edits. First,
  // so a hard delete has not yet detached them.
  if (subject.type === 'task') {
    // Loaded lazily: the executor reaches the warrant and vehicle services,
    // and this module is imported by the task writer they sit beside.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { authorityEditExecutor } = require('../services/AuthorityEditExecutor');
    result.revertedEditApprovalIds = await authorityEditExecutor.revertAtTaskTerminal(client, subject.id, actor);
  }
  // A request naming a task belongs to that task's terminal; the phase arm
  // reaches only requests that name a phase and NO task (E43 Q3).
  const related = await client.query(
    subject.type === 'task'
      ? `SELECT id, kind, status, issued_credential_id FROM approvals
          WHERE related_task_id = $1 AND kind <> 'agent-mint'
          ORDER BY id FOR UPDATE`
      : `SELECT id, kind, status, issued_credential_id FROM approvals
          WHERE related_phase_id = $1 AND related_task_id IS NULL AND kind <> 'agent-mint'
          ORDER BY id FOR UPDATE`,
    [subject.id],
  );
  if (related.rows.length === 0) return result;
  const where = { [`${subject.type}Id`]: subject.id, to: subject.to, via: subject.via };

  // 1. Revoke what approved grant requests wrote.
  for (const approval of related.rows.filter((row) => row.kind === 'grant' && row.status === 'approved')) {
    const approvalId = String(approval.id);
    const rows = await client.query(
      `SELECT id, grantee_type, grantee_id, resource_type, resource_id, verb, origin
         FROM grants WHERE approval_id = $1 ORDER BY id FOR UPDATE`,
      [approvalId],
    );
    // Already revoked (a reopened task completing again): nothing to record.
    if (rows.rows.length === 0) continue;
    const revoked: string[] = [];
    const handedOver: Array<{ grantId: string; taskIds: string[] }> = [];
    for (const grant of rows.rows) {
      const grantId = String(grant.id);
      const links = await client.query(
        `SELECT task_id, vehicle_kind FROM access_vehicle_links
          WHERE target_kind = 'grant' AND target_id = $1 ORDER BY task_id`,
        [grantId],
      );
      if (links.rows.length > 0) {
        const provenance = links.rows.some((link) => link.vehicle_kind === 'warrant') ? 'assignment:warrant' : 'assignment:grant';
        await client.query(
          `UPDATE grants SET approval_id = NULL, provenance = $2 WHERE id = $1`,
          [grantId, provenance],
        );
        await client.query(
          `UPDATE access_vehicle_links SET created_by_vehicle = TRUE
            WHERE target_kind = 'grant' AND target_id = $1`,
          [grantId],
        );
        const taskIds = [...new Set(links.rows.map((link) => String(link.task_id)))];
        handedOver.push({ grantId, taskIds });
        await auditService.record({
          action: 'grant.handover', actor, resourceType: 'grant', resourceId: grantId,
          metadata: {
            approvalId, kind: 'grant', retainedBy: { provenance, linkedTaskIds: taskIds },
            reason, ...where,
            granteeId: String(grant.grantee_id), resourceType: grant.resource_type,
            resourceId: grant.resource_id ?? null, verb: grant.verb,
          },
        }, client as any);
        continue;
      }
      await client.query('DELETE FROM grants WHERE id = $1', [grantId]);
      revoked.push(grantId);
      await auditService.record({
        action: 'grant.revoke', actor, resourceType: 'grant', resourceId: grantId,
        metadata: {
          automatic: true, reason, approvalId, kind: 'grant', ...where,
          granteeId: String(grant.grantee_id), resourceType: grant.resource_type,
          resourceId: grant.resource_id ?? null, verb: grant.verb, origin: grant.origin,
        },
      }, client as any);
      if (grant.resource_id && FEED_OBJECT_TYPES.has(String(grant.resource_type))) {
        await feedEventService.emit(client as any, {
          name: `${grant.resource_type}.acl_changed`,
          objectType: String(grant.resource_type) as FeedObjectType,
          objectId: String(grant.resource_id),
          actorPrincipalId: actor.principalId ?? null,
          actorHandle: actor.handle ?? null,
          // The party whose entitlement this removes (the C1 round-2 F3 rule).
          ownerPrincipalId: grant.grantee_type === 'principal' ? String(grant.grantee_id) : null,
          payload: {},
        });
      }
    }
    const metadata = {
      kind: 'grant', reason, ...where,
      revokedGrantIds: revoked, handedOverGrantIds: handedOver,
    };
    await client.query(
      `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata)
       VALUES ($1, 'approval.revoked', $2, $3, $4::jsonb)`,
      [approvalId, actor.principalId ?? null, actor.handle || 'system', JSON.stringify(metadata)],
    );
    await auditService.record({
      action: 'approval.revoke', actor, resourceType: 'approval', resourceId: approvalId, metadata,
    }, client as any);
    result.revokedApprovalIds.push(approvalId);
    result.revokedGrantIds.push(...revoked);
    result.handedOverGrantIds.push(...handedOver.map((entry) => entry.grantId));
  }

  // 2. Revoke what collected credential requests issued, through the existing
  // credential revoke on THIS transaction (clause 13: "clause 12a revokes
  // through that column"). A credential already revoked — by an owner, or by
  // an earlier terminal of a reopened task — records nothing again.
  for (const approval of related.rows.filter((row) => row.kind === 'credential' && row.status === 'collected'
    && row.issued_credential_id)) {
    const approvalId = String(approval.id);
    const credentialId = String(approval.issued_credential_id);
    const revokedNow = await principalService.revokeCredentialById(credentialId, reason, actor, client as PoolClient);
    if (!revokedNow) continue;
    const metadata = { kind: 'credential', reason, ...where, revokedCredentialIds: [credentialId] };
    await client.query(
      `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata)
       VALUES ($1, 'approval.revoked', $2, $3, $4::jsonb)`,
      [approvalId, actor.principalId ?? null, actor.handle || 'system', JSON.stringify(metadata)],
    );
    await auditService.record({
      action: 'approval.revoke', actor, resourceType: 'approval', resourceId: approvalId, metadata,
    }, client as any);
    result.revokedApprovalIds.push(approvalId);
    result.revokedCredentialIds.push(credentialId);
  }

  // 3. Lapse what is still waiting. For kind grant, approved is terminal and
  // was handled above; an approved CREDENTIAL request is approved-uncollected.
  const waiting = related.rows.filter((row) => row.kind !== 'authority-edit' && (row.status === 'pending'
    || (row.kind === 'credential' && row.status === 'approved')));
  for (const approval of waiting) {
    const approvalId = String(approval.id);
    const lapsed = await client.query(
      `UPDATE approvals SET status = 'lapsed', lapse_reason = $2, updated_at = NOW()
        WHERE id = $1 AND status = $3 RETURNING id`,
      [approvalId, reason, approval.status],
    );
    if (lapsed.rows.length === 0) continue;
    const metadata = { kind: String(approval.kind), reason, ...where };
    await client.query(
      `INSERT INTO approval_events (approval_id, action, actor_principal_id, actor_handle, metadata)
       VALUES ($1, 'approval.lapsed', $2, $3, $4::jsonb)`,
      [approvalId, actor.principalId ?? null, actor.handle || 'system', JSON.stringify(metadata)],
    );
    await auditService.record({
      action: 'approval.lapse', actor, resourceType: 'approval', resourceId: approvalId, metadata,
    }, client as any);
    result.lapsedApprovalIds.push(approvalId);
  }
  return result;
}
