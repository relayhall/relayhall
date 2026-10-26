/**
 * Card 41e24358 (design ba22fd01 Part 2, ratified E298): the ONE writer of a
 * Project's or a Phase's default Verifier.
 *
 *   PUT /projects/:id/default-verifier   If-Match: <project revision>
 *   PUT /phases/:id/default-verifier     If-Match: <phase revision>
 *   body { "principalId": "<uuid>" | null }
 *
 * Never the generic PATCH, which the MCP plane reaches through
 * relayhall_project_update / relayhall_phase_update: both PATCH routes keep
 * refusing the field as unknown, and no MCP tool names these routes.
 *
 * THE GATE is this handler's own, on the AZ-A13 credential-edit precedent
 * (check F2: the admin-action class would refuse the person owner at the role
 * ceiling, so the route ceiling is `authenticated` and the point stage asks
 * only `write` on the object):
 *   - a login session: a bearer is refused SESSION_ONLY, audited, before any
 *     lookup;
 *   - root, an administrator session, or the PERSON owner of the Project (a
 *     Phase resolves to its Project's owner, check F7);
 *   - on a Group-owned Project (AZ-A12 clause 6: no admin tier through Group
 *     ownership) only root or an administrator session in v1 (owner answer
 *     Q3 (a)).
 *   On the Phase route a caller the point stage refused but who can read the
 *   Phase (on it, or through its Project) is handed here marked refused, so
 *   both routes answer a readable non-owner 403 DEFAULT_VERIFIER_REQUIRES_OWNER
 *   (card 5216d735, owner ruling E311); an unreadable Phase stays concealed.
 *
 * THE VALUE is a person or a Connector: a Group (AZ-A12 clause 3(c)) and a
 * non-legacy Agent (task-bounded) are refused by name, and the principal must
 * pass arms 1-3 of the usable predicate at write time (422
 * DEFAULT_VERIFIER_UNUSABLE naming the arm). Migration 155's trigger is the
 * backstop under this.
 *
 * Every write is audited `<type>.default_verifier.set` with before/after, the
 * actor and the session; every refusal is audited `outcome: 'denied'` with its
 * code. A change of a default never touches an existing card.
 *
 * THE LIFTED SEAM (change-request design section 3, R8-G5; T2 S5, card
 * 9ce0b0b0): everything from the row lock to the feed event is
 * `setDefaultVerifierWithin(client, target, id, value, standing)`, which this
 * handler and an approved `project.default_verifier` / `phase.default_verifier`
 * change both call. The standing is the ACTING session's facts (here the
 * request's; for a change, the DECIDER's), read by the same `standingOf`, so
 * the seam admits exactly whom this route admits. A change carries the
 * decision's one step-up (section 5.3) and its ledger on the act's audit row.
 */
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import type { AuthRequest } from '../middleware/auth';
import { auditService, type AuditActor } from '../services/AuditService';
import { feedEventService } from '../services/FeedEventService';
import { principalVerifierUsability, VERIFIER_ARM_REASONS } from '../services/VerifierUsability';
import { auditActorFromRequest } from '../utils/auditActor';
import { auditChainFor } from '../utils/auditChain';
import { administratorSessionOf, isLoginSessionKind, type AdministratorAct } from '../utils/administratorSession';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { sendApiError } from '../utils/apiErrors';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { RequestFaultError } from '../utils/httpErrors';
import { scopesSatisfy } from '../utils/scopeMap';
import { DEFAULT_VERIFIER_POINT_REFUSED } from '../middleware/sharedAuthorization';

export type DefaultVerifierTarget = 'project' | 'phase';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_VERIFIER_REQUIRES_SESSION = 'SESSION_ONLY';
export const DEFAULT_VERIFIER_REQUIRES_OWNER = 'DEFAULT_VERIFIER_REQUIRES_OWNER';

const DEFAULT_VERIFIER_ACT: AdministratorAct = {
  description: 'Setting a default Verifier',
  requiresSession: DEFAULT_VERIFIER_REQUIRES_SESSION,
  requiresAdministrator: DEFAULT_VERIFIER_REQUIRES_OWNER,
};

/** A refusal this handler authors itself: fixed text, with fixed-vocabulary details. */
export class DefaultVerifierRefusal extends RequestFaultError {
  constructor(status: number, code: string, message: string,
    readonly details: Record<string, unknown> = {}) {
    super(status, code, message);
  }
}

function auditAction(target: DefaultVerifierTarget): string {
  return `${target}.default_verifier.set`;
}

function ifMatch(req: Request): string {
  const raw = (req.headers['if-match'] as string | undefined) ?? '';
  return raw.replace(/^"+|"+$/g, '').trim();
}

