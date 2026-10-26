/**
 * THE GROUP OWNERSHIP TRANSFER ACT: clause 9(e)'s standing test.
 *
 * AUTHZ amendment AZ-A12 clause 9 (ratified 2026-10-10, ruling E72; rulings
 * E58 and E59; card 311229fd). Every transfer of an object's ownership INTO,
 * OUT OF or BETWEEN Groups - `PUT /projects/:id/owner`, `PUT
 * /tasks/:id/account-owner`, and the create-form owner selector of clause
 * 10(b) - is an authenticated LOGIN-SESSION act with a single-use step-up bound
 * to (`ownership.transfer`, object id), performed by root or by an
 * administrator. `PUT /skills/:id/owner` (card d67e6990, the Skill owner
 * column of build 4) runs the same test for a Skill. Transfers between persons never reach this module's checks:
 * the test answers `null` and the act runs exactly as before (clause 16).
 *
 * The test runs INSIDE the act's transaction, after the row lock and before
 * the act's own decider (`decide()` for a Project, `mayTransfer()` for a
 * Task). Its three steps, in order:
 *
 *   1. a login session (`isLoginSessionKind`), else GROUP_OWNER_SESSION_ONLY;
 *   2. root, or an administrator through `administratorSessionOf` under
 *      GROUP_OWNERSHIP_TRANSFER_ACT, else GROUP_OWNER_REQUIRES_ADMINISTRATOR;
 *   3. only then the step-up is consumed, else STEP_UP_REQUIRED with the SU-14
 *      challenge (`stepUp`) the step-up riders ship.
 *
 * Steps 1 and 2 refuse BEFORE the token is consumed, as `/approvals` does, so
 * a refused caller's token stays live. A refusal rolls the act's transaction
 * back, so each refusal is audited OUTSIDE it: `auditService.record` without
 * the transaction client, on the `/approvals` decider-refusal pattern. Any
 * later refusal of the act (its own decider, the revision, the target) also
 * rolls the consumption back with the rest of the transaction.
 *
 * Once the test admits the caller, the act's Main arm (`resourceAccountControl`,
 * `taskAccountControl`) is never a decider (9(e)): the caller tells the act so
 * through the evidence this test returns.
 *
 * ONE STEP-UP PER DECISION (change-request design section 5.3, ratified by
 * owner ruling E325 with section 12 Q6 (a); T2 S5, card 9ce0b0b0). When an
 * approved `project.owner` or `task.account_owner` change applies this act
 * inside its decide transaction, the decision has already consumed ONE token
 * bound to (`approval.decide`, approval id). The standing then carries that
 * token as `decisionEvidence`, and step 3 accepts it in place of consuming a
 * second, per-act token ONLY when `assertDecisionEvidence` reads it, on this
 * very client, as consumed by this decider for that approval, with the
 * approval row held pending by this transaction. Forged or foreign evidence
 * is STEP_UP_REQUIRED, exactly as a missing token is; the direct doors never
 * supply it, so their binding is unchanged.
 */
import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { auditService, type AuditActor } from './AuditService';
import { stepUpService, StepUpError, type StepUpChallenge } from './StepUpService';
import { assertDecisionEvidence, DecisionEvidenceError, type DecisionEvidence } from '../utils/decisionEvidence';
import {
  GROUP_OWNERSHIP_TRANSFER_ACT, GROUP_OWNER_SESSION_ONLY, administratorSessionOf, isLoginSessionKind,
} from '../utils/administratorSession';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { auditChainFor, type AuditChainLink } from '../utils/auditChain';

/** The step-up action every Group ownership transfer binds to (§7.6), with the object id. */
export const OWNERSHIP_TRANSFER_STEP_UP_ACTION = 'ownership.transfer';

/** The request facts the standing test reads. Every field is server-derived except the token. */
export interface GroupTransferStanding {
  authMethod?: string;
  handle?: string;
  principalId: string | null;
  principalRole?: string | null;
  sessionRole?: string | null;
  scopes?: readonly string[] | null;
  /** The body's `stepUpToken`; '' when absent. */
  stepUpToken: string;
  /**
   * Section 5.3 (T2 S5): the consumed step-up of the change-request decision
   * that applies this act, read in place of `stepUpToken`. Set only by the
   * decide transaction; never derived from a request body.
   */
  decisionEvidence?: DecisionEvidence | null;
}

