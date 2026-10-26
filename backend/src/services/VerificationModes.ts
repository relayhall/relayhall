/**
 * Verification modes (universal harness connector design, section 6.8; owner
 * ruling E462, choice C10 = B; slice S4b).
 *
 * Each Task shows a verification mode: `human | service | none`.
 *
 *   human    DERIVED: the Verifier is a person (a human Account).
 *   service  DERIVED: the Verifier is a `service` principal or an appointed Agent.
 *   none     STORED (`tasks.verification_none`, migration 170): no verification.
 *            The Task has no Verifier and its finish completes it directly.
 *
 * A Task with no Verifier and no `none` is `unassigned`, which is what every
 * Task without a Verifier was before.
 *
 * ── The chain guard G(Task) (section 6.8, N6; check VM-B3, R2-B1, R2-N4) ──
 *
 * The guarded set is built from:
 *   - the execution connector's principal (`services.principal_id` for
 *     `execution_service_id`);
 *   - every principal that has ever claimed the Task (the `task.claimed`
 *     entry's `metadata.assigneePrincipalId`, never its author) or authored a
 *     `handover.finish` on it (`author_principal_id`), and the current claimant;
 *   - every Agent ever bound to the Task as `implementer`, revoked ones included;
 *   - the ancestors (stopping below the human Account at the root of each
 *     chain) and descendants of each of these.
 * A human Account is never in G: it can already complete its own Tasks through
 * the Account-control path, and the guard exists to stop a connector or its
 * Agents judging their own work. Siblings under one Account are not in each
 * other's chain.
 *
 * ONE SQL source (`guardedPrincipalsSql`) is read by the authorization
 * predicate's `verify` arms (the exact-Verifier arm when the Verifier is not a
 * person, and the `verifier-agent` arm), so the completion check, the
 * reject/run gate, native review and the wake's `verify` evaluation all ask the
 * same question.
 *
 * ── The `verifier-agent` arm (section 6.8, check VM-B2) ──
 *
 * A deliberate, bounded exception to AZ-26 ("a Task role never inherits down a
 * chain"), ratified through C10 = B. It admits `read` and `verify` only, for an
 * actor that is a non-legacy, active Agent bound to THIS Task as `verifier`,
 * whose parent is the Task's Verifier, minted under a Warrant that is active,
 * unexpired and held by that parent, when the Verifier is an active `service`
 * principal, and neither the Verifier nor the Agent is in G(Task). It is not a
 * grant and it is not ANDed with own() rules: no grant verb carries `verify`.
 * An Approval-minted Agent has no Warrant, so the arm refuses it.
 */
import type { PoolClient } from 'pg';
import { RequestFaultError } from '../utils/httpErrors';
import { auditService, type AuditActor } from './AuditService';
import { authorizationRepository } from './AuthorizationRepository';
import { taskAccountControl } from './AccountControlService';
import { delegationService } from './DelegationService';
import type { TaskActor } from './TaskHistoryService';
import { exactVerifierGuardedSql, guardedPrincipalsSql, verifierAgentEligibleSql } from '../utils/verificationGuardSql';

export { guardedPrincipalsSql, exactVerifierGuardedSql, verifierAgentEligibleSql } from '../utils/verificationGuardSql';

type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export type VerificationMode = 'human' | 'service' | 'none' | 'unassigned';
export type VerificationNoneBasis = 'account-control' | 'role-authority';

/** The stream entry type for a set or clear of `none` (the Timeline's System view). */
export const VERIFICATION_MODE_ENTRY = 'task.verification_mode';
/** The reason every `none` completion records in the stream, the audit log and the Timeline. */
export const VERIFICATION_NONE_REASON = 'verification: none';

/** The derived mode for a Task row: `none` is stored, `human`/`service` come from the Verifier's kind. */
export function verificationModeOf(row: { verificationNone?: boolean | null; verifierKind?: string | null; verifierPrincipalId?: string | null }): VerificationMode {
  if (row.verificationNone === true) return 'none';
  if (!row.verifierPrincipalId) return 'unassigned';
  return row.verifierKind === 'human' ? 'human' : 'service';
}

/** G(Task) as a set, with optional extra seeds (their chains are added the same way). */
export async function guardedPrincipalIds(q: Queryable, taskId: string, extraSeeds: string[] = []): Promise<Set<string>> {
  const result = await q.query(
    `SELECT id::text AS id FROM ${guardedPrincipalsSql('$1::uuid', '$2::uuid[]')} g`, [taskId, extraSeeds]);
  return new Set(result.rows.map((row) => String(row.id)));
}

/** Is this principal a `verifier-agent` of this Task right now (the arm's own SQL)? */
export async function isVerifierAgent(q: Queryable, taskId: string, principalId: string | null | undefined): Promise<boolean> {
  if (!principalId) return false;
  const result = await q.query(`SELECT ${verifierAgentEligibleSql('$1::uuid', '$2::uuid')} AS eligible`, [taskId, principalId]);
  return result.rows[0]?.eligible === true;
}