async function auditDenied(req: AuthRequest, target: DefaultVerifierTarget, id: string, code: string,
  detail: Record<string, unknown> = {}, client?: PoolClient): Promise<void> {
  try {
    await auditService.record({
      action: auditAction(target), actor: auditActorFromRequest(req), outcome: 'denied',
      resourceType: target, resourceId: UUID.test(id) ? id.toLowerCase() : null,
      metadata: {
        refusal: code, authMethod: req.authMethod ?? 'unknown', sessionId: req.sessionId ?? null,
        ...detail,
        chain: req.principal?.id ? await auditChainFor(client ?? pool, req.principal.id) : [],
      },
    }, client ?? pool);
  } catch {
    // The refusal still answers.
  }
}

/** The acting session's facts the gate reads: the request's, or a change decider's. Every field is server-derived. */
export interface DefaultVerifierStandingFacts {
  principalId: string | null;
  handle?: string;
  authMethod?: string;
  principalRole?: string | null;
  sessionRole?: string | null;
  scopes?: readonly string[] | null;
  sessionId?: string | null;
}

/** The facts of the request in front of the route. */
export function defaultVerifierFactsOf(req: AuthRequest): DefaultVerifierStandingFacts {
  return {
    principalId: req.principal?.id ?? null, handle: req.userId, authMethod: req.authMethod,
    principalRole: req.principal?.role ?? null, sessionRole: req.sessionRole ?? null, scopes: req.scopes ?? null,
    sessionId: req.sessionId ?? null,
  };
}

/** The actor's standing for this act, or null. */
function standingOf(facts: DefaultVerifierStandingFacts, owner: { id: string | null; kind: string | null }): 'root' | 'administrator' | 'owner' | null {
  if (facts.scopes?.includes('root')) return 'root';
  const administrator = administratorSessionOf({
    authMethod: facts.authMethod,
    handle: facts.handle,
    principalRole: facts.principalRole ?? null,
    sessionRole: facts.sessionRole ?? null,
  }, resolveActorRole, DEFAULT_VERIFIER_ACT);
  if (administrator.ok) return 'administrator';
  // Q3 (a): a Group-owned Project admits no owner arm in v1.
  if (owner.kind === 'human' && owner.id && facts.principalId && owner.id === facts.principalId) return 'owner';
  return null;
}

/** What one write of a default Verifier answers. */
export interface DefaultVerifierWritten {
  id: string;
  projectId: string;
  defaultVerifierPrincipalId: string | null;
  revision: string;
  previous: string | null;
  standing: 'root' | 'administrator' | 'owner';
}

/**
 * THE SEAM: the gate, the value and the write of one default Verifier, on the
 * caller's open transaction (its caller commits or rolls back). `revision` is
 * the If-Match the direct door carries, or null where the caller holds the
 * row lock and checked the state itself (a change decision's stale check).
 * `refusedByPoint` is the E311 mark (card 5216d735): such a caller can only
 * be refused. `ledger` (a change decision's) rides the audit row.
 */
