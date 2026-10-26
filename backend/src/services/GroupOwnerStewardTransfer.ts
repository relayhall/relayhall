/**
 * THE STEWARD TRANSFERS: gate (ii) and DD-5 (LENSES-c build c1-B, card
 * b5c83682; design delta LENSES-C steward tier C.6 and C.7, RATIFIED
 * 2026-10-11 by ruling E98; rulings E57 (ii), E58 and E59; AUTHZ amendment
 * AZ-A12 clause 9 as the delta's D-12 extends it).
 *
 * AZ-A12 clause 9's transfer act, admitted by a THIRD standing, `group-owner`,
 * beside root and an administrator, on two DEDICATED routes:
 *
 *   PUT /projects/:id/owner/steward          (ceiling projects:write)
 *   PUT /tasks/:id/account-owner/steward     (ceiling tasks:write)
 *
 * so the administrator routes and their deciders (`decide()`, `mayTransfer()`)
 * stay byte-identical. In this mode THE GATE IS THE DECIDER: neither the Main
 * arm nor the administrator arm is consulted.
 *
 * It admits EXACTLY two shapes, and refuses every other one by name
 * (STEWARD_TRANSFER_SHAPE_REFUSED, 422: person -> person, Group -> Group, a
 * clear), which stay with the administrator routes:
 *
 *   (ii) OUT   an object owned by an ACTIVE Group principal G moves to P, an
 *              active member of G; the caller holds a LIVE owner-role row on G.
 *   DD-5 IN    an object the CALLER owns (for a Task, the effective owner)
 *              moves into an active Group principal G in which the caller
 *              holds a LIVE owner-role row.
 *
 * The predicate, in order, inside the act's transaction after its row lock,
 * every refusal before the step-up is consumed and audited OUTSIDE the
 * transaction (the act rolls back), on clause 9(e)'s pattern:
 *
 *   1. a login session, through the one classification; else
 *      GROUP_OWNER_SESSION_ONLY (403), the transfer act's own code;
 *   2. a human Account acting as itself (kind human, active, parentless, not
 *      legacy, at most one chain link) whose session scopes AND current role
 *      both derive the route's write scope; else GROUP_OWNER_ROLE_REQUIRED (403);
 *   3. the shape and its standing: a missing live owner-role row (or a
 *      disabled source Group) is GROUP_OWNER_ROLE_REQUIRED (403); for DD-5 a
 *      caller who is not the current owner is NOT_THE_CURRENT_OWNER (403); for
 *      (ii) a target who is not an active member of G is
 *      TARGET_NOT_A_GROUP_MEMBER (422); an inactive Group target is
 *      INVALID_OWNER (422);
 *   4. (`consumeStewardTransferStepUp`) a step-up bound to
 *      ('ownership.transfer', the object id); else STEP_UP_REQUIRED (403) with
 *      the SU-14 challenge.
 *
 * The owner's steward and member rows, and for (ii) the target's member row,
 * are read FOR SHARE, so a concurrent member removal waits for the act to
 * commit (U-6). It never evaluates the `admin` verb (C.7).
 *
 * EVERY REFUSAL IS AUDITED (C.6, C.7: "each refusal is named and audited"),
 * not only the standing's: the act's own refusals (INVALID_OWNER,
 * INEFFECTIVE_OWNER, REVISION_REQUIRED, REVISION_MISMATCH,
 * ACCOUNT_OWNER_STATE_CHANGED, an archived object, a malformed change) and
 * the route's body and query refusals too. One writer does it,
 * `recordStewardTransferRefusal`, outside the act's rolled-back transaction:
 * the acts call `auditStewardTransferRefusal` once in their outer catch, and
 * the routes call the writer for what they refuse before the act. The
 * standing's helpers only name a refusal; they never audit it themselves, so
 * no refusal is recorded twice.
 */
