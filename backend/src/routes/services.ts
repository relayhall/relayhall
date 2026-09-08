// services.ts — REST surface for the Service and Connector registry (RH-P2.1).
//
// Authority (scopeMap): GET → services:read; POST/PATCH and descriptor
// publishing → services:write; retire/delete → services:admin; the
// owner-plane subroute (delivery configuration, visibility tier, runtime
// mode) → the root sentinel, because those fields are subscription-class
// (§2.6.4) — never agent-plane writable.
import { logCaughtFailure } from '../utils/secretSafeLog';
import { Router, Request, Response } from 'express';
import { filterAuthorizedResources } from '../middleware/sharedAuthorization';
import { AuthRequest } from '../middleware/auth';
import { sendApiError } from '../utils/apiErrors';
import { isLoginSessionKind } from '../utils/administratorSession';
import { DescriptorError } from '../utils/serviceDescriptor';
import {
  KNOWLEDGE_OWNER_PLANE_FIELDS,
  serviceRegistry,
  ServiceRegistryError,
} from '../services/ServiceRegistry';
import { auditActorFromRequest } from '../utils/auditActor';
import { boardEndpointFor, composeOnboardingPack } from '../utils/onboardingPack';
import { principalService, CredentialPolicyError } from '../services/PrincipalService';
import { pool } from '../db/connection';
import { lifecyclePolicyDenialEnvelope } from '../services/LifecyclePolicyService';

const router = Router();

function ifMatchRevision(req: Request): string {
  const raw = (req.headers['if-match'] as string | undefined) ?? '';
  return raw.replace(/^"+|"+$/g, '').trim();
}

function callerIdentity(req: AuthRequest): string {
  return req.principal?.id ?? req.userId ?? 'anonymous';
}

function revisionOrUndefined(req: Request): string | undefined {
  const revision = ifMatchRevision(req);
  return revision.length > 0 ? revision : undefined;
}

/**
 * Secret-safe failure telemetry (reviews f52e44db B1 + b82cb8bd B1): an
 * unexpected error logs a FIXED context string plus a bounded two-value
 * category. NOTHING exception-derived is serialized — not message, cause,
 * stack, custom properties, and not Error.name either, which is a mutable
 * instance string an adapter or attacker can load with private content.
 * The HTTP response stays the generic INTERNAL_ERROR envelope.
 */
function logServiceRouteFailure(context: string, e: unknown): string {
  return logCaughtFailure(`[Services API] ${context} failed:`, e);
}

function sendServiceError(res: Response, e: unknown): boolean {
  const policy = lifecyclePolicyDenialEnvelope(e);
  if (policy) {
    sendApiError(res, policy.status, policy.code, policy.message, undefined, policy.details);
    return true;
  }
  if (e instanceof ServiceRegistryError) {
    sendApiError(res, e.status, e.code, e.message, undefined, e.field ? { field: e.field } : undefined);
    return true;
  }
  if (e instanceof DescriptorError) {
    sendApiError(res, 422, e.code, e.message, undefined, { field: e.field });
    return true;
  }
  // Card 3f145fa3. A credential-policy refusal is a NAMED 4xx everywhere else
  // it is reported — `routes/principals.ts` maps it at both of its issuance
  // seams — and this route was the one place it fell through to
  // `500 INTERNAL_ERROR, 'Failed to register the service'`: a sentence that was
  // wrong twice over, because the service HAD been registered and the refusal
  // had a name (`ROOT_NOT_MINTABLE`, 422). The wizard's refusal table is an
  // ENUMERATED set on purpose, so a refusal that arrives without its code is a
  // refusal nobody can explain to the person who hit it.
  if (e instanceof CredentialPolicyError) {
    sendApiError(res, e.status, e.code, e.message);
    return true;
  }
  return false;
}