export async function setDefaultVerifierWithin(client: PoolClient, target: DefaultVerifierTarget, id: string, next: string | null,
  input: {
    facts: DefaultVerifierStandingFacts; audit: AuditActor; revision: string | null; refusedByPoint?: boolean;
    ledger?: Record<string, unknown> | null;
  }): Promise<DefaultVerifierWritten> {
  // 3. The row, locked, with the owning Project's owner.
  const found = target === 'project'
    ? await client.query(
      `SELECT p.id, p.id AS project_id, p.status, p.revision, p.default_verifier_principal_id,
              p.owner_principal_id, o.kind AS owner_kind
         FROM projects p LEFT JOIN principals o ON o.id = p.owner_principal_id
        WHERE p.id = $1 FOR UPDATE OF p`, [id])
    : await client.query(
      `SELECT ph.id, ph.project_id, ph.status, ph.revision, ph.default_verifier_principal_id,
              p.owner_principal_id, o.kind AS owner_kind
         FROM phases ph JOIN projects p ON p.id = ph.project_id
         LEFT JOIN principals o ON o.id = p.owner_principal_id
        WHERE ph.id = $1 FOR UPDATE OF ph`, [id]);
  const row = found.rows[0];
  if (!row) {
    throw new DefaultVerifierRefusal(404, target === 'project' ? 'PROJECT_NOT_FOUND' : 'PHASE_NOT_FOUND',
      `${target === 'project' ? 'Project' : 'Phase'} not found`);
  }
  // 4. The standing (before the revision, so a refusal never discloses state).
  // A request the point stage refused reaches here only to be refused by
  // name (card 5216d735, owner ruling E311): it never has standing.
  const standing = standingOf(input.facts, { id: row.owner_principal_id ? String(row.owner_principal_id) : null, kind: row.owner_kind ?? null });
  if (!standing || input.refusedByPoint === true) {
    throw new DefaultVerifierRefusal(403, DEFAULT_VERIFIER_REQUIRES_OWNER,
      row.owner_kind === 'group'
        ? 'On a Group-owned Project only root or an administrator session sets a default Verifier (AZ-A12 clause 6; v1)'
        : 'Setting a default Verifier requires root, an administrator session, or the person who owns the Project',
      { groupOwned: row.owner_kind === 'group' });
  }
  if (input.revision !== null && String(row.revision) !== input.revision) {
    throw new DefaultVerifierRefusal(target === 'project' ? 412 : 409, 'REVISION_MISMATCH',
      `The ${target === 'project' ? 'Project' : 'Phase'} changed since it was last read; reload and retry`);
  }
  if (row.status === 'archived') {
    throw new DefaultVerifierRefusal(409, target === 'project' ? 'PROJECT_ARCHIVED' : 'PHASE_ARCHIVED',
      `The ${target === 'project' ? 'Project' : 'Phase'} is archived and read-only; restore it first`);
  }
  // 5. The value.
  if (next) await validateValue(client, next);
  const previous = row.default_verifier_principal_id ? String(row.default_verifier_principal_id) : null;
  const updated = target === 'project'
    ? await client.query(
      `UPDATE projects SET default_verifier_principal_id = $2, revision = gen_random_uuid(), updated_at = NOW()
        WHERE id = $1 RETURNING id, revision, default_verifier_principal_id`, [id, next])
    : await client.query(
      `UPDATE phases SET default_verifier_principal_id = $2, revision = gen_random_uuid(), updated_at = NOW()
        WHERE id = $1 RETURNING id, revision, default_verifier_principal_id`, [id, next]);
  const projectId = String(row.project_id);
  await auditService.record({
    action: auditAction(target), actor: input.audit,
    resourceType: target, resourceId: String(row.id),
    metadata: {
      // Section 7.1 (T2 S5): an approved change's decision; the act's own fields are never overridden by it.
      ...(input.ledger ?? {}),
      previous, next, projectId, phaseId: target === 'phase' ? String(row.id) : null,
      standing, sessionId: input.facts.sessionId ?? null,
    },
  }, client);
  const feedActor = { actorPrincipalId: input.facts.principalId, actorHandle: input.audit.handle ?? input.facts.handle ?? null };
  if (target === 'project') {
    await feedEventService.emit(client, {
      name: 'project.updated', objectType: 'project', objectId: String(row.id), ...feedActor, projectId, payload: {},
    });
  } else {
    await feedEventService.emit(client, {
      name: 'phase.updated', objectType: 'phase', objectId: String(row.id), ...feedActor, projectId, payload: {},
    });
  }
  return {
    id: String(updated.rows[0].id), projectId, defaultVerifierPrincipalId: updated.rows[0].default_verifier_principal_id ?? null,
    revision: String(updated.rows[0].revision), previous, standing,
  };
}

/** Validation of the named principal (Part 2): a person or a Connector that passes arms 1-3. Exported for the
 * change-request filing of a default Verifier (T2 S5), which refuses the value at filing as this write would. */
export async function validateValue(client: PoolClient | typeof pool, principalId: string): Promise<void> {
  const found = await client.query(
    'SELECT id, kind, legacy_identity FROM principals WHERE id = $1', [principalId]);
  const row = found.rows[0];
  if (row?.kind === 'group') {
    throw new DefaultVerifierRefusal(422, 'DEFAULT_VERIFIER_GROUP_PRINCIPAL',
      'A Group principal never acts (AZ-A12 clause 3c): it cannot be a default Verifier. Name a person or a Connector.');
  }
  if (row?.kind === 'agent' && !row.legacy_identity) {
    throw new DefaultVerifierRefusal(422, 'DEFAULT_VERIFIER_AGENT_PRINCIPAL',
      'An Agent is bound to one Task: it cannot be the default Verifier of future cards. Name a person or a Connector.');
  }
  const usability = await principalVerifierUsability(client, principalId);
  if (!usability.usable) {
    const arm = usability.failedArm ?? 'principal';
    throw new DefaultVerifierRefusal(422, 'DEFAULT_VERIFIER_UNUSABLE',
      `The principal cannot judge cards: ${VERIFIER_ARM_REASONS[arm]}`, { failedArm: arm });
  }
}

/**
 * GET /projects/:id/default-verifier/candidates - the principals the picker
 * may offer (design Part 7): active people and Connectors (never a Group or
 * an Agent) that pass arms 1-3 of the usable predicate now. The point stage
 * has already required read on the Project; the list is directory
 * disclosure, so it also requires principals:read, as GET /principals does.
 */