import { auditService, type AuditActor } from './AuditService';
import { stepUpService, StepUpError } from './StepUpService';
import { authorizationService, type AuthorizationActor } from './AuthorizationService';
import { ResourceContractError } from './ProjectResourceService';
import { GroupOwnershipTransferError, OWNERSHIP_TRANSFER_STEP_UP_ACTION, type GroupTransferEvidence } from './GroupOwnershipTransfer';
import { GROUP_OWNER_SESSION_ONLY, isLoginSessionKind } from '../utils/administratorSession';
import { liveStewardRows } from '../utils/liveStewardCondition';
import { scopesForRole } from '../utils/identityScopes';
import { auditChainFor } from '../utils/auditChain';

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const GROUP_OWNER_ROLE_REQUIRED = 'GROUP_OWNER_ROLE_REQUIRED';
export const STEWARD_TRANSFER_SHAPE_REFUSED = 'STEWARD_TRANSFER_SHAPE_REFUSED';

/** The request facts the standing reads. Every field is server-derived. */
export interface StewardTransferCaller {
  authMethod?: string;
  principalId: string | null;
  /** The acting chain's length; an Account acting as itself has at most one link. */
  chainLength: number;
  /** The scopes the request's session derived. */
  scopes: readonly string[] | null;
}

export interface StewardTransferInput {
  objectType: 'project' | 'task';
  /** The object id as the row lock read it (canonical lowercase): the step-up target. */
  objectId: string;
  /** For a Task, the EFFECTIVE owner COALESCE(t.account_owner_principal_id, p.owner_principal_id). */
  currentOwnerId: string | null;
  targetOwnerId: string | null;
  caller: StewardTransferCaller;
  writeScope: 'projects:write' | 'tasks:write';
  /** The act's audit attribution. The standing never writes it; the act's outer catch does. */
  audit?: { actor: AuditActor; action: 'project.owner.change' | 'task.account_owner.change' };
}

/**
 * What a refused steward transfer's denied row names. The act fills it in as
 * it learns the facts (the object id as the row lock read it, the current and
 * the target owner), so a refusal before the row lock still names the object.
 */
export interface StewardTransferRefusalTarget {
  objectType: 'project' | 'task';
  objectId: string;
  currentOwnerId: string | null;
  targetOwnerId: string | null;
  audit: { actor: AuditActor; action: 'project.owner.change' | 'task.account_owner.change' };
}

/** The owner kinds a standing refusal learned, kept beside its error for the one writer. */
const refusalKinds = new WeakMap<object, { old: string | null; new: string | null }>();

/**
 * The code of a NAMED refusal of a steward transfer, or null for a fault (a
 * 5xx or an unexpected error is not a refusal and is not audited as one).
 */
export function stewardTransferRefusalCode(error: unknown): string | null {
  if ((error instanceof GroupOwnershipTransferError || error instanceof ResourceContractError) && error.status < 500) {
    return error.code;
  }
  return null;
}

/**
 * THE ONE WRITER of a steward transfer's denied row (C.6): outside any
 * transaction, best-effort like every refusal audit (a ledger outage never
 * turns a refusal into an admission), with the refusal code, the clause, the
 * group-owner standing and the owners the act had read.
 */
export async function recordStewardTransferRefusal(
  target: StewardTransferRefusalTarget,
  code: string,
  kinds: { old: string | null; new: string | null } = { old: null, new: null },
): Promise<void> {
  await auditService.record({
    action: target.audit.action, actor: target.audit.actor, outcome: 'denied',
    resourceType: target.objectType, resourceId: target.objectId,
    metadata: {
      refusal: code, clause: 'LENSES-c C.6', subject: 'decider', standing: 'group-owner',
      oldOwnerPrincipalId: target.currentOwnerId, newOwnerPrincipalId: target.targetOwnerId,
      oldOwnerKind: kinds.old, newOwnerKind: kinds.new,
    },
  }).catch(() => undefined);
}