function checkQueryKeys(req: Request, res: Response, allowed: string[]): boolean {
  for (const key of Object.keys(req.query)) {
    if (!allowed.includes(key)) {
      sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown query parameter '${key}'`);
      return false;
    }
    if (Array.isArray(req.query[key])) {
      sendApiError(res, 400, 'INVALID_QUERY_VALUE', `Duplicate query parameter '${key}'`);
      return false;
    }
  }
  return true;
}

/**
 * E-11 dry-run: every mutating route accepts ?dryRun=true — the full
 * validation path runs inside a transaction that rolls back, writing
 * nothing. The response carries dryRun: true so a caller can never mistake
 * a rehearsal for the real thing.
 */
function parseDryRun(req: Request, res: Response): { ok: boolean; dryRun: boolean } {
  const raw = req.query.dryRun as string | undefined;
  if (raw === undefined) return { ok: true, dryRun: false };
  if (raw !== 'true' && raw !== 'false') {
    sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'dryRun must be true or false');
    return { ok: false, dryRun: false };
  }
  return { ok: true, dryRun: raw === 'true' };
}

function checkBodyKeys(req: Request, res: Response, allowed: string[]): Record<string, unknown> | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      sendApiError(res, 400, 'UNKNOWN_FIELD', `Unknown field '${key}' — accepted fields are: ${allowed.join(', ')}`);
      return null;
    }
  }
  return body;
}

/**
 * GET /api/services — list registered services.
 * Filters: ?kind=service|connector, ?status=draft|published|retired,
 * ?includeRetired=true. Retired services are excluded by default.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, ['kind', 'status', 'includeRetired'])) return;
    const includeRetiredRaw = req.query.includeRetired as string | undefined;
    if (includeRetiredRaw !== undefined && includeRetiredRaw !== 'true' && includeRetiredRaw !== 'false') {
      sendApiError(res, 400, 'INVALID_QUERY_VALUE', 'includeRetired must be true or false');
      return;
    }
    const listedServices = await serviceRegistry.list({
      kind: req.query.kind as string | undefined,
      status: req.query.status as string | undefined,
      includeRetired: includeRetiredRaw === 'true',
    });
    const services = await filterAuthorizedResources(
      req as AuthRequest,
      'read',
      listedServices,
      (service) => ({ type: 'service', id: service.id }),
    );
    res.json({ success: true, services });
  } catch (e) {
    if (sendServiceError(res, e)) return;
    const errorId = logServiceRouteFailure('list services', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list services', undefined, { errorId });
  }
});

/**
 * POST /api/services — register a service (services:write).
 * Registration is deliberately cheap; trust is expressed in grants (§2.9).
 * Subscription-class fields (delivery, visibility tier) are NOT accepted
 * here — they are owner-plane (§2.6.4) and have their own root-gated route.
 */
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, ['dryRun'])) return;
    const dry = parseDryRun(req, res);
    if (!dry.ok) return;
    const body = checkBodyKeys(req, res, ['slug', 'name', 'description', 'kind', 'runtimeMode', 'telemetryTier', 'ownerAccountId', 'issueCredential']);
    if (!body) return;
    // §7.4 (RH-P3.AZ-S5, sol m11): "CONNECTOR packs return in the
    // Connector-creation response" — an authenticated SESSION registering
    // a Connector may issue its FIRST credential in the same call and
    // receive the one-time onboarding pack. Self-service is the §9.2
    // subtree rule: a non-root session's requested scopes must lie within
    // its own current effective scopes (§5.2 rule 1 — registration never
    // escalates); bearer callers keep the credential-issuance surface.
    let issueRequest: { scopes: string[]; label: string | null; transport: 'any' | 'mcp' | 'api' } | null = null;
    if (body.issueCredential !== undefined) {
      if (!isLoginSessionKind(req.authMethod) || !req.principal?.id) {
        sendApiError(res, 403, 'SESSION_ONLY', 'issueCredential at registration is a login-session act (§7.4/§9.2); bearer callers issue through POST /principals/{id}/credentials');
        return;
      }
      if (body.kind !== 'connector') {
        sendApiError(res, 422, 'INVALID_ISSUE_REQUEST', 'issueCredential applies only to connector-kind registrations');
        return;
      }
      const spec = body.issueCredential as Record<string, unknown>;
      const scopes = Array.isArray(spec?.scopes) ? spec.scopes.map(String) : [];
      if (scopes.length === 0) {
        sendApiError(res, 422, 'INVALID_ISSUE_REQUEST', 'issueCredential.scopes must be a non-empty array');
        return;
      }
      // §5.2 rule 2 / AZ-18 — `root` is never delegable to a bearer credential —
      // is enforced ONCE, by `PrincipalService.issueCredential`, and there is no
      // second door here.
      //
      // There was one, and round-1 review (verdict `7cce6577`) was right to ask
      // for it back out. It was written when the registration and the mint still
      // committed separately, so refusing early was the only way a refused
      // connection left nothing behind. Once the two became one transaction that
      // reason evaporated: the service-layer refusal now rolls the registration
      // back, `sendServiceError` reports its named 422 unchanged, and the
      // caller cannot tell the two doors apart. What was left was a second copy
      // of a rule — the thing this codebase repeatedly finds drifting — with no
      // observable behaviour of its own. RV-A1 §2 prefers withdrawal to bounding,
      // and the acceptance suite measures the outcome, not which door produced it.
      const isRoot = Boolean(req.scopes?.includes('root'));
      if (!isRoot) {
        const held = req.scopes ?? [];
        const exceeding = scopes.filter((scope) => !held.includes(scope));
        if (exceeding.length > 0) {
          sendApiError(res, 403, 'ISSUE_EXCEEDS_SESSION', `requested credential scopes exceed the session's current effective set (§5.2 rule 1): ${exceeding.join(', ')}`);
          return;
        }
      }
      const transport = spec?.transport === undefined ? 'any' : String(spec.transport);
      if (!['any', 'mcp', 'api'].includes(transport)) {
        sendApiError(res, 422, 'INVALID_ISSUE_REQUEST', "issueCredential.transport must be 'any', 'mcp' or 'api'");
        return;
      }
      issueRequest = {
        scopes,
        label: typeof spec?.label === 'string' ? spec.label.slice(0, 128) : null,
        transport: transport as 'any' | 'mcp' | 'api',
      };
    }
    // AZ-S3 (review 87fec3e2 B2): a ROOT caller may register a Connector
    // for a NAMED owning Account (service Accounts are keyless and cannot
    // bootstrap their own first Connector); every other caller may only
    // target itself.
    if (body.ownerAccountId !== undefined) {
      if (typeof body.ownerAccountId !== 'string' || !body.ownerAccountId) {
        sendApiError(res, 400, 'INVALID_OWNER_ACCOUNT', 'ownerAccountId must be a principal UUID');
        return;
      }
      const isRoot = Boolean(req.scopes?.includes('root'));
      if (!isRoot && body.ownerAccountId !== req.principal?.id) {
        sendApiError(res, 403, 'OWNER_OUT_OF_SUBTREE', 'Only a root caller may register a Connector for another Account (§9.1)');
        return;
      }
    }
    const registration = {
      slug: body.slug,
      name: body.name,
      description: body.description,
      kind: body.kind,
      runtimeMode: body.runtimeMode,
      telemetryTier: body.telemetryTier,
      ownerAccountId: body.ownerAccountId,
    };

    let service: Awaited<ReturnType<typeof serviceRegistry.register>>;
    let onboarding: ReturnType<typeof composeOnboardingPack> | undefined;

    if (issueRequest && !dry.dryRun) {
      // CARD 3f145fa3 — REGISTRATION AND ITS FIRST CREDENTIAL COMMIT
      // TOGETHER, OR NEITHER DOES.
      //
      // These were two transactions. `register` committed the registry row and
      // its paired Connector principal, and only THEN was the credential
      // issued — so every refusal from the issuance policy left behind a
      // Connector that would never hold a credential, a service principal
      // beside it, and, worst of the three, a permanently occupied
      // GLOBALLY UNIQUE slug (migration 076). The product offers no way to
      // issue a credential for an existing connection and no way to delete one
      // from the wizard, so those rows were unclearable by the first-time
      // operator who made them, and the obvious recovery — retry with the same
      // name — collided with the wreck of the previous attempt.
      //
      // The repair is not a compensating delete. A compensation is a second
      // write that can itself fail, and this failure mode is precisely "the
      // second write did not happen". One transaction makes the orphan
      // UNREPRESENTABLE instead: `register` rides the caller's client
      // (`MutationOptions.transaction`) and `issueCredential` already took one
      // (AZ-S4), so the pair is one act on one connection.
      //
      // The DENIAL LEDGER is deliberately NOT in this transaction:
      // `issueCredential` records its refusals through the pool, so a rolled
      // back attempt still leaves the durable `credential.mint | denied` row
      // §5.2 rule 8 requires. A refusal that rolls back its own audit trail
      // would be a worse defect than the one being fixed.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        service = await serviceRegistry.register(registration, callerIdentity(req), { transaction: client });
        const paired = await client.query('SELECT principal_id FROM services WHERE id = $1', [(service as any).id]);
        const connectorPrincipalId = paired.rows[0]?.principal_id ? String(paired.rows[0].principal_id) : null;
        if (!connectorPrincipalId) {
          // Now a genuine "nothing was created": the same refusal the caller
          // always got, but the rollback below makes its sentence true.
          throw new CredentialPolicyError(500, 'CONNECTOR_UNPAIRED',
            'The registered connector carries no paired principal — nothing was created');
        }
        const issued = await principalService.issueCredential({
          principalId: connectorPrincipalId,
          scopes: issueRequest.scopes,
          label: issueRequest.label,
          transport: issueRequest.transport,
          createdByPrincipalId: req.principal?.id ?? null,
        }, auditActorFromRequest(req), client);
        await client.query('COMMIT');
        // Only after COMMIT. Composing the pack earlier would hand a person a
        // credential for rows that may still roll back.
        onboarding = composeOnboardingPack({
          endpoint: boardEndpointFor(req),
          credential: {
            credentialId: issued.credentialId,
            keyId: issued.keyId,
            secretOnce: issued.fullKey,
            expiresAt: null,
            transport: issueRequest.transport,
          },
          scopes: issueRequest.scopes,
          rules: [],
        });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    } else {
      service = await serviceRegistry.register(registration, callerIdentity(req), { dryRun: dry.dryRun });
    }

    res.status(201).json({ success: true, service, ...(onboarding ? { onboarding } : {}), ...(dry.dryRun ? { dryRun: true } : {}) });
  } catch (e) {
    if (sendServiceError(res, e)) return;
    const errorId = logServiceRouteFailure('register service', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to register the service', undefined, { errorId });
  }
});

