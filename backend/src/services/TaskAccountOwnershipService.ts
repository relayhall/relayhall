import { scopesForRole } from '../utils/identityScopes';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { authorizationService } from './AuthorizationService';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { taskAccountControl } from './AccountControlService';
import { taskAuthoritySnapshot } from './TaskAuthoritySnapshot';
import { authorizationRepository } from './AuthorizationRepository';
import { auditService } from './AuditService';
import { taskHistoryService, type TaskActor } from './TaskHistoryService';
import { feedEventService } from './FeedEventService';
import { isStoredLoginSessionKind } from '../utils/administratorSession';
import { sessionIdleMs } from './LoginSessionService';
import { ResourceContractError } from './ProjectResourceService';
import {
  groupOwnershipStandingTest, groupTransferAuditFields, GroupOwnershipTransferError, type GroupTransferStanding,
} from './GroupOwnershipTransfer';
import {
  auditStewardTransferRefusal, consumeStewardTransferStepUp, stewardTransferStanding, type StewardTransferCaller,
  type StewardTransferRefusalTarget,
} from './GroupOwnerStewardTransfer';

import { ownerFactsOf, ownerFactsSql } from '../utils/ownerFacts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** AZ-A12 clause 12: the owner fields of the Task's EFFECTIVE account owner. */
const TASK_OWNER = ownerFactsSql('COALESCE(t.account_owner_principal_id, p.owner_principal_id)', 'task_owner');
export interface AccountOwnerChange {
  accountOwnerPrincipalId: string;
  expectedAccountOwnerPrincipalId: string | null;
  expectedUpdatedAt: string;
  reason: string;
}

/** Ownership is separate from Assignee. Never infer a transfer from a new
 * connector, a Project's owner, or a read of an old Task. */
async function mayTransfer(client: PoolClient, taskId: string, actor: TaskActor, groupInvolved = false): Promise<boolean> {
  // AZ-A12 clause 9(e): the Main arm is never a decider when the source or the
  // target is a Group; arm (ii) below runs unchanged.
  if (!groupInvolved && await taskAccountControl(client, taskId, actor)) return true;
  if (!actor.principalId || !actor.sessionId || !isStoredLoginSessionKind(actor.authMethod)) return false;
  const human = await client.query(`SELECT p.id, p.handle, p.role, s.role_snapshot FROM principals p JOIN auth_sessions s ON s.principal_id=p.id
    WHERE p.id=$1 AND p.kind='human' AND p.status='active' AND p.parent_principal_id IS NULL
      AND NOT p.legacy_identity AND s.id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND s.last_seen_at>clock_timestamp()-($3::double precision*interval '1 millisecond')`,
  [actor.principalId, actor.sessionId, sessionIdleMs()]);
  if (human.rows.length !== 1) return false;
  const sessionRole = resolveActorRole({ handle: human.rows[0].handle,
    principalRole: human.rows[0].role, sessionRole: human.rows[0].role_snapshot });
  if (!authorizationService.authorizeRoute({ ...actor.authorization!, scopes: scopesForRole(sessionRole) }, 'tasks:admin').allowed) return false;
  const snapshots = await taskAuthoritySnapshot(client, actor, taskId, 'tasks:admin');
  if (!snapshots) return false;
  for (const snapshot of snapshots) {
    if (!(await authorizationRepository.authorizedIds(snapshot, 'task', [taskId], 'admin', client)).has(taskId)) return false;
  }
  return true;
}

class TaskAccountOwnershipService {
  async read(taskId: string) {
    const result = await pool.query(`SELECT t.id, t.account_owner_principal_id,
      COALESCE(t.account_owner_principal_id,p.owner_principal_id) AS effective_owner,
      t.updated_at::text AS owner_revision, ${TASK_OWNER.select}
      FROM tasks t LEFT JOIN projects p ON p.id=t.project_id ${TASK_OWNER.join} WHERE t.id=$1`, [taskId]);
    if (!result.rows.length) throw new ResourceContractError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
    const row = result.rows[0];
    // AZ-A12 clause 12: the EFFECTIVE owner's kind and name, joined server-side.
    return { taskId, accountOwnerPrincipalId: row.effective_owner ?? null,
      explicitAccountOwnerPrincipalId: row.account_owner_principal_id ?? null, updatedAt: row.owner_revision,
      ...ownerFactsOf(row, row.effective_owner ?? null) };
  }

