/**
 * Card 41e24358 (design ba22fd01 Part 4, ratified E298): the ONE usable-Verifier
 * predicate.
 *
 * A card's Verifier can actually judge it only when all four arms hold:
 *
 *   1. principal    - verifier_principal_id is set and names a row whose status
 *                     is `active` and whose kind is not `group` (AZ-A12 clause
 *                     3(c): a Group never acts).
 *   2. chain        - the delegation chain is alive (`DelegationService.
 *                     resolveChain`): every link active and, for a delegated
 *                     principal, at least one live credential. There is no
 *                     "paused" principal state (owner answer Q1 (a)): pausing a
 *                     Connector means disabling it or revoking its credentials,
 *                     and this arm then fails. `legacy_identity` rows are exempt
 *                     from chain liveness exactly as the evaluator exempts them.
 *   3. scope        - `tasks:write` survives the chain intersection, because
 *                     every verdict route sits behind that ceiling: for a
 *                     delegated principal at least ONE live credential's
 *                     effective scopes (credential ∩ own() ∩ each ancestor ∩ the
 *                     Account's role set, `DelegationService.effectiveScopes`)
 *                     include it - one credential at a time, never a union; for
 *                     an Account, its role-derived scope set. A legacy identity
 *                     passes with either a live credential carrying it or its
 *                     role-derived set. The object side needs no extra check:
 *                     the Verifier arm grants `verify` by identity.
 *   4. independence - the Verifier is not the Assignee (owner answer Q4 (a):
 *                     today's rule, nothing about "same chain").
 *
 * Arms 1-3 depend on the principal only; arm 4 on the card. The point check
 * (`verifierUsabilityOf`) and the list filter (`usableVerifierPrincipalIds`,
 * read by `TaskManagerDB.buildTaskWhere`) both evaluate arms 1-3 through
 * `principalVerifierUsability`, so the two can never disagree about a
 * principal; arm 4 is the one SQL comparison the filter adds, and the live
 * suite pins point/list parity.
 *
 * The predicate is evaluated live and never stored. It is reused by the
 * Review warning, the create warning, the default write, task_finish, the list
 * filter and the morning census (the filter over To-Do and Review).
 */
import { delegationService, DelegationEvaluatorError } from './DelegationService';
import { scopesForRole } from '../utils/identityScopes';
import { scopesSatisfy } from '../utils/scopeMap';

export type VerifierFailedArm = 'none' | 'principal' | 'chain' | 'scope' | 'independence';

/** The arms that depend on the principal alone (1-3). */
export type PrincipalVerifierArm = 'principal' | 'chain' | 'scope';

export interface VerifierUsability {
  usable: boolean;
  failedArm?: VerifierFailedArm;
  principalId: string | null;
}

interface Queryable {
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
}

/** The scope every verdict route requires (scopeMap: the tasks ceiling). */
export const VERIFIER_REQUIRED_SCOPE = 'tasks:write';

/**
 * Arms 1-3 for one principal. Never throws for a structural chain problem
 * (that is a dead chain, arm 2); a database failure propagates to the caller,
 * which decides whether it may block (it never may for a warning).
 */
export async function principalVerifierUsability(
  queryable: Queryable,
  principalId: string,
): Promise<{ usable: boolean; failedArm?: PrincipalVerifierArm }> {
  // Arm 1: an active, non-Group principal row.
  const found = await queryable.query(
    `SELECT id, kind, status, role, parent_principal_id, legacy_identity
       FROM principals WHERE id = $1`,
    [principalId],
  );
  const row = found.rows[0];
  if (!row || String(row.status) !== 'active' || row.kind === 'group') {
    return { usable: false, failedArm: 'principal' };
  }

  // Arm 2: the live chain.
  let chain;
  try {
    chain = await delegationService.resolveChain(principalId, queryable);
  } catch (error) {
    if (error instanceof DelegationEvaluatorError) return { usable: false, failedArm: 'chain' };
    throw error;
  }
  if (!chain.alive) return { usable: false, failedArm: 'chain' };

  // Arm 3: tasks:write survives, one credential at a time.
  const acting = chain.links[0];
  const account = chain.links[chain.links.length - 1];
  const accountScopes = scopesForRole(account.role);
  if (!acting.parentPrincipalId && !acting.legacyIdentity) {
    // An Account: its role-derived scope set.
    return scopesSatisfy(accountScopes, VERIFIER_REQUIRED_SCOPE)
      ? { usable: true }
      : { usable: false, failedArm: 'scope' };
  }
  const credentials = await queryable.query(
    `SELECT scopes FROM principal_credentials
      WHERE principal_id = $1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > clock_timestamp())
        AND (grace_until IS NULL OR grace_until > clock_timestamp())`,
    [principalId],
  );
  for (const credential of credentials.rows) {
    const scopes: string[] = Array.isArray(credential.scopes) ? credential.scopes : [];
    const effective = delegationService.effectiveScopes(chain, scopes, accountScopes);
    if (scopesSatisfy(effective, VERIFIER_REQUIRED_SCOPE)) return { usable: true };
  }
  if (acting.legacyIdentity && scopesSatisfy(scopesForRole(acting.role), VERIFIER_REQUIRED_SCOPE)) {
    return { usable: true };
  }
  return { usable: false, failedArm: 'scope' };
}