/**
 * GET /api/services/:id — one service, by UUID or slug.
 */
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const service = await serviceRegistry.getByIdOrSlug(req.params.id);
    res.json({ success: true, service });
  } catch (e) {
    if (sendServiceError(res, e)) return;
    const errorId = logServiceRouteFailure('read service', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to read the service', undefined, { errorId });
  }
});

/**
 * PATCH /api/services/:id — metadata update (services:write), revision-bound.
 * status may move draft→published (requires a descriptor version); retirement
 * has its own admin surface.
 */
router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, ['dryRun'])) return;
    const dry = parseDryRun(req, res);
    if (!dry.ok) return;
    const body = checkBodyKeys(req, res, ['name', 'description', 'status', 'telemetryTier']);
    if (!body) return;
    const service = await serviceRegistry.getByIdOrSlug(req.params.id);
    const updated = await serviceRegistry.update(
      service.id,
      body,
      revisionOrUndefined(req),
      callerIdentity(req),
      { dryRun: dry.dryRun },
    );
    res.json({ success: true, service: updated, ...(dry.dryRun ? { dryRun: true } : {}) });
  } catch (e) {
    if (sendServiceError(res, e)) return;
    const errorId = logServiceRouteFailure('update service', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to update the service', undefined, { errorId });
  }
});