/**
 * Who may judge as this Task's Verifier at an exact-Verifier site (the
 * completion check, the reject/run gate, native review): the exact Verifier
 * when the chain guard passes (a person always passes), or a `verifier-agent`
 * of it (its eligibility includes the guard). The guard lives HERE, at the
 * identity, because an Account-owned Task's `verify` action can also be
 * reached through the delegation-chain intersection; the predicate's own
 * `verify` arms carry the same guard.
 */
export async function verifierStanding(q: Queryable, task: { id: string; verifier_principal_id?: string | null },
  principalId: string | null | undefined): Promise<'exact' | 'agent' | null> {
  if (!principalId) return null;
  const result = await q.query(
    `SELECT (t.verifier_principal_id = $2::uuid AND NOT ${exactVerifierGuardedSql('t.id')}) AS exact,
            ${verifierAgentEligibleSql('t.id', '$2::uuid')} AS agent
       FROM tasks t WHERE t.id = $1::uuid`, [task.id, principalId]);
  const answer = result.rows[0];
  if (answer?.exact === true) return 'exact';
  return answer?.agent === true ? 'agent' : null;
}

export class VerificationModeError extends RequestFaultError {
  constructor(status: number, code: string, message: string) { super(status, code, message); }
}

function auditActorOf(actor: TaskActor): AuditActor {
  return { principalId: actor.principalId, handle: actor.handle, authMethod: actor.authMethod ?? 'unknown', credentialId: actor.credentialId ?? null };
}

/** A displaced Verifier (an inherited default at creation, or the Verifier cleared by the set). */
export interface DisplacedVerifier { principalId: string; source: string | null }

/**
 * May this actor set `none` on this Task, and under which basis? Called inside
 * the writing transaction, after the Task row is locked.
 *   - never an Agent;
 *   - never a principal in G(Task) (the guard would refuse it as this Task's
 *     Verifier), on ANY basis: the check runs before the Account-control
 *     return, so a Main connector that executes or implements the Task cannot
 *     waive its verification either. A human Account is never in G, so it
 *     keeps the Account-control path;
 *   - then the Account-control path for the Task (basis `account-control`),
 *     or an actor the roles route admits to assign or clear the Verifier: the
 *     shared predicate's `shepherd` action, which is the Task's Shepherd or an
 *     administrator-class actor (basis `role-authority`).
 */
export async function verificationNoneSetterBasis(client: PoolClient, taskId: string, actor: TaskActor): Promise<VerificationNoneBasis> {
  if (!actor.principalId || !actor.authorization?.authenticated || actor.authorization.principalId !== actor.principalId) {
    throw new VerificationModeError(403, 'VERIFICATION_NONE_FORBIDDEN', 'Setting verification none requires an authenticated identity');
  }
  const chain = await delegationService.resolveChain(actor.principalId, client);
  if (!chain.alive || chain.links[0]?.kind === 'agent') {
    throw new VerificationModeError(403, 'VERIFICATION_NONE_AGENT', 'An Agent never sets verification none');
  }
  if ((await guardedPrincipalIds(client, taskId)).has(actor.principalId)) {
    throw new VerificationModeError(403, 'VERIFICATION_NONE_CHAIN_GUARDED',
      'This identity implements or executes the Task (or shares its chain) and cannot waive its verification');
  }
  if (await taskAccountControl(client, taskId, actor)) return 'account-control';
  const shepherd = await authorizationRepository.authorizedIds(actor.authorization, 'task', [taskId], 'shepherd', client);
  if (!shepherd.has(taskId)) {
    throw new VerificationModeError(403, 'VERIFICATION_NONE_FORBIDDEN',
      'Only the Task\'s Shepherd, an administrator or the Account may set verification none');
  }
  return 'role-authority';
}

/**
 * The "has never started" test (section 6.8, R2-N1): `todo`, `started_at` NULL,
 * no `task.claimed` or `handover.finish` entry, no execution lease row, and
 * `none` never cleared before. At creation the Task is in the status the
 * create landed it in, To Do or Ideas (an explicit `ideas`, or the inbox-phase
 * default with no status); after creation only To Do admits it.
 */
