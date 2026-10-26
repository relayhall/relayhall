// authorityEditRoute.ts — what the three AZ-A13 edit routes share (AUTHZ
// amendment AZ-A13, ratified 2026-10-11, E95; card 1a38270d): the session-only
// refusal with its durable audit (clause 4c), the editor's standing (clause 4a:
// root, an administrator login session through AUTHORITY_EDIT_ACT, or the
// owning Account whose subtree holds the object), the split of a body into the
// edited fields and the act's own controls, and the clause-13 refusal body.
import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { auditService } from '../services/AuditService';
import { auditActorFromRequest } from '../utils/auditActor';
import { auditChainFor } from '../utils/auditChain';
import { pool } from '../db/connection';
import {
  AUTHORITY_EDIT_ACT, AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR, administratorSessionOf, isLoginSessionKind,
} from '../utils/administratorSession';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { credentialLifecycleService } from '../services/CredentialLifecycleService';
import {
  AuthorityEditError, EDIT_STEP_UP_ACTIONS, type EditObjectType, type EditorContext, type EditResult,
} from '../services/AuthorityEditExecutor';

/** The controls a body may carry beside the edited fields. */
export const EDIT_CONTROL_FIELDS = ['stepUpToken', 'lifetime', 'reason', 'narrowAgents', 'acknowledgeDependents'] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The step-up store compares target ids as text (the AZ-A12 lesson): every
 * object id is canonical lower case before it is used. */
export function canonicalObjectId(raw: string): string {
  return UUID_PATTERN.test(raw) ? raw.toLowerCase() : raw;
}

/** clause 4c: a bearer caller is refused SESSION_ONLY with a durable denied
 * audit BEFORE anything is looked up. Returns false when it answered.
 * `options.action` names the audited act when it is not the type's edit (the
 * grant revoke and bulk revoke acts, owner rulings E413 and E418(b)). */
export async function requireEditSession(req: AuthRequest, res: Response, type: EditObjectType,
  options: { action?: string; message?: string } = {}): Promise<boolean> {
  if (!isLoginSessionKind(req.authMethod)) {
    await auditService.record({
      action: options.action ?? EDIT_STEP_UP_ACTIONS[type], actor: auditActorFromRequest(req), outcome: 'denied',
      resourceType: type, resourceId: UUID_PATTERN.test(req.params.id ?? '') ? canonicalObjectId(req.params.id) : null,
      metadata: {
        refusal: 'SESSION_ONLY', authMethod: req.authMethod ?? 'unknown', clause: 'AZ-A13 clause 4c',
        chain: req.principal?.id ? await auditChainFor(pool, req.principal.id) : [],
      },
    }).catch(() => undefined);
    res.status(403).json({
      error: 'Refused', code: 'SESSION_ONLY',
      message: options.message ?? 'Editing an authority object is a board human-surface act (AZ-A13 clause 4c): bearer credentials are refused - an agent asks with relayhall_access_request',
      rule: 'every edit route refuses a bearer caller', subject: 'editor', clause: 'AZ-A13 clause 4c',
    });
    return false;
  }
  if (!req.principal?.id) {
    res.status(403).json({ error: 'Forbidden', code: 'PRINCIPAL_REQUIRED', message: 'This act requires a resolved principal identity' });
    return false;
  }
  return true;
}

/**
 * clause 4a: the editor's standing — root, an administrator login session
 * (AUTHORITY_EDIT_ACT), or the owning Account (the object's holder lies in the
 * caller's own descendant subtree). Null when none applies.
 */