/**
 * PATCH /api/services/:id/owner-plane — subscription-class fields (§2.6.4):
 * delivery mode/endpoint/SECRET/interval, visibility tier, runtime mode. The
 * scope map routes this to the ROOT sentinel: settable through the human
 * surface or the admin credential class only, never agent-plane
 * services:write.
 *
 * C2 (ruling ccd53781 R1): this descriptor is the SINGLE SOURCE OF TRUTH for
 * where a Connector receives delivery, in which mode, and under which signing
 * secret — for BOTH the per-assignee work plane and the observation plane. A
 * subscription never carries a URL of its own. deliverySecret is write-only:
 * reads report deliveryHasSecret instead.
 */
router.patch('/:id/owner-plane', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, ['dryRun'])) return;
    const dry = parseDryRun(req, res);
    if (!dry.ok) return;
    const body = checkBodyKeys(req, res, [
      'runtimeMode', 'visibilityTier', 'deliveryMode', 'deliveryEndpoint', 'deliverySecret',
      'deliveryPollIntervalSeconds',
      // RH-KW1 (KNOWLEDGE-DESIGN `94747de9` §4.2): the seven knowledge
      // fields join THIS seat rather than getting a route of their own.
      // The scope map already routes this path to the root sentinel, so
      // a `services:write` credential setting any of them is refused by
      // CONSTRUCTION and not by a new check — which is what acceptance
      // item 6's first clause drills. Spread from the registry's own
      // declaration so the allowlist and the act cannot drift apart.
      ...KNOWLEDGE_OWNER_PLANE_FIELDS,
    ]);
    if (!body) return;
    const service = await serviceRegistry.getByIdOrSlug(req.params.id);
    const updated = await serviceRegistry.updateOwnerPlane(
      service.id,
      body,
      revisionOrUndefined(req),
      callerIdentity(req),
      { dryRun: dry.dryRun, auditActor: auditActorFromRequest(req) },
    );
    res.json({ success: true, service: updated, ...(dry.dryRun ? { dryRun: true } : {}) });
  } catch (e) {
    if (sendServiceError(res, e)) return;
    const errorId = logServiceRouteFailure('update owner-plane fields', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to update the service', undefined, { errorId });
  }
});