async function assertNeverStarted(client: PoolClient, taskId: string, atCreation: boolean): Promise<{ verifierPrincipalId: string | null; verifierSource: string | null; verificationNone: boolean }> {
  const row = (await client.query(
    `SELECT t.status, t.started_at, t.verification_none, t.verification_none_cleared_at,
            t.verifier_principal_id::text AS verifier_principal_id, t.verifier_source,
            EXISTS (SELECT 1 FROM task_stream_entries e WHERE e.task_id = t.id
                     AND e.event_type IN ('task.claimed', 'handover.finish')) AS has_work_entry,
            EXISTS (SELECT 1 FROM task_execution_leases l WHERE l.task_id = t.id) AS has_lease
       FROM tasks t WHERE t.id = $1 FOR UPDATE OF t`, [taskId])).rows[0];
  if (!row) throw new VerificationModeError(404, 'TASK_NOT_FOUND', 'Task not found');
  if (row.verification_none_cleared_at) {
    throw new VerificationModeError(409, 'VERIFICATION_NONE_CLEARED', 'Verification none was cleared on this Task and cannot be set again');
  }
  const landing = atCreation ? ['todo', 'ideas'] : ['todo'];
  if (!landing.includes(String(row.status)) || row.started_at || row.has_work_entry || row.has_lease) {
    throw new VerificationModeError(409, 'VERIFICATION_NONE_TASK_STARTED',
      'Verification none can be set only at creation or while the Task is To Do and has never started');
  }
  return { verifierPrincipalId: row.verifier_principal_id ?? null, verifierSource: row.verifier_source ?? null, verificationNone: row.verification_none === true };
}

/**
 * Store `none` on a Task (the caller has decided the basis with
 * `verificationNoneSetterBasis`, or is a Blueprint instantiation whose plan
 * authority admitted it). The Task must have no Verifier by now: the caller
 * clears a current Verifier first and passes it as `displaced`. Writes the
 * column, one audit row and one `system` stream entry (the Timeline).
 */
export async function recordVerificationNone(client: PoolClient, taskId: string, actor: TaskActor,
  basis: VerificationNoneBasis, displaced: DisplacedVerifier | null, atCreation: boolean): Promise<void> {
  const state = await assertNeverStarted(client, taskId, atCreation);
  if (state.verificationNone) return;
  if (state.verifierPrincipalId) {
    throw new VerificationModeError(409, 'VERIFICATION_NONE_WITH_VERIFIER', 'A Task with a Verifier cannot also be set to verification none');
  }
  await client.query(
    `UPDATE tasks SET verification_none = TRUE, verification_none_set_by = $2, verification_none_basis = $3,
            verification_none_set_at = clock_timestamp(), updated_at = NOW()
      WHERE id = $1`, [taskId, actor.principalId, basis]);
  const metadata = {
    mode: 'none', change: 'set', setByPrincipalId: actor.principalId, basis, atCreation,
    displacedVerifierPrincipalId: displaced?.principalId ?? null, displacedVerifierSource: displaced?.source ?? null,
  };
  await auditService.record({ action: 'task.verification_none.set', actor: auditActorOf(actor),
    resourceType: 'task', resourceId: taskId, metadata }, client);
  await client.query(
    `INSERT INTO task_stream_entries (task_id, provenance, event_type, content, metadata, author_principal_id)
     VALUES ($1, 'system', $2, $3, $4, $5)`,
    [taskId, VERIFICATION_MODE_ENTRY,
      displaced ? 'Verification set to none (a default Verifier was displaced)' : 'Verification set to none',
      metadata, actor.principalId]);
}

/**
 * Clear `none` in the SAME statement that writes a Verifier (or, with a null
 * Verifier, the explicit clear): returns whether `none` was set. Once cleared,
 * `none` can never be set again (migration 170's CHECK).
 */
export async function recordVerificationNoneCleared(client: PoolClient, taskId: string, actor: AuditActor,
  verifierPrincipalId: string | null): Promise<void> {
  const metadata = { mode: verifierPrincipalId ? 'verifier' : 'unassigned', change: 'cleared',
    clearedByPrincipalId: actor.principalId ?? null, verifierPrincipalId };
  await auditService.record({ action: 'task.verification_none.clear', actor, resourceType: 'task', resourceId: taskId, metadata }, client);
  await client.query(
    `INSERT INTO task_stream_entries (task_id, provenance, event_type, content, metadata, author_principal_id)
     VALUES ($1, 'system', $2, $3, $4, $5)`,
    [taskId, VERIFICATION_MODE_ENTRY,
      verifierPrincipalId ? 'Verification none cleared: a Verifier was assigned' : 'Verification none cleared',
      metadata, actor.principalId ?? null]);
}

/**
 * Finish-time re-check (section 6.8): the stored setter against the finishing
 * actor, the claimer and the execution connector. Refuses when they share a
 * chain, unless the setter acted on the Account-control path.
 */
export async function assertVerificationNoneFinishable(client: PoolClient, task: {
  id: string; verification_none_set_by?: string | null; verification_none_basis?: string | null;
}, finishingPrincipalId: string | null | undefined): Promise<void> {
  if (task.verification_none_basis === 'account-control') return;
  const setter = task.verification_none_set_by ? String(task.verification_none_set_by) : null;
  const guarded = await guardedPrincipalIds(client, task.id, finishingPrincipalId ? [finishingPrincipalId] : []);
  if (!setter || guarded.has(setter)) {
    throw new VerificationModeError(409, 'VERIFICATION_NONE_SELF_SET',
      'Verification none on this Task was set from the implementing chain; a person must add a Verifier or complete it');
  }
}