export function groupTransferStandingOf(req: AuthRequest, stepUpToken: unknown): GroupTransferStanding {
  return {
    authMethod: req.authMethod,
    handle: req.userId,
    principalId: req.principal?.id ?? null,
    principalRole: req.principal?.role ?? null,
    sessionRole: req.sessionRole ?? null,
    scopes: req.scopes ?? null,
    stepUpToken: typeof stepUpToken === 'string' ? stepUpToken : '',
  };
}

/**
 * A refusal of the transfer act; STEP_UP_REQUIRED carries the SU-14 challenge.
 * Its own class (not a ResourceContractError subclass), so a suite that mocks
 * the resource module still loads this one; both routes send it first.
 */
export class GroupOwnershipTransferError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly challenge: StepUpChallenge | null = null,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'GroupOwnershipTransferError';
  }
}

/** The `stepUp` member a route spreads into its refusal body, or nothing. */
export function groupTransferChallengeBody(e: unknown): { stepUp?: StepUpChallenge } {
  return e instanceof GroupOwnershipTransferError && e.challenge ? { stepUp: e.challenge } : {};
}

/**
 * Send a transfer-act refusal in the board's error envelope, with the SU-14
 * `stepUp` challenge on STEP_UP_REQUIRED (card 7a99d63e). Both ownership PUTs
 * and the create route use it, so the three answer one shape.
 */
export function sendGroupTransferRefusal(res: Response, e: unknown): boolean {
  if (!(e instanceof GroupOwnershipTransferError)) return false;
  res.status(e.status).json({
    success: false, error: e.message, code: e.code, message: e.message,
    ...(e.field ? { details: { field: e.field } } : {}),
    ...groupTransferChallengeBody(e),
  });
  return true;
}