/** The acts' outer catch: audit the error once if it is a named refusal. */
export async function auditStewardTransferRefusal(target: StewardTransferRefusalTarget, error: unknown): Promise<void> {
  const code = stewardTransferRefusalCode(error);
  if (code === null) return;
  const kinds = error !== null && typeof error === 'object' ? refusalKinds.get(error) : undefined;
  await recordStewardTransferRefusal(target, code, kinds);
}

/** What the standing established: the shape, the Group and the kinds the audit row records. */
export interface StewardTransferStanding {
  shape: 'out' | 'in';
  groupId: string;
  callerId: string;
  oldOwnerKind: string | null;
  newOwnerKind: string | null;
}

/** A standing refusal, NAMED here and audited once by the act's outer catch
 * (`auditStewardTransferRefusal`), with the owner kinds it learned. */
async function refuse(_input: StewardTransferInput, status: number, code: string, message: string,
  kinds: { old: string | null; new: string | null } = { old: null, new: null },
  challenge: ConstructorParameters<typeof GroupOwnershipTransferError>[3] = null, field?: string): Promise<never> {
  const refusal = new GroupOwnershipTransferError(status, code, message, challenge, field);
  refusalKinds.set(refusal, kinds);
  throw refusal;
}

/** Steps 1 to 3 of the predicate. It writes nothing and consumes nothing. */
export async function stewardTransferStanding(client: Queryable, input: StewardTransferInput): Promise<StewardTransferStanding> {
  // Step 1: a login session, through the one classification.
  if (!isLoginSessionKind(input.caller.authMethod)) {
    return refuse(input, 403, GROUP_OWNER_SESSION_ONLY,
      'A steward ownership transfer is a login-session act (LENSES-c C.6): sign in at the dashboard; bearer credentials, appointed Mains and MCP never perform it.');
  }
  // Step 2: a human Account acting as itself, whose session AND current role derive the write scope.
  const notOwner = (kinds?: { old: string | null; new: string | null }) => refuse(input, 403, GROUP_OWNER_ROLE_REQUIRED,
    'This transfer requires a signed-in person who holds a live owner role in the Group concerned', kinds);
  const callerId = input.caller.principalId;
  if (!callerId || input.caller.chainLength > 1) return notOwner();
  const self = await client.query(
    'SELECT id::text AS id, handle, kind, status, role, parent_principal_id, legacy_identity FROM principals WHERE id = $1 FOR SHARE',
    [callerId],
  );
  const person = self.rows[0];
  if (!person || person.kind !== 'human' || person.status !== 'active' || person.parent_principal_id || person.legacy_identity) {
    return notOwner();
  }
  const sessionActor: AuthorizationActor = {
    authenticated: true, principalId: callerId, handle: String(person.handle), role: person.role ?? null,
    scopes: [...(input.caller.scopes ?? [])],
  };
  const roleActor: AuthorizationActor = { ...sessionActor, scopes: scopesForRole(person.role) };
  if (!authorizationService.authorizeRoute(sessionActor, input.writeScope).allowed
    || !authorizationService.authorizeRoute(roleActor, input.writeScope).allowed) {
    return notOwner();
  }

  // Step 3: the shape and its standing.
  const ids = [input.currentOwnerId, input.targetOwnerId].filter((id): id is string => typeof id === 'string' && id.length > 0);
  const facts = new Map<string, { kind: string; status: string }>();
  if (ids.length > 0) {
    const found = await client.query('SELECT id::text AS id, kind, status FROM principals WHERE id = ANY($1::uuid[])', [ids]);
    for (const row of found.rows) facts.set(String(row.id).toLowerCase(), { kind: String(row.kind), status: String(row.status) });
  }
  const factOf = (id: string | null) => (id ? facts.get(id.toLowerCase()) ?? null : null);
  const current = factOf(input.currentOwnerId);
  const target = factOf(input.targetOwnerId);
  const kinds = { old: current?.kind ?? null, new: target?.kind ?? null };
  const liveOwner = async (groupId: string): Promise<boolean> => (await client.query(
    liveStewardRows({ group: '$1', account: '$2', roles: "ARRAY['owner']::text[]", lock: true }),
    [groupId, callerId],
  )).rows.length > 0;

  if (input.targetOwnerId !== null && current?.kind === 'group' && target?.kind !== 'group') {
    // (ii) OUT: G -> P. A disabled G suspends every ownership tier through it.
    const groupId = input.currentOwnerId!.toLowerCase();
    if (current.status !== 'active' || !(await liveOwner(groupId))) return notOwner(kinds);
    const member = await client.query(
      `SELECT 1 FROM group_members target_member
         JOIN principals target_account ON target_account.id = target_member.account_principal_id
          AND target_account.status = 'active'
        WHERE target_member.group_id = $1 AND target_member.account_principal_id = $2
        FOR SHARE OF target_member`,
      [groupId, input.targetOwnerId],
    );
    if (member.rows.length === 0) {
      return refuse(input, 422, 'TARGET_NOT_A_GROUP_MEMBER',
        'An object a Group owns moves out only to an active member of that Group', kinds, null, 'ownerPrincipalId');
    }
    return { shape: 'out', groupId, callerId, oldOwnerKind: kinds.old, newOwnerKind: kinds.new };
  }
  if (target?.kind === 'group' && current?.kind !== 'group') {
    // DD-5 IN: the caller's own object -> G.
    const groupId = input.targetOwnerId!.toLowerCase();
    if (!(await liveOwner(groupId))) return notOwner(kinds);
    if (!input.currentOwnerId || input.currentOwnerId.toLowerCase() !== callerId.toLowerCase()) {
      return refuse(input, 403, 'NOT_THE_CURRENT_OWNER',
        'Only the current owner moves an object into a Group (DD-5)', kinds);
    }
    if (target.status !== 'active') {
      return refuse(input, 422, 'INVALID_OWNER', 'The selected Group is not an active Group principal', kinds, null, 'ownerPrincipalId');
    }
    return { shape: 'in', groupId, callerId, oldOwnerKind: kinds.old, newOwnerKind: kinds.new };
  }
  return refuse(input, 422, STEWARD_TRANSFER_SHAPE_REFUSED,
    'The steward route moves a Group-owned object to one of its members, or your own object into a Group you own; '
    + 'every other move (person to person, Group to Group, a clear) is an administrator act on the owner route', kinds);
}