/** Arm 4: the Verifier is not the Assignee. */
export function verifierIsIndependent(verifierPrincipalId: string, ownerPrincipalId: string | null | undefined): boolean {
  return !ownerPrincipalId || String(ownerPrincipalId) !== String(verifierPrincipalId);
}

/** The point check over a card's two role fields. */
export async function verifierUsabilityOf(
  queryable: Queryable,
  card: { verifierPrincipalId: string | null | undefined; ownerPrincipalId: string | null | undefined },
): Promise<VerifierUsability> {
  const verifier = card.verifierPrincipalId ? String(card.verifierPrincipalId) : null;
  if (!verifier) return { usable: false, failedArm: 'none', principalId: null };
  const principal = await principalVerifierUsability(queryable, verifier);
  if (!principal.usable) return { usable: false, failedArm: principal.failedArm, principalId: verifier };
  if (!verifierIsIndependent(verifier, card.ownerPrincipalId)) {
    return { usable: false, failedArm: 'independence', principalId: verifier };
  }
  return { usable: true, principalId: verifier };
}

/** The point check for one stored card; null when the card does not exist. */
export async function verifierUsability(queryable: Queryable, taskId: string): Promise<VerifierUsability | null> {
  const found = await queryable.query(
    'SELECT verifier_principal_id, owner_principal_id FROM tasks WHERE id = $1',
    [taskId],
  );
  if (found.rows.length === 0) return null;
  return verifierUsabilityOf(queryable, {
    verifierPrincipalId: found.rows[0].verifier_principal_id,
    ownerPrincipalId: found.rows[0].owner_principal_id,
  });
}

/**
 * The list filter's input: of the principals currently named as a Verifier on
 * any card, those that pass arms 1-3. `buildTaskWhere` turns "without a usable
 * Verifier" into: no Verifier, OR a Verifier not in this set, OR a Verifier
 * equal to the Assignee (arm 4).
 */
export async function usableVerifierPrincipalIds(queryable: Queryable): Promise<string[]> {
  const named = await queryable.query(
    'SELECT DISTINCT verifier_principal_id AS id FROM tasks WHERE verifier_principal_id IS NOT NULL',
  );
  const usable: string[] = [];
  for (const row of named.rows) {
    const id = String(row.id);
    if ((await principalVerifierUsability(queryable, id)).usable) usable.push(id);
  }
  return usable;
}

/**
 * "Without a usable Verifier" as ONE SQL condition over the card row aliased
 * `task`, given the placeholder bound to `usableVerifierPrincipalIds`: no
 * Verifier, a Verifier outside the usable set (arms 1-3), or a Verifier equal
 * to the Assignee (arm 4), never a `none` Task. The list filter (`TaskManagerDB.buildTaskWhere`) and
 * the "Needs your action" Verify kind (card 5854f0d6) both read it, so the two
 * cannot disagree about which card has no one to judge it.
 */
export function verifierUnusableSql(task: string, usableParam: string): string {
  // Section 6.8 (E462 S4b, VM-N4): a `none` Task has no one to judge it by
  // choice, so it is never "without a usable Verifier".
  return `(NOT ${task}.verification_none AND (${task}.verifier_principal_id IS NULL
        OR NOT (${task}.verifier_principal_id = ANY(${usableParam}::uuid[]))
        OR ${task}.verifier_principal_id = ${task}.owner_principal_id))`;
}

/** The fixed reason sentence per failed arm. Names no principal: a name is board data. */
export const VERIFIER_ARM_REASONS: Readonly<Record<VerifierFailedArm, string>> = Object.freeze({
  none: 'no Verifier is set',
  principal: 'the Verifier principal is not active, or is a Group',
  chain: 'the Verifier principal is disabled or has no live credential on its chain',
  scope: 'the Verifier principal lacks tasks:write',
  independence: 'the Verifier is the Assignee',
});

export interface VerifierWarning {
  code: 'VERIFIER_NOT_USABLE';
  failedArm: VerifierFailedArm;
  verifierPrincipalId: string | null;
  message: string;
}

/** The Review warning (design Part 5): additive, never a refusal (E284). */
export function verifierNotUsableWarning(result: VerifierUsability): VerifierWarning {
  const arm = result.failedArm ?? 'none';
  return {
    code: 'VERIFIER_NOT_USABLE',
    failedArm: arm,
    verifierPrincipalId: result.principalId,
    message: `This card is in Review but its Verifier cannot judge it: ${VERIFIER_ARM_REASONS[arm]}.`,
  };
}

export interface DefaultVerifierWarning {
  code: 'DEFAULT_VERIFIER_UNUSABLE';
  source: 'inherited-phase' | 'inherited-project';
  principalId: string;
  failedArm: VerifierFailedArm | 'assignment';
  message: string;
}
