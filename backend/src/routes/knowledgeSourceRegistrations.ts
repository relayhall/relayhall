/**
 * Two-way registration of a knowledge source, the core half (card 08792425,
 * member N6; the default-store design's choice C7). Mounted at
 * `/knowledge-source-registrations` through routeRegistry.ts; the Services page
 * of the dashboard is its one client.
 *
 *   GET  /knowledge-source-registrations                    every registered source, with its state
 *   POST /knowledge-source-registrations                    register one from an installer's bundle
 *   GET  /knowledge-source-registrations/:id                one source's state, and the operator's step by NAME
 *   GET  /knowledge-source-registrations/:id/return-bundle  the return bundle: public material only
 *
 * THE GATE, on every route and in this order: a LOGIN SESSION (every bearer
 * credential, a root bearer included, and every API key is refused
 * KNOWLEDGE_SOURCE_REGISTER_REQUIRES_SESSION; the MCP ingress admits only
 * bearers, so the act is unreachable over MCP by construction, and no tool
 * names this family); a resolved principal; then root, or an administrator
 * session through `administratorSessionOf` with KNOWLEDGE_SOURCE_REGISTER_ACT.
 * A refused registration is audited as denied, and so is every refusal of the
 * act after the gate, by name, and every one of those denied rows is written
 * (awaited) BEFORE the refusal answers. A refused READ (the three GET routes) is not
 * audited, by design: it changes nothing, and the census of denied audits
 * covers acts only. The scope map routes the family to
 * `authenticated` because the gate is the authentication KIND plus a role,
 * which a scope string cannot say.
 *
 * The registration itself burns a single-use step-up bound to
 * (`knowledge.source.register`, the bundle's certificate fingerprint) inside
 * its own transaction. It is not retry-keyed: the step-up is single-use and a
 * repeated upload of the same bundle is refused REGISTRATION_ENDPOINT_TAKEN by
 * name, so a retry converges on a named answer.
 */
import { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { ROOT_SCOPE } from '../utils/scopeMap';
import { sendApiError } from '../utils/apiErrors';
import { logCaughtFailure, logCaughtWarning } from '../utils/secretSafeLog';
import { auditService } from '../services/AuditService';
import { auditActorFromRequest } from '../utils/auditActor';
import {
  administratorSessionOf, isLoginSessionKind, KNOWLEDGE_SOURCE_REGISTER_ACT,
} from '../utils/administratorSession';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { StepUpError } from '../services/StepUpService';
import { ServiceRegistryError } from '../services/ServiceRegistry';
import { lifecyclePolicyDenialEnvelope } from '../services/LifecyclePolicyService';
import {
  KNOWLEDGE_SOURCE_REGISTER_AUDIT_ACTION, KNOWLEDGE_SOURCE_REGISTRATION_RESOURCE_TYPE, KnowledgeSourceRegistrationError,
  REGISTRATION_REQUEST_FIELDS, REGISTRATION_STATE_SCHEMA, buildReturnBundle, checkFingerprintConfirmation, listRegistrations,
  normalizeFingerprint, parseAllowedNetworks, parseRegistrationBundle, readRegistration, registerKnowledgeSource,
  registrationState,
} from '../services/KnowledgeSourceRegistration';
import { knowledgeAssertionIssuer } from './knowledge';

export const knowledgeSourceRegistrationsRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Refusal = { ok: false; status: number; code: string; message: string };

/** The standing for every route of this family, or the refusal (a bearer is refused before root is considered). */
export function registrationStanding(req: AuthRequest): { ok: true; standing: 'root' | 'administrator' } | Refusal {
  if (!isLoginSessionKind(req.authMethod)) {
    return {
      ok: false, status: 403, code: KNOWLEDGE_SOURCE_REGISTER_ACT.requiresSession,
      message: 'Registering a knowledge source is a login-session act: bearer credentials, root bearers included, never perform it, and it is not offered over MCP',
    };
  }
  if (!req.principal?.id) {
    return { ok: false, status: 403, code: 'PRINCIPAL_REQUIRED', message: 'This act requires a resolved principal identity' };
  }
  if (req.scopes?.includes(ROOT_SCOPE)) return { ok: true, standing: 'root' };
  const administrator = administratorSessionOf({
    authMethod: req.authMethod, handle: req.userId, principalRole: req.principal?.role ?? null, sessionRole: req.sessionRole ?? null,
  }, resolveActorRole, KNOWLEDGE_SOURCE_REGISTER_ACT);
  if (!administrator.ok) return administrator;
  return { ok: true, standing: 'administrator' };
}

function refusalBody(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { success: false, error: 'Refused', code, message, ...extra };
}

/** The bundle's fingerprint, if the body carries a readable one: the resource a pre-Service refusal is audited against. */
function bundleFingerprint(body: Record<string, unknown>): string | null {
  let bundle = body.bundle;
  if (typeof bundle === 'string' && bundle.length <= 400 * 1024) {
    try { bundle = JSON.parse(bundle); } catch { return null; }
  }
  return bundle && typeof bundle === 'object' ? normalizeFingerprint((bundle as Record<string, unknown>).certificateSha256) : null;
}

/**
 * The denied audit row of a refused act. Every caller AWAITS it before the
 * refusal answers, so the row is durable by the time the caller reads the
 * answer. A failed write is the codebase's refusal-audit rule
 * (routes/telemetry.ts, the envelope refusal): it never turns the refusal into
 * a different answer, and it is logged as a warning (secret-safe: class and
 * code only) instead of vanishing. It never throws.
 */
async function auditDenied(req: AuthRequest, code: string, extra: Record<string, unknown> = {}): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fingerprint = bundleFingerprint(body);
  await auditService.record({
    action: KNOWLEDGE_SOURCE_REGISTER_AUDIT_ACTION, actor: auditActorFromRequest(req), outcome: 'denied',
    resourceType: KNOWLEDGE_SOURCE_REGISTRATION_RESOURCE_TYPE, resourceId: fingerprint,
    metadata: {
      refusal: code, authMethod: req.authMethod ?? 'unknown',
      ...(fingerprint ? { certificateSha256: fingerprint } : {}),
      ...(typeof body.confirmation === 'string' ? { fingerprintConfirmation: body.confirmation.slice(0, 16) } : {}),
      ...extra,
    },
  }).catch((err) => {
    logCaughtWarning('[Knowledge source registration] refusal audit write failed:', err);
  });
}