export async function editorStanding(req: AuthRequest, holderPrincipalId: string | null): Promise<EditorContext['standing'] | null> {
  if (req.scopes?.includes('root')) return 'root';
  const administrator = administratorSessionOf({
    authMethod: req.authMethod,
    handle: req.userId,
    principalRole: req.principal?.role ?? null,
    sessionRole: req.sessionRole ?? null,
  }, resolveActorRole, AUTHORITY_EDIT_ACT);
  if (administrator.ok) return 'administrator';
  const callerId = req.principal?.id;
  if (!callerId || !holderPrincipalId) return null;
  if (holderPrincipalId === callerId) return 'owning-account';
  return (await credentialLifecycleService.isDescendant(callerId, holderPrincipalId)) ? 'owning-account' : null;
}

/** clause 13 / §5.2 rule 8: the durable denied audit of a refusal a ROUTE
 * answers itself (the executor audits its own), with the caller's chain. */
export async function auditRouteRefusal(req: AuthRequest, type: EditObjectType, id: string, refusal: string,
  detail: Record<string, unknown>, action?: string): Promise<void> {
  try {
    const chain = req.principal?.id ? await auditChainFor(pool, req.principal.id) : [];
    await auditService.record({
      action: action ?? EDIT_STEP_UP_ACTIONS[type], actor: auditActorFromRequest(req), outcome: 'denied',
      resourceType: type, resourceId: UUID_PATTERN.test(id) ? id : null,
      metadata: { refusal, ...detail, chain },
    });
  } catch {
    // The refusal still answers.
  }
}

/** clause 13: refused for want of standing, audited, before any step-up is
 * spent. `concealAs` answers 404 under that code instead (the warrant
 * surface's self-scope concealment, §9.1); the audit records the truth. */
export async function refuseStanding(req: AuthRequest, res: Response, type: EditObjectType, id: string,
  options: { concealAs?: string } = {}): Promise<void> {
  await auditRouteRefusal(req, type, id, AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR, {
    clause: 'AZ-A13 clause 4a', subject: 'editor', ...(options.concealAs ? { answeredAs: options.concealAs } : {}),
  });
  if (options.concealAs) {
    res.status(404).json({ error: 'Refused', code: options.concealAs, message: `No such ${type}` });
    return;
  }
  res.status(403).json({
    error: 'Refused', code: AUTHORITY_EDIT_REQUIRES_ADMINISTRATOR,
    message: `Editing this ${type} requires root, an administrator login session, or the Account that owns it`,
    rule: 'the editor is root, an administrator, or the owning Account', subject: 'editor', clause: 'AZ-A13 clause 4a',
  });
}

/** The body, split: the edited fields, and the act's own controls. */
export function splitEditBody(body: unknown): { fields: Record<string, unknown>; controls: Record<string, unknown> } {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const fields: Record<string, unknown> = {};
  const controls: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if ((EDIT_CONTROL_FIELDS as readonly string[]).includes(key)) controls[key] = value;
    else fields[key] = value;
  }
  return { fields, controls };
}

export function editorContext(req: AuthRequest, standing: EditorContext['standing']): EditorContext {
  return {
    principalId: String(req.principal?.id),
    standing,
    sessionScopes: req.scopes ?? [],
    role: resolveActorRole({ handle: req.userId ?? '', principalRole: req.principal?.role ?? null, sessionRole: req.sessionRole ?? null }),
  };
}

export function sendAuthorityEditError(res: Response, e: unknown): boolean {
  if (e instanceof AuthorityEditError) {
    res.status(e.status).json({ error: 'Refused', code: e.code, message: e.message, ...e.refusal });
    return true;
  }
  return false;
}

/** The response: what moved, never a secret. */
export function editResponse(result: EditResult): Record<string, unknown> {
  return {
    success: true,
    edit: {
      objectType: result.objectType, objectId: result.objectId, direction: result.direction, changed: result.changed,
      before: result.before, after: result.after, approvalId: result.approvalId, auditId: result.auditId,
      lifetime: result.lifetime, narrowedAgents: result.narrowedAgents, revokedAgents: result.revokedAgents,
      revokedPredecessorIds: result.revokedPredecessorIds, releasedTaskIds: result.releasedTaskIds,
    },
  };
}
