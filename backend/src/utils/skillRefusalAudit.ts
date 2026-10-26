import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { auditService, type AuditActor } from '../services/AuditService';
import { auditActorFromRequest } from './auditActor';
import { logCaughtFailure } from './secretSafeLog';
import { sendApiError } from './apiErrors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const recordedRefusals = new WeakSet<object>();
const recordedResponses = new WeakSet<Response>();

export class SkillRefusalAuditError extends Error {
  constructor() { super('Failed to record the refused Skill act'); }
}

/** Known direct service actors also record refusals after rollback. Error
 * identity, never a request flag, suppresses a second route-level row. */
export async function auditSkillRefusals<T>(action: string, actor: AuditActor, resourceId: string | null,
    write: () => Promise<T>): Promise<T> {
  try { return await write(); }
  catch (error) {
    const cause = error as { status?: number; code?: string };
    const status = cause?.status ?? (cause?.code === '23514' ? 409 : cause?.code === '22001' ? 400 : undefined);
    const knownActor = actor.principalId || actor.handle && actor.handle !== 'unknown';
    if (knownActor && status !== undefined && status >= 400 && status < 500) {
      const code = cause?.code === '23514' ? 'SKILL_LIFECYCLE_CONFLICT' : cause?.code === '22001' ? 'VALUE_TOO_LONG' : cause?.code;
      const refusal = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'REQUEST_REFUSED';
      try { await auditService.record({ action, actor, resourceType: 'skill', resourceId,
        outcome: 'denied', metadata: { refusal, status } }); }
      catch (auditError) {
        logCaughtFailure('[Skills audit] refusal write failed:', auditError);
        throw new SkillRefusalAuditError();
      }
      if (error && typeof error === 'object') recordedRefusals.add(error);
    }
    throw error;
  }
}

export function wasSkillRefusalRecorded(error: unknown): boolean {
  return !!error && typeof error === 'object' && recordedRefusals.has(error);
}
export function markSkillRefusalRecorded(res: Response): void {
  recordedResponses.add(res);
}

/** Write refusals include route ceilings, malformed requests and lifecycle decisions.
 * Hold only the JSON response until its audit write settles; successful writes
 * are audited inside their own transactions. Never copy request prose or ids
 * that might instead be private Skill names. No permission decision changes. */
export function attachSkillRefusalAudit(req: AuthRequest, res: Response, path: string): void {
  const actor = auditActorFromRequest(req);
  if (!actor.principalId && (!actor.handle || actor.handle === 'unknown')) return;
  const method = req.method.toUpperCase();
  const normalized = path.replace(/^\/api(?=\/)/, '').replace(/\/$/, '');
  const skill = /^\/skills(?:\/([^/]+))?(?:\/versions\/[^/]+\/(submit-review|reject|publish|retire)|\/(audience|owner))?$/.exec(normalized);
  const pin = /^\/projects\/([^/]+)\/skills\/([^/]+)$/.exec(normalized);
  let action: string | undefined;
  let resourceId: string | null = null;
  if (skill) {
    const [, id, transition, audience] = skill;
    resourceId = id && UUID.test(id) ? id : null;
    if (method === 'POST' && !id) action = 'skill.create';
    else if (method === 'PUT' && id && !transition && !audience) action = 'skill.create_version';
    else if (method === 'POST' && transition) action = `skill.${transition.replace(/-/g, '_')}`;
    else if (method === 'PATCH' && audience === 'audience') action = 'skill.set_global';
    else if (method === 'PUT' && audience === 'owner') action = 'skill.owner.change';
    else if (method === 'DELETE' && id && !transition && !audience) action = 'skill.delete';
  } else if (pin && ['PUT', 'DELETE'].includes(method)) {
    action = method === 'PUT' ? 'skill.project_pin' : 'skill.project_unpin';
    resourceId = UUID.test(pin[2]) ? pin[2] : null;
  }
  if (!action) return;
  const send = res.json.bind(res);
  let held = false;
  res.json = ((body: any) => {
    if (held) return res;
    if (res.statusCode < 400 || res.statusCode >= 500 || recordedResponses.has(res)) return send(body);
    held = true;
    const status = res.statusCode;
    const refusal = typeof body?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(body.code) ? body.code : 'REQUEST_REFUSED';
    void auditService.record({ action: action!, actor, resourceType: 'skill', resourceId,
      outcome: 'denied', metadata: { refusal, status } }).then(() => send(body)).catch(error => {
      const errorId = logCaughtFailure('[Skills audit] refusal write failed:', error);
      held = false;
      sendApiError(res, 500, 'AUDIT_WRITE_FAILED', 'Failed to record the refused Skill act', undefined, { errorId });
    });
    return res;
  }) as Response['json'];
}