/**
 * A typed refusal of this family, answered by name; false for anything else.
 * `beforeAnswer` is the act's denied audit: it is AWAITED before the response
 * leaves, so no caller can read the answer before the row exists (the GET
 * routes pass none: a refused read is not audited).
 */
async function sendRegistrationError(res: Response, e: unknown,
  beforeAnswer?: (code: string, details?: Record<string, string>) => Promise<void>): Promise<boolean> {
  let answer: (() => void) | null = null;
  let code = '';
  let details: Record<string, string> | undefined;
  if (e instanceof KnowledgeSourceRegistrationError) {
    code = e.code; details = e.details;
    answer = () => { res.status(e.status).json(refusalBody(e.code, e.message, { ...(e.field ? { field: e.field } : {}), ...(e.details ?? {}) })); };
  } else if (e instanceof StepUpError) {
    code = e.code;
    answer = () => { res.status(e.status).json(refusalBody(e.code, e.message, e.challenge ? { stepUp: e.challenge } : {})); };
  } else if (e instanceof ServiceRegistryError) {
    code = e.code;
    answer = () => { res.status(e.status).json(refusalBody(e.code, e.message, e.field ? { field: e.field } : {})); };
  } else {
    const policy = lifecyclePolicyDenialEnvelope(e);
    if (policy) {
      code = policy.code;
      answer = () => { sendApiError(res, policy.status, policy.code, policy.message, undefined, policy.details); };
    }
  }
  if (!answer) return false;
  // THE ORDER: the denied audit row is written first, then the refusal answers.
  if (beforeAnswer) await beforeAnswer(code, details);
  answer();
  return true;
}

async function gate(req: AuthRequest, res: Response, audit: boolean): Promise<boolean> {
  res.set('Cache-Control', 'private, no-store');
  const standing = registrationStanding(req);
  if (standing.ok) return true;
  if (audit) await auditDenied(req, standing.code);
  res.status(standing.status).json(refusalBody(standing.code, standing.message));
  return false;
}

knowledgeSourceRegistrationsRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!(await gate(req, res, false))) return;
    const rows = await listRegistrations();
    res.json({
      success: true, schemaVersion: REGISTRATION_STATE_SCHEMA,
      registrations: rows.map(({ service, registration }) => registrationState(service, registration)),
    });
  } catch (e) {
    if (await sendRegistrationError(res, e)) return;
    const errorId = logCaughtFailure('[Knowledge source registration] list failed:', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list the knowledge source registrations', undefined, { errorId });
  }
});

knowledgeSourceRegistrationsRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!(await gate(req, res, true))) return;
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
    const unknown = Object.keys(body).filter((key) => !REGISTRATION_REQUEST_FIELDS.includes(key)).sort();
    if (unknown.length > 0) {
      await auditDenied(req, 'UNKNOWN_FIELD', { fields: unknown.slice(0, 16) });
      res.status(400).json(refusalBody('UNKNOWN_FIELD',
        `Unknown fields: ${unknown.join(', ')}; accepted fields are: ${REGISTRATION_REQUEST_FIELDS.join(', ')}`));
      return;
    }
    let registered;
    try {
      const allowedNetworks = parseAllowedNetworks(body.allowedNetworks);
      const bundle = parseRegistrationBundle(body.bundle, allowedNetworks);
      if (body.slug !== undefined) {
        if (typeof body.slug !== 'string' || body.slug.length === 0) {
          throw new KnowledgeSourceRegistrationError(422, 'REGISTRATION_BUNDLE_INVALID', 'slug must be a non-empty string', 'slug');
        }
        bundle.slug = body.slug;
      }
      const confirmation = checkFingerprintConfirmation(bundle, body.confirmedFingerprint, body.confirmation);
      registered = await registerKnowledgeSource({
        bundle, confirmation, allowedNetworks, stepUpToken: body.stepUpToken,
        principalId: String(req.principal!.id), actor: auditActorFromRequest(req),
      });
    } catch (e) {
      // Audited as denied BEFORE the refusal answers (sendRegistrationError awaits it).
      if (await sendRegistrationError(res, e, (code, details) => auditDenied(req, code, details ?? {}))) return;
      throw e;
    }
    // The act is committed. A return bundle the core cannot build honestly (a
    // key that is not Ed25519) is answered by name beside it, never as a 500.
    let returnBundle = null;
    let returnBundleRefusal = null;
    try {
      returnBundle = buildReturnBundle(registered.service, registered.registration, knowledgeAssertionIssuer(req));
    } catch (e) {
      if (!(e instanceof KnowledgeSourceRegistrationError)) throw e;
      returnBundleRefusal = { code: e.code, message: e.message };
    }
    res.status(201).json({
      success: true,
      registration: registrationState(registered.service, registered.registration),
      returnBundle,
      ...(returnBundleRefusal ? { returnBundleRefusal } : {}),
    });
  } catch (e) {
    const errorId = logCaughtFailure('[Knowledge source registration] register failed:', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to register the knowledge source', undefined, { errorId });
  }
});

async function oneRegistration(req: AuthRequest, res: Response) {
  const id = String(req.params.id ?? '');
  if (!UUID.test(id)) {
    res.status(400).json(refusalBody('INVALID_REGISTRATION_ID', 'A registration is addressed by its Service id (a UUID)'));
    return null;
  }
  const found = await readRegistration(id);
  if (!found) {
    res.status(404).json(refusalBody('REGISTRATION_NOT_FOUND', 'No knowledge source was registered under this Service id'));
    return null;
  }
  return found;
}

knowledgeSourceRegistrationsRouter.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!(await gate(req, res, false))) return;
    const found = await oneRegistration(req, res);
    if (!found) return;
    res.json({ success: true, registration: registrationState(found.service, found.registration) });
  } catch (e) {
    if (await sendRegistrationError(res, e)) return;
    const errorId = logCaughtFailure('[Knowledge source registration] read failed:', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to read the knowledge source registration', undefined, { errorId });
  }
});

knowledgeSourceRegistrationsRouter.get('/:id/return-bundle', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!(await gate(req, res, false))) return;
    const found = await oneRegistration(req, res);
    if (!found) return;
    res.json(buildReturnBundle(found.service, found.registration, knowledgeAssertionIssuer(req)));
  } catch (e) {
    if (await sendRegistrationError(res, e)) return;
    const errorId = logCaughtFailure('[Knowledge source registration] return bundle failed:', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to build the return bundle', undefined, { errorId });
  }
});