export async function listDefaultVerifierCandidates(req: Request, res: Response): Promise<void> {
  const authReq = req as AuthRequest;
  if (!scopesSatisfy(authReq.scopes, 'principals:read')) {
    sendApiError(res, 403, 'DEFAULT_VERIFIER_CANDIDATES_PRINCIPALS_READ_REQUIRED',
      'Listing default Verifier candidates is directory disclosure and requires principals:read');
    return;
  }
  try {
    const rows = await pool.query(
      `SELECT id, kind, handle, display_name FROM principals
        WHERE status = 'active' AND (kind = 'human' OR kind = 'service' OR (kind = 'agent' AND legacy_identity))
        ORDER BY lower(COALESCE(display_name, handle)), id`);
    const candidates: Array<{ id: string; kind: string; handle: string; displayName: string | null }> = [];
    for (const row of rows.rows) {
      if ((await principalVerifierUsability(pool, String(row.id))).usable) {
        candidates.push({ id: String(row.id), kind: String(row.kind), handle: String(row.handle),
          displayName: row.display_name ?? null });
      }
    }
    res.json({ success: true, candidates });
  } catch (error) {
    const errorId = logCaughtFailure('[Default Verifier] candidates read failed', error);
    sendApiError(res, 503, 'DEFAULT_VERIFIER_UNAVAILABLE', 'The default Verifier candidates could not be read', undefined, { errorId });
  }
}

/** The shared handler body for both routes. */
export async function setDefaultVerifier(req: Request, res: Response, target: DefaultVerifierTarget): Promise<void> {
  const authReq = req as AuthRequest;
  const id = String(req.params.id ?? '');
  // 1. A login session, refused and audited before anything is looked up.
  if (!isLoginSessionKind(authReq.authMethod)) {
    await auditDenied(authReq, target, id, DEFAULT_VERIFIER_REQUIRES_SESSION);
    res.status(403).json({
      success: false, code: DEFAULT_VERIFIER_REQUIRES_SESSION,
      error: 'Setting a default Verifier is a login-session act on the owner plane: bearer credentials never perform it.',
    });
    return;
  }
  if (!authReq.principal?.id) {
    sendApiError(res, 403, 'PRINCIPAL_REQUIRED', 'This act requires a resolved principal identity');
    return;
  }
  // 2. The body.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(body).find((key) => key !== 'principalId');
  if (unknown) {
    sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown field '${unknown}' in request body`, undefined, { field: unknown });
    return;
  }
  if (!('principalId' in body)
    || (body.principalId !== null && (typeof body.principalId !== 'string' || !UUID.test(body.principalId)))) {
    sendApiError(res, 422, 'INVALID_DEFAULT_VERIFIER', 'principalId must be a principal UUID, or null to clear the default',
      undefined, { field: 'principalId' });
    return;
  }
  const next = body.principalId === null ? null : String(body.principalId).toLowerCase();
  const revision = ifMatch(req);
  if (!revision) {
    sendApiError(res, 400, 'REVISION_REQUIRED', 'The last observed revision is required (If-Match)');
    return;
  }
  if (!UUID.test(id)) {
    sendApiError(res, 404, target === 'project' ? 'PROJECT_NOT_FOUND' : 'PHASE_NOT_FOUND', `${target === 'project' ? 'Project' : 'Phase'} not found`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const written = await setDefaultVerifierWithin(client, target, id, next, {
      facts: defaultVerifierFactsOf(authReq), audit: auditActorFromRequest(authReq), revision,
      refusedByPoint: res.locals[DEFAULT_VERIFIER_POINT_REFUSED] === true,
    });
    const projectId = written.projectId;
    const previous = written.previous;
    const updated = { rows: [{ id: written.id, revision: written.revision, default_verifier_principal_id: written.defaultVerifierPrincipalId }] };
    await client.query('COMMIT');
    res.json({
      success: true,
      [target]: {
        id: String(updated.rows[0].id),
        ...(target === 'phase' ? { projectId } : {}),
        defaultVerifierPrincipalId: updated.rows[0].default_verifier_principal_id ?? null,
        revision: String(updated.rows[0].revision),
      },
      previousDefaultVerifierPrincipalId: previous,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof RequestFaultError) {
      const details = error instanceof DefaultVerifierRefusal ? error.details : {};
      await auditDenied(authReq, target, id, error.code, details);
      sendApiError(res, error.status, error.code, error.message, undefined,
        Object.keys(details).length > 0 ? details : undefined);
      return;
    }
    const errorId = logCaughtFailure('[Default Verifier] write failed', error);
    sendApiError(res, 503, 'DEFAULT_VERIFIER_UNAVAILABLE', 'The default Verifier could not be set', undefined, { errorId });
  } finally {
    client.release();
  }
}