/**
 * Step 4: the single-use step-up bound to ('ownership.transfer', the object
 * id), consumed on the act's transaction client, AFTER every other refusal of
 * the act. Then the clause 9(f) audit fields, with deciderStanding group-owner.
 */
export async function consumeStewardTransferStepUp(
  client: Queryable, input: StewardTransferInput, standing: StewardTransferStanding, stepUpToken: string,
): Promise<GroupTransferEvidence> {
  let evidence: { tokenId: string; method: string };
  try {
    evidence = await stepUpService.consume(client, {
      token: stepUpToken,
      principalId: standing.callerId,
      action: OWNERSHIP_TRANSFER_STEP_UP_ACTION,
      targetId: input.objectId,
    });
  } catch (e) {
    if (e instanceof StepUpError) {
      return refuse(input, e.status, e.code, e.message, { old: standing.oldOwnerKind, new: standing.newOwnerKind }, e.challenge);
    }
    throw e;
  }
  const members = await client.query(
    `SELECT count(*)::int AS n FROM group_members gm
       JOIN principals mp ON mp.id = gm.account_principal_id AND mp.status = 'active'
      WHERE gm.group_id = $1`, [standing.groupId]);
  return {
    oldOwnerKind: standing.oldOwnerKind,
    newOwnerKind: standing.newOwnerKind,
    groupMemberCountAtTransfer: Number(members.rows[0]?.n ?? 0),
    stepUpTokenId: evidence.tokenId,
    stepUpMethod: evidence.method,
    deciderStanding: 'group-owner',
    chain: await auditChainFor(client, standing.callerId),
  };
}