  async change(taskId: string, input: AccountOwnerChange, actor: TaskActor, standing?: GroupTransferStanding) {
    if (!input || !UUID.test(input.accountOwnerPrincipalId ?? '')
      || !(input.expectedAccountOwnerPrincipalId === null || UUID.test(input.expectedAccountOwnerPrincipalId ?? ''))
      || typeof input.expectedUpdatedAt !== 'string' || !input.expectedUpdatedAt
      || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) {
      throw new ResourceContractError(422, 'INVALID_ACCOUNT_OWNER_CHANGE', 'Supply target human account, expected account owner and updatedAt from account-owner read, and a reason');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const changed = await this.changeWithin(client, taskId, input, actor, standing);
      await client.query('COMMIT');
      return changed;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /**
   * The account-owner act on the CALLER's open transaction: the direct PUT's
   * `change` above, and (T2 S5, card 9ce0b0b0; change-request design section
   * 3 `task.account_owner`, section 7.1) an approved change applied inside its
   * decide transaction with the DECIDER as `actor` and `standing`: the same
   * standing test (a Group transfer takes the decision's consumed step-up as
   * its evidence, section 5.3) and the same `mayTransfer()` on the decider's
   * stored session, so nothing is admitted the direct door would refuse it.
   * `ledger` rides the act's own task.account_owner.change row. Its caller
   * commits or rolls back.
   */
  async changeWithin(client: PoolClient, taskId: string, input: AccountOwnerChange, actor: TaskActor, standing?: GroupTransferStanding,
    ledger: Record<string, unknown> | null = null) {
    const targetId = input.accountOwnerPrincipalId.toLowerCase();
    const expected = input.expectedAccountOwnerPrincipalId?.toLowerCase() ?? null;
    {
      const result = await client.query(`SELECT *, updated_at::text AS owner_revision FROM tasks WHERE id=$1 FOR UPDATE`, [taskId]);
      const task = result.rows[0];
      if (!task) throw new ResourceContractError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
      // AZ-A12 clause 9(e): after the row lock and BEFORE the first mayTransfer(),
      // the standing test reads the EFFECTIVE owner and the target. A Task
      // transfer always names a target, so a Group-owned Task's undo writes the
      // person it returns to as the explicit owner (9(c), declared).
      const effective = await client.query(`SELECT COALESCE(t.account_owner_principal_id, p.owner_principal_id) AS owner
        FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [task.id]);
      const evidence = await groupOwnershipStandingTest(client, {
        objectType: 'task', objectId: String(task.id).toLowerCase(),
        currentOwnerId: effective.rows[0]?.owner ?? null, targetOwnerId: targetId,
        standing: standing ?? { principalId: null, stepUpToken: '' },
        audit: { principalId: actor.principalId, handle: actor.handle, authMethod: actor.authMethod ?? 'unknown', credentialId: actor.credentialId },
        auditAction: 'task.account_owner.change',
      });
      const groupInvolved = evidence !== null;
      if (!await mayTransfer(client, taskId, actor, groupInvolved)) throw new ResourceContractError(403, 'TASK_ACCOUNT_OWNER_AUTHORITY_REQUIRED', 'Current account owner, appointed Main, or current human Task administrator required');
      if (task.status === 'archived') throw new ResourceContractError(409, 'TASK_ARCHIVED', 'Restore the Task before changing its account owner');
      // Lock inherited ownership too, so a concurrent Project transfer cannot
      // change the authority basis between comparison and commit.
      const project = task.project_id ? await client.query('SELECT owner_principal_id FROM projects WHERE id=$1 FOR SHARE', [task.project_id]) : { rows: [] };
      const previous = task.account_owner_principal_id ?? project.rows[0]?.owner_principal_id ?? null;
      if (previous !== expected || task.owner_revision !== input.expectedUpdatedAt) {
        throw new ResourceContractError(412, 'ACCOUNT_OWNER_STATE_CHANGED', 'Task ownership or content changed; reload account-owner and retry');
      }
      if (!await mayTransfer(client, taskId, actor, groupInvolved)) throw new ResourceContractError(403, 'TASK_ACCOUNT_OWNER_AUTHORITY_REQUIRED', 'Account-owner authority changed');
      const target = await client.query(`SELECT id FROM principals WHERE id=$1 AND kind='human' AND status='active'
        AND parent_principal_id IS NULL AND NOT legacy_identity FOR SHARE`, [targetId]);
      if (target.rows.length !== 1) {
        // Clause 9(a): an ACTIVE Group principal is a target too, admitted only
        // through the standing test above; a disabled one is refused.
        const group = groupInvolved ? await client.query(`SELECT id FROM principals WHERE id=$1 AND kind='group' AND status='active' FOR SHARE`, [targetId]) : { rows: [] };
        if (group.rows.length !== 1) {
          throw new GroupOwnershipTransferError(422, 'INVALID_ACCOUNT_OWNER', 'Target must be an active human account or an active Group');
        }
      }
      if (task.account_owner_principal_id === targetId) {
        return { taskId, accountOwnerPrincipalId: targetId, updatedAt: task.owner_revision, changed: false };
      }
      const updated = await client.query(`UPDATE tasks SET account_owner_principal_id=$2, updated_at=clock_timestamp()
        WHERE id=$1 RETURNING updated_at::text AS owner_revision`, [taskId, targetId]);
      await auditService.record({ action: 'task.account_owner.change',
        actor: { principalId: actor.principalId, handle: actor.handle, authMethod: actor.authMethod ?? 'unknown', credentialId: actor.credentialId },
        resourceType: 'task', resourceId: taskId,
        metadata: { oldAccountOwnerPrincipalId: previous, oldExplicitAccountOwnerPrincipalId: task.account_owner_principal_id ?? null,
          newAccountOwnerPrincipalId: targetId, reason: input.reason.trim(), independentVerification: false,
          // Section 7.1 (T2 S5): an approved change's decision; the act's own fields are never overridden by it.
          ...(ledger ?? {}),
          // Clause 9(f): kinds, member count, step-up and the admitting arm.
          ...groupTransferAuditFields(evidence) } }, client);
      await taskHistoryService.recordChange(taskId, task.title, 'accountOwnerPrincipalId', previous, targetId, actor.handle, actor.principalId, client);
      await feedEventService.emit(client, { name: 'task.acl_changed', objectType: 'task', objectId: taskId,
        projectId: task.project_id, actorPrincipalId: actor.principalId, actorHandle: actor.handle,
        ownerPrincipalId: previous, payload: {} });
      return { taskId, accountOwnerPrincipalId: targetId, updatedAt: updated.rows[0].owner_revision, changed: true };
    }
  }

  /**
   * PUT /tasks/:id/account-owner/steward - LENSES-c gate (ii) and DD-5 (c1-B,
   * card b5c83682; design delta C.6). The GATE IS THE DECIDER: `mayTransfer()`
   * and the Main arm are not consulted (services/GroupOwnerStewardTransfer).
   * The current owner is the EFFECTIVE one, COALESCE(explicit, the Project's);
   * a Task whose explicit owner was NULL is moved by writing the target as the
   * explicit owner (AZ-A12 9(c)). In order, in one transaction, every refusal
   * before the step-up is spent: the body (422); the row lock (404); the
   * standing (steps 1 to 3); for (ii) today's person-target check; archived
   * (409); the account-owner preconditions (412); then the step-up bound to
   * ('ownership.transfer', the Task id).
   *
   * EVERY refusal of the act, not only the standing's, is audited as a denied
   * task.account_owner.change row by the one writer, outside the transaction
   * (C.6, C.7): the malformed change before it opens, and every other refusal
   * after the ROLLBACK in the act's catch; `refusal` learns the facts the row
   * names as the act reads them.
   */
  async changeAsGroupOwner(
    taskId: string,
    input: { accountOwnerPrincipalId: string | null; expectedAccountOwnerPrincipalId: string | null; expectedUpdatedAt: string; reason: string },
    actor: TaskActor,
    caller: StewardTransferCaller,
    stepUpToken: string,
  ) {
    const audit = { principalId: actor.principalId, handle: actor.handle, authMethod: actor.authMethod ?? 'unknown', credentialId: actor.credentialId };
    const requested = input?.accountOwnerPrincipalId;
    const refusal: StewardTransferRefusalTarget = {
      objectType: 'task', objectId: String(taskId).toLowerCase(), currentOwnerId: null,
      targetOwnerId: typeof requested === 'string' ? requested.toLowerCase() : null,
      audit: { actor: audit, action: 'task.account_owner.change' },
    };
    if (!input || !(input.accountOwnerPrincipalId === null || UUID.test(input.accountOwnerPrincipalId ?? ''))
      || !(input.expectedAccountOwnerPrincipalId === null || UUID.test(input.expectedAccountOwnerPrincipalId ?? ''))
      || typeof input.expectedUpdatedAt !== 'string' || !input.expectedUpdatedAt
      || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) {
      const malformed = new ResourceContractError(422, 'INVALID_ACCOUNT_OWNER_CHANGE', 'Supply the target account owner, the expected account owner and updatedAt from the account-owner read, and a reason');
      await auditStewardTransferRefusal(refusal, malformed);
      throw malformed;
    }
    const targetId = input.accountOwnerPrincipalId === null ? null : input.accountOwnerPrincipalId.toLowerCase();
    const expected = input.expectedAccountOwnerPrincipalId?.toLowerCase() ?? null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT *, updated_at::text AS owner_revision FROM tasks WHERE id=$1 FOR UPDATE`, [taskId]);
      const task = result.rows[0];
      if (!task) throw new ResourceContractError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
      // Lock inherited ownership too, so a concurrent Project transfer cannot
      // change the authority basis between the standing and the commit.
      const project = task.project_id ? await client.query('SELECT owner_principal_id FROM projects WHERE id=$1 FOR SHARE', [task.project_id]) : { rows: [] };
      const previous: string | null = task.account_owner_principal_id ?? project.rows[0]?.owner_principal_id ?? null;
      refusal.objectId = String(task.id).toLowerCase();
      refusal.currentOwnerId = previous;
      const gate = {
        objectType: 'task' as const, objectId: String(task.id).toLowerCase(),
        currentOwnerId: previous, targetOwnerId: targetId,
        caller, writeScope: 'tasks:write' as const,
        audit: { actor: audit, action: 'task.account_owner.change' as const },
      };
      const standing = await stewardTransferStanding(client, gate);
      if (standing.shape === 'out') {
        // Today's person-target check (the administrator route's), on top of membership.
        const target = await client.query(`SELECT id FROM principals WHERE id=$1 AND kind='human' AND status='active'
          AND parent_principal_id IS NULL AND NOT legacy_identity FOR SHARE`, [targetId]);
        if (target.rows.length !== 1) {
          throw new GroupOwnershipTransferError(422, 'INVALID_ACCOUNT_OWNER', 'Target must be an active human account or an active Group');
        }
      }
      if (task.status === 'archived') throw new ResourceContractError(409, 'TASK_ARCHIVED', 'Restore the Task before changing its account owner');
      if (previous !== expected || task.owner_revision !== input.expectedUpdatedAt) {
        throw new ResourceContractError(412, 'ACCOUNT_OWNER_STATE_CHANGED', 'Task ownership or content changed; reload account-owner and retry');
      }
      const evidence = await consumeStewardTransferStepUp(client, gate, standing, stepUpToken);
      const updated = await client.query(`UPDATE tasks SET account_owner_principal_id=$2, updated_at=clock_timestamp()
        WHERE id=$1 RETURNING updated_at::text AS owner_revision`, [taskId, targetId]);
      await auditService.record({ action: 'task.account_owner.change', actor: audit,
        resourceType: 'task', resourceId: taskId,
        metadata: { oldAccountOwnerPrincipalId: previous, oldExplicitAccountOwnerPrincipalId: task.account_owner_principal_id ?? null,
          newAccountOwnerPrincipalId: targetId, reason: input.reason.trim(), independentVerification: false,
          // Clause 9(f), with the third standing (D-12), and which shape admitted it.
          ...groupTransferAuditFields(evidence), stewardShape: standing.shape, owningGroupId: standing.groupId } }, client);
      await taskHistoryService.recordChange(taskId, task.title, 'accountOwnerPrincipalId', previous, targetId, actor.handle, actor.principalId, client);
      await feedEventService.emit(client, { name: 'task.acl_changed', objectType: 'task', objectId: taskId,
        projectId: task.project_id, actorPrincipalId: actor.principalId, actorHandle: actor.handle,
        ownerPrincipalId: previous, payload: {} });
      await client.query('COMMIT');
      return { taskId, accountOwnerPrincipalId: targetId, updatedAt: updated.rows[0].owner_revision, changed: true };
    } catch (error) {
      await client.query('ROLLBACK');
      await auditStewardTransferRefusal(refusal, error);
      throw error;
    } finally { client.release(); }
  }
}
export const taskAccountOwnershipService = new TaskAccountOwnershipService();