/**
 * GET /api/services/:id/descriptor — the current capability descriptor.
 */
router.get('/:id/descriptor', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const descriptorVersion = await serviceRegistry.getCurrentDescriptor(req.params.id);
    res.json({ success: true, descriptorVersion });
  } catch (e) {
    if (sendServiceError(res, e)) return;
    const errorId = logServiceRouteFailure('read descriptor', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to read the descriptor', undefined, { errorId });
  }
});

/**
 * PUT /api/services/:id/descriptor — publish a NEW immutable descriptor
 * version (services:write), revision-bound. Identical content is refused
 * (DESCRIPTOR_UNCHANGED) rather than silently bumping the version.
 */
router.put('/:id/descriptor', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, ['dryRun'])) return;
    const dry = parseDryRun(req, res);
    if (!dry.ok) return;
    const body = checkBodyKeys(req, res, ['descriptor']);
    if (!body) return;
    const service = await serviceRegistry.getByIdOrSlug(req.params.id);
    const result = await serviceRegistry.publishDescriptor(
      service.id,
      body.descriptor,
      revisionOrUndefined(req),
      callerIdentity(req),
      { dryRun: dry.dryRun },
    );
    res.status(201).json({
      success: true,
      service: result.service,
      descriptorVersion: result.descriptorVersion,
      ...(dry.dryRun ? { dryRun: true } : {}),
    });
  } catch (e) {
    if (sendServiceError(res, e)) return;
    const errorId = logServiceRouteFailure('publish descriptor', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to publish the descriptor', undefined, { errorId });
  }
});