/** Clause 9(f): what the transfer's audit row gains. */
export interface GroupTransferEvidence {
  oldOwnerKind: string | null;
  newOwnerKind: string | null;
  groupMemberCountAtTransfer: number;
  stepUpTokenId: string;
  stepUpMethod: string;
  /** `group-owner` is the third standing LENSES-c adds on the steward routes
   * only (c1-B, card b5c83682; design delta D-12, services/GroupOwnerStewardTransfer). */
  deciderStanding: 'root' | 'administrator' | 'group-owner';
  chain: AuditChainLink[];
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export type GroupTransferDecider =
  | { ok: true; standing: 'root' | 'administrator' }
  | { ok: false; status: number; code: string; message: string };

/**
 * Steps 1 and 2 of the standing test, and nothing else: ONE decision, read by
 * the act and by the owner selector (`GET /projects/:id/owner-candidates`
 * lists Groups only where this admits the caller, clause 12). It writes
 * nothing and consumes nothing.
 */
export function groupTransferDecider(standing: GroupTransferStanding): GroupTransferDecider {
  // Step 1: a login session.
  if (!isLoginSessionKind(standing.authMethod)) {
    return {
      ok: false, status: 403, code: GROUP_OWNER_SESSION_ONLY,
      message: `${GROUP_OWNERSHIP_TRANSFER_ACT.description} is a login-session act (AZ-A12 clause 9(e)): sign in at the dashboard; bearer credentials, appointed Mains and MCP never perform it.`,
    };
  }
  // Step 2: root, or an administrator through the existing predicate.
  if (Array.isArray(standing.scopes) && standing.scopes.includes('root')) return { ok: true, standing: 'root' };
  const administrator = administratorSessionOf({
    authMethod: standing.authMethod,
    handle: standing.handle,
    principalRole: standing.principalRole ?? null,
    sessionRole: standing.sessionRole ?? null,
  }, resolveActorRole, GROUP_OWNERSHIP_TRANSFER_ACT);
  if (!administrator.ok) return administrator;
  return { ok: true, standing: 'administrator' };
}

export interface GroupStandingInput {
  objectType: 'project' | 'task' | 'skill';
  /** The object id as the row lock read it (canonical lowercase): the step-up target. */
  objectId: string;
  /** For a Task, the effective owner COALESCE(t.account_owner_principal_id, p.owner_principal_id). */
  currentOwnerId: string | null;
  targetOwnerId: string | null;
  standing: GroupTransferStanding;
  audit: AuditActor;
  auditAction: 'project.owner.change' | 'task.account_owner.change' | 'skill.owner.change';
}

/**
 * Clause 9(e): `null` when neither the current owner nor the target is a
 * Group principal (the act is unchanged); else the admitting evidence, or a
 * thrown GroupOwnershipTransferError after a durable audit outside the
 * transaction.
 */
export async function groupOwnershipStandingTest(client: Queryable, input: GroupStandingInput): Promise<GroupTransferEvidence | null> {
  const ids = [input.currentOwnerId, input.targetOwnerId].filter((id): id is string => typeof id === 'string' && id.length > 0);
  const kinds = new Map<string, string>();
  if (ids.length > 0) {
    const found = await client.query('SELECT id::text AS id, kind FROM principals WHERE id = ANY($1::uuid[])', [ids]);
    for (const row of found.rows) kinds.set(String(row.id).toLowerCase(), String(row.kind));
  }
  const kindOf = (id: string | null): string | null => (id ? kinds.get(id.toLowerCase()) ?? 'unknown' : null);
  const oldOwnerKind = kindOf(input.currentOwnerId);
  const newOwnerKind = kindOf(input.targetOwnerId);
  if (oldOwnerKind !== 'group' && newOwnerKind !== 'group') return null;

  const refuse = async (status: number, code: string, message: string, challenge: StepUpChallenge | null = null): Promise<never> => {
    // Outside the act's transaction (no client): the refusal rolls it back.
    await auditService.record({
      action: input.auditAction, actor: input.audit, outcome: 'denied',
      resourceType: input.objectType, resourceId: input.objectId,
      metadata: {
        refusal: code, clause: 'AZ-A12 clause 9(e)', subject: 'decider',
        oldOwnerPrincipalId: input.currentOwnerId, newOwnerPrincipalId: input.targetOwnerId,
        oldOwnerKind, newOwnerKind,
      },
    }).catch(() => undefined);
    throw new GroupOwnershipTransferError(status, code, message, challenge);
  };

  // Steps 1 and 2: a login session; root, or an administrator.
  const decider = groupTransferDecider(input.standing);
  if (!decider.ok) return refuse(decider.status, decider.code, decider.message);
  const deciderStanding = decider.standing;
  // Step 3: only now the single-use step-up bound to (ownership.transfer, object id).
  const principalId = input.standing.principalId;
  if (!principalId) {
    return refuse(403, 'STEP_UP_REQUIRED', 'This act requires a step-up token minted by the acting principal (§7.6)');
  }
  let evidence: { tokenId: string; method: string };
  const decision = input.standing.decisionEvidence;
  if (decision) {
    // Section 5.3: the decision's own consumed step-up, checked on this client,
    // for this decider; anything else answers as a missing token.
    try {
      if (String(decision.deciderPrincipalId).toLowerCase() !== String(principalId).toLowerCase()) {
        throw new DecisionEvidenceError('the evidence names another decider');
      }
      await assertDecisionEvidence(client, decision);
    } catch (e) {
      if (e instanceof DecisionEvidenceError) return refuse(e.status, e.code, e.message);
      throw e;
    }
    evidence = { tokenId: decision.tokenId, method: decision.method };
  } else {
    try {
      evidence = await stepUpService.consume(client, {
        token: input.standing.stepUpToken,
        principalId,
        action: OWNERSHIP_TRANSFER_STEP_UP_ACTION,
        targetId: input.objectId,
      });
    } catch (e) {
      if (e instanceof StepUpError) return refuse(e.status, e.code, e.message, e.challenge);
      throw e;
    }
  }
  const countedGroup = newOwnerKind === 'group' ? input.targetOwnerId! : input.currentOwnerId!;
  const members = await client.query(
    `SELECT count(*)::int AS n FROM group_members gm
       JOIN principals mp ON mp.id = gm.account_principal_id AND mp.status = 'active'
      WHERE gm.group_id = $1`, [countedGroup]);
  return {
    oldOwnerKind,
    newOwnerKind,
    groupMemberCountAtTransfer: Number(members.rows[0]?.n ?? 0),
    stepUpTokenId: evidence.tokenId,
    stepUpMethod: evidence.method,
    deciderStanding,
    chain: await auditChainFor(client, principalId),
  };
}

/** Clause 9(f): the audit metadata the evidence adds (nothing for a person transfer). */
export function groupTransferAuditFields(evidence: GroupTransferEvidence | null): Record<string, unknown> {
  if (!evidence) return {};
  return {
    oldOwnerKind: evidence.oldOwnerKind,
    newOwnerKind: evidence.newOwnerKind,
    groupMemberCountAtTransfer: evidence.groupMemberCountAtTransfer,
    stepUpTokenId: evidence.stepUpTokenId,
    stepUpMethod: evidence.stepUpMethod,
    deciderStanding: evidence.deciderStanding,
    chain: evidence.chain,
  };
}