/**
 * GET /api/services/:id/descriptor/versions — version metadata, newest first.
 */
router.get('/:id/descriptor/versions', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const versions = await serviceRegistry.listDescriptorVersions(req.params.id);
    res.json({ success: true, versions });
  } catch (e) {
    if (sendServiceError(res, e)) return;
    const errorId = logServiceRouteFailure('list descriptor versions', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list descriptor versions', undefined, { errorId });
  }
});

/**
 * GET /api/services/:id/descriptor/versions/:version — one version, with content.
 */
router.get('/:id/descriptor/versions/:version', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, [])) return;
    const service = await serviceRegistry.getByIdOrSlug(req.params.id);
    const record = await serviceRegistry.getDescriptorVersion(service.id, Number(req.params.version));
    res.json({ success: true, descriptorVersion: record });
  } catch (e) {
    if (sendServiceError(res, e)) return;
    const errorId = logServiceRouteFailure('read descriptor version', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to read the descriptor version', undefined, { errorId });
  }
});

/**
 * POST /api/services/:id/retire — retire the whole service (services:admin).
 * Irreversible (§4.4): stops new consumers; the record and its versions stay.
 */
router.post('/:id/retire', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, ['dryRun'])) return;
    const dry = parseDryRun(req, res);
    if (!dry.ok) return;
    const body = checkBodyKeys(req, res, []);
    if (!body) return;
    const service = await serviceRegistry.getByIdOrSlug(req.params.id);
    const retired = await serviceRegistry.retireService(
      service.id,
      revisionOrUndefined(req),
      callerIdentity(req),
      { dryRun: dry.dryRun },
    );
    res.json({ success: true, service: retired, ...(dry.dryRun ? { dryRun: true } : {}) });
  } catch (e) {
    if (sendServiceError(res, e)) return;
    const errorId = logServiceRouteFailure('retire service', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to retire the service', undefined, { errorId });
  }
});

/**
 * POST /api/services/:id/descriptor/versions/:version/retire — retire ONE
 * descriptor version (services:admin; RH-DESIGN.5 R5 staged retirement).
 * Existing pins keep resolving; profile paths refuse retired pins (RH-P2.2).
 */
router.post('/:id/descriptor/versions/:version/retire', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, ['dryRun'])) return;
    const dry = parseDryRun(req, res);
    if (!dry.ok) return;
    const body = checkBodyKeys(req, res, []);
    if (!body) return;
    const service = await serviceRegistry.getByIdOrSlug(req.params.id);
    const version = await serviceRegistry.retireDescriptorVersion(
      service.id,
      Number(req.params.version),
      callerIdentity(req),
      { dryRun: dry.dryRun },
    );
    res.json({ success: true, version, ...(dry.dryRun ? { dryRun: true } : {}) });
  } catch (e) {
    if (sendServiceError(res, e)) return;
    const errorId = logServiceRouteFailure('retire descriptor version', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to retire the descriptor version', undefined, { errorId });
  }
});

/**
 * DELETE /api/services/:id — hard removal (services:admin). Restricted and
 * never the routine path (§4.4); retire is the ordinary end of life.
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!checkQueryKeys(req, res, ['dryRun'])) return;
    const dry = parseDryRun(req, res);
    if (!dry.ok) return;
    const service = await serviceRegistry.getByIdOrSlug(req.params.id);
    await serviceRegistry.delete(service.id, { dryRun: dry.dryRun });
    res.json({ success: true, message: dry.dryRun ? 'Dry run — nothing deleted' : 'Service deleted', ...(dry.dryRun ? { dryRun: true } : {}) });
  } catch (e) {
    if (sendServiceError(res, e)) return;
    const errorId = logServiceRouteFailure('delete service', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to delete the service', undefined, { errorId });
  }
});

export default router;
