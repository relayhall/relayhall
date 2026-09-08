/**
 * routes/scim — the inbound SCIM 2.0 endpoint family (RFC 7643/7644).
 *
 * Contract: design `d95136d7` §7.4, vocabulary **A24**, AUTHZ `4d961e37`
 * **AZ-A4 clause 3**, sitting `5a7fd9af` **SSO-R7**; wave brief `4bbfe967`
 * §2.1–§2.3; candidate design record `c49e0037`.
 *
 * ── THE SCOPE AND THESE ROUTES LAND IN THE SAME COMMIT ──
 *
 * `scopeMap.ts` states the rule and its precedent: a scope becomes mintable
 * only WITH a live route surface, the way `telemetry:write` "became mintable
 * at AZ-S6 with its consuming surface, POST /telemetry/frames". Minting
 * `directory-provisioning:write` ahead of this router would break that rule,
 * which is why there is no smaller honest slice of this wave.
 *
 * ── AND WHY `root` IS NOT THE GATE ──
 *
 * AZ-18 forbids delegating `root` to a bearer credential, and the SCIM client
 * IS a bearer credential — a service Account's Connector (A17.2). SSO-R7's
 * whole point was that the alternative needed a declared amendment, and A24 is
 * it. `root` still reaches these routes, because it is the global sentinel and
 * satisfies every requirement; it is simply not what they require.
 *
 * ── TWO ERROR SHAPES, DELIBERATELY ──
 *
 * A caller refused at the ROUTE CEILING gets the platform's envelope, because
 * that refusal happens in `sharedAuthorizationMiddleware` before this router
 * is reached — and that funnel must stay uniform for every family, so a
 * SCIM-shaped exception carved into it would be a worse trade than a caller
 * seeing a plain 403. Every refusal this router itself makes is the RFC 7644
 * §3.12 error object, which is what a conforming client branches on.
 */
import { Router, Request, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { logCaughtFailure } from '../utils/secretSafeLog';
import {
  SCIM_BASE_PATH,
  SCIM_ERROR_SCHEMA,
  SCIM_LIST_RESPONSE_SCHEMA,
  SCIM_USER_SCHEMA,
  ScimError,
  parseUserFilter,
  scimProvisioningService,
  scimUserResource,
  type ScimActingChain,
  type ScimUserFilter,
} from '../services/identity/ScimProvisioningService';
import {
  SCIM_GROUP_SCHEMA,
  SCIM_GROUP_MAPPED_ATTRIBUTES,
  scimGroupProvisioningService,
  scimGroupResource,
} from '../services/identity/ScimGroupProvisioning';
import {
  SCIM_GROUPS_RUNG_AMENDMENT,
  scimAmendmentRatified,
} from '../services/identity/scimAmendments';

const router = Router();

/**
 * SS-2's instrument, applied to this family.
 *
 * `/scim` IS its own mount, so the AST mount census in
 * `authorizationRouteCoverage` does see it — but it sees ONE mount, not six
 * routes, exactly as it sees one `/auth`. A route added under here without a
 * line in this list is a silent expansion of a surface that creates Accounts,
 * so it is a failure instead.
 */
/**
 * A-L34, THE BUILD GATE (RH-LENSES-a, card 74e02a05).
 *
 * The Groups rung exists only while amendment A24.1 is RECORDED AS
 * RATIFIED. This one boolean decides BOTH the census entries below and the
 * route registrations further down, so the slice cannot half-exist: delete
 * the register row and the surface is gone, the census is gone with it, and
 * `scimProvisioningContract`'s agreement assertion still holds.
 *
 * It is not a comment saying the rung depends on the amendment. A comment
 * stays true after somebody ships a surface the owner never allowed.
 */
const GROUPS_RUNG_RATIFIED = scimAmendmentRatified(SCIM_GROUPS_RUNG_AMENDMENT);

/** The six Groups routes, named once. */
const SCIM_GROUP_ROUTES = [
  'POST /v2/Groups',
  'GET /v2/Groups',
  'GET /v2/Groups/:id',
  'PUT /v2/Groups/:id',
  'PATCH /v2/Groups/:id',
  'DELETE /v2/Groups/:id',
] as const;

const SCIM_USER_ROUTE_CENSUS = [
  'GET /v2/ServiceProviderConfig',
  'GET /v2/ResourceTypes',
  'GET /v2/Schemas',
  'POST /v2/Users',
  'GET /v2/Users',
  'GET /v2/Users/:id',
  // The lifecycle rung (candidate B): the two deprovision signals of design
  // §7.5 arrive here — `active=false` by PUT or PATCH, removal from the
  // provisioning scope by DELETE — and AZ-A4 clause 2 turns on them.
  'PUT /v2/Users/:id',
  'PATCH /v2/Users/:id',
  'DELETE /v2/Users/:id',
] as const;

/**
 * SS-2's instrument, as the router actually serves it.
 *
 * RH-LENSES-a's Groups rung joins it ONLY under A24.1 (a SCIM Group
 * resource here is a DIRECTORY GROUP REFERENCE, never a board Group: it
 * holds no authority, no authorization predicate reads it, and turning one
 * into a Group is an owner-plane act on another surface entirely).
 */
export const SCIM_ROUTE_CENSUS: readonly string[] = [
  ...SCIM_USER_ROUTE_CENSUS,
  ...(GROUPS_RUNG_RATIFIED ? SCIM_GROUP_ROUTES : []),
];

/** RFC 7644 §3.1: SCIM bodies are `application/scim+json`. */
const SCIM_CONTENT_TYPE = 'application/scim+json';

/** A bounded page. RFC 7644 §3.4.2.4 lets the server cap `count`; an uncapped
 *  one would let a single call enumerate the whole directory in one response. */
const MAX_PAGE_COUNT = 200;
const DEFAULT_PAGE_COUNT = 100;

function sendScim(res: Response, status: number, body: unknown): void {
  res.status(status).type(SCIM_CONTENT_TYPE).send(JSON.stringify(body));
}

/** RFC 7644 §3.12. `status` is a STRING in the SCIM error object. */
function sendScimError(res: Response, error: unknown, action: string): void {
  if (error instanceof ScimError) {
    sendScim(res, error.status, {
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(error.status),
      ...(error.scimType ? { scimType: error.scimType } : {}),
      detail: error.message,
    });
    return;
  }
  const errorId = logCaughtFailure(`[SCIM] ${action} failed:`, error);
  sendScim(res, 500, {
    schemas: [SCIM_ERROR_SCHEMA],
    status: '500',
    detail: `the request could not be completed (error id ${errorId})`,
  });
}

/**
 * The chain a SCIM act is judged on — the ACTING principal and the Account
 * at its ROOT — or null when the request is not even shaped like one.
 *
 * ── THE RULE IS THREE CONDITIONS, RULED, AND NO MORE ──
 *
 * Owner ruling `4ae7ce53` §1.2, on escalation `3226b0be`. Three review
 * rounds each found a defect in this function, and four of five findings
 * were about WHICH principal may act as the SCIM client: `req.principal.id`
 * could never match the bound Account (r1 `d4c0b5e2`); the root-of-chain
 * repair admitted an Agent beneath the Connector (r2 `84456731`); the
 * four-condition repair proved a parented `service` PRINCIPAL rather than a
 * Connector (r3 `a96c3788`). Every round re-derived "is this a Connector?"
 * from principal columns, and that derivation cannot be completed that way:
 * a Connector is not a principal kind but a `services` registry row paired
 * with its delegated identity (A17.2, migration 097).
 *
 * So the rule ASKS THE REGISTRY, and the two conditions that stood in for
 * it are WITHDRAWN rather than kept beside it:
 *
 *   1. the acting link IS the authenticated principal — middleware
 *      consistency, kept; decided here;
 *   2. the acting principal is a Connector BY THE REGISTRY — a `services`
 *      row with kind='connector' names it; decided in
 *      `ScimProvisioningService.resolveProviderForClient` through the ONE
 *      predicate in `utils/connectorRegistry`, the same SQL
 *      `SubscriberActorService` issues;
 *   3. the chain root is the bound parentless Account — the A24 scoping
 *      value; "parentless" decided here, "bound" by the lookup that follows.
 *
 * WITHDRAWN — `kind === 'service'`: the registry predicate refuses an Agent
 * for the same reason it refuses an unregistered service principal, so the
 * kind column has no work left. WITHDRAWN — the direct-child condition:
 * migration 096's chain-shape trigger already makes a Connector's parent a
 * parentless Account, so that condition could only refuse a chain the
 * database cannot hold, and the fixture written to make it non-vacuous
 * modelled exactly such a chain. Prefer withdrawing a mechanism to bounding
 * it.
 *
 * A caller with NO chain is its own acting principal and its own root and
 * is judged by the same three conditions, not by a special arm: it could
 * only provision by being a registry Connector AND a bound parentless
 * Account at once, and the binding surface pairs an Account with a
 * Connector BENEATH it, so nothing satisfies both. It fails closed by the
 * rule.
 */
export function scimActingChainFor(req: AuthRequest): ScimActingChain | null {
  const principal = req.principal;
  if (!principal?.id) return null;
  const links = req.delegationLinks ?? [];
  const self: { principalId: string; parentPrincipalId: string | null } = {
    principalId: principal.id,
    parentPrincipalId: principal.parentPrincipalId ?? null,
  };
  const acting = links[0] ?? self;
  const account = links[links.length - 1] ?? self;
  if (acting.principalId !== principal.id) return null;
  if (account.parentPrincipalId) return null;
  return { actingPrincipalId: acting.principalId, accountPrincipalId: account.principalId };
}

/**
 * The Identity provider this caller provisions for (A24 scoping) — and, once
 * resolved, "a push received" for it (SSO-R8). The heartbeat is recorded
 * here, on the ONE path every route of the family goes through, so no route
 * can be added that an alive Identity provider's pushes fail to watermark;
 * an unresolved caller records nothing, because a refused credential is not
 * the Identity provider pushing.
 */
async function providerFor(req: Request) {
  const provider = await scimProvisioningService.resolveProviderForClient(scimActingChainFor(req as AuthRequest));
  await scimProvisioningService.recordPush(provider);
  return provider;
}

function auditActorFor(req: Request) {
  const authReq = req as AuthRequest;
  return {
    principalId: authReq.principal?.id ?? null,
    handle: authReq.userId || 'unknown',
    authMethod: authReq.authMethod ?? 'unknown',
    credentialId: authReq.credentialId,
  };
}

// ── Discovery (RFC 7644 §4) ────────────────────────────────────────────────
//
// Static protocol documents. They disclose no board data, and they are behind
// the same scope AND the same binding as the rest of the family rather than
// public: RFC 7644 §2 permits an unauthenticated ServiceProviderConfig, but
// `PUBLIC_ROUTE_MOUNTS` is documented in the tree as "a security-significant
// code-review event" to grow, and a provisioning client authenticates anyway.
//
// They resolve the binding they do not otherwise need, so the family obeys ONE
// rule. Without it a caller holding the scope but bound to no Identity
// provider could read these three and nothing else — an asymmetry with no
// reason behind it, which is a worse thing to leave in a security surface
// than a redundant lookup.
//
// Every value below is a TRUE statement about this rung. PATCH is supported
// since the lifecycle rung (candidate B) over the enumerated paths
// `ScimProvisioningService` honours; bulk, sorting, ETags and password change
// are not, and saying otherwise would have a conforming client choose a verb
// or a form that 4xxs.

router.get('/v2/ServiceProviderConfig', async (req: Request, res: Response): Promise<void> => {
  try {
    await providerFor(req);
  } catch (error) {
    sendScimError(res, error, 'ServiceProviderConfig');
    return;
  }
  sendScim(res, 200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://datatracker.ietf.org/doc/html/rfc7644',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE_COUNT },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    // The Identity provider's SCIM client presents an `rh_` bearer credential.
    // RFC 7644 §4 calls the receiving side the "service provider" and asks it
    // to declare the schemes it accepts — that term means THIS BOARD in the
    // protocol, never the issuer pushing to it.
    // The board's own credential is an `rh_` bearer value, so `oauthbearertoken`
    // is the closest registered type and the description says exactly what it
    // means rather than implying an OAuth token endpoint that is not this.
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer credential',
        description:
          "an rh_ Connector credential holding directory-provisioning:write, presented as an Authorization Bearer value",
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${SCIM_BASE_PATH}/ServiceProviderConfig` },
  });
});

router.get('/v2/ResourceTypes', async (req: Request, res: Response): Promise<void> => {
  try {
    await providerFor(req);
  } catch (error) {
    sendScimError(res, error, 'resource types');
    return;
  }
  const resourceTypes = [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      description: 'Parentless human Accounts provisioned by an Identity provider (A24)',
      schema: SCIM_USER_SCHEMA,
      schemaExtensions: [],
      meta: { resourceType: 'ResourceType', location: `${SCIM_BASE_PATH}/ResourceTypes/User` },
    },
    ...(GROUPS_RUNG_RATIFIED ? [{
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      // The description says what the resource IS on this board, because a
      // client administrator reading discovery is exactly the person who
      // would otherwise assume a pushed Group becomes an authority object.
      description:
        'Directory group REFERENCES observed at this Identity provider (A24.1). A reference holds no '
        + 'authority and creates no board Group; an administrator binds one to a Group by an owner-plane act.',
      schema: SCIM_GROUP_SCHEMA,
      schemaExtensions: [],
      meta: { resourceType: 'ResourceType', location: `${SCIM_BASE_PATH}/ResourceTypes/Group` },
    }] : []),
  ];
  sendScim(res, 200, {
    schemas: [SCIM_LIST_RESPONSE_SCHEMA],
    totalResults: resourceTypes.length,
    itemsPerPage: resourceTypes.length,
    startIndex: 1,
    Resources: resourceTypes,
  });
});

router.get('/v2/Schemas', async (req: Request, res: Response): Promise<void> => {
  try {
    await providerFor(req);
  } catch (error) {
    sendScimError(res, error, 'schemas');
    return;
  }
  // Only the attributes this rung actually honours are declared. A schema
  // advertising attributes the endpoint ignores is a false statement a client
  // would act on.
  const userSchema = {
    id: SCIM_USER_SCHEMA,
    name: 'User',
    description: 'SCIM core User, restricted to the attributes this endpoint maps',
    attributes: [
      { name: 'userName', type: 'string', multiValued: false, required: true, uniqueness: 'server', mutability: 'readWrite', returned: 'default', caseExact: false },
      { name: 'externalId', type: 'string', multiValued: false, required: false, uniqueness: 'none', mutability: 'readWrite', returned: 'default', caseExact: true },
      { name: 'displayName', type: 'string', multiValued: false, required: false, uniqueness: 'none', mutability: 'readWrite', returned: 'default', caseExact: false },
      { name: 'emails', type: 'complex', multiValued: true, required: false, mutability: 'readWrite', returned: 'default' },
      { name: 'active', type: 'boolean', multiValued: false, required: false, mutability: 'readWrite', returned: 'default' },
    ],
    meta: { resourceType: 'Schema', location: `${SCIM_BASE_PATH}/Schemas/${SCIM_USER_SCHEMA}` },
  };
  // The Group schema declares ONLY the attributes this rung honours, and it
  // derives that list from `SCIM_GROUP_MAPPED_ATTRIBUTES` rather than
  // repeating it: a schema written out beside a handler that honours
  // something else is precisely the false statement the rule above bars.
  const groupAttributeShapes: Record<string, Record<string, unknown>> = {
    displayName: {
      name: 'displayName', type: 'string', multiValued: false, required: true,
      uniqueness: 'none', mutability: 'readWrite', returned: 'default', caseExact: false,
    },
    externalId: {
      name: 'externalId', type: 'string', multiValued: false, required: false,
      uniqueness: 'server', mutability: 'readWrite', returned: 'default', caseExact: true,
    },
    members: {
      name: 'members', type: 'complex', multiValued: true, required: false,
      mutability: 'readWrite', returned: 'default',
      subAttributes: [
        { name: 'value', type: 'string', multiValued: false, required: true, mutability: 'immutable', returned: 'default', caseExact: true },
        { name: '$ref', type: 'reference', multiValued: false, required: false, mutability: 'immutable', returned: 'default' },
        // `type` is declared because a client MAY send it and this rung
        // branches on it: `"Group"` is refused (NG-1). Leaving it out of the
        // schema would make the refusal look arbitrary.
        { name: 'type', type: 'string', multiValued: false, required: false, mutability: 'immutable', returned: 'default', canonicalValues: ['User'] },
      ],
    },
  };
  const groupSchema = {
    id: SCIM_GROUP_SCHEMA,
    name: 'Group',
    description: 'SCIM core Group, restricted to the attributes this endpoint maps',
    attributes: SCIM_GROUP_MAPPED_ATTRIBUTES.map((name) => groupAttributeShapes[name]),
    meta: { resourceType: 'Schema', location: `${SCIM_BASE_PATH}/Schemas/${SCIM_GROUP_SCHEMA}` },
  };
  // A schema advertising attributes the endpoint ignores is a false
  // statement a client would act on -- and so is a schema for an endpoint
  // that is not mounted at all.
  const schemas = GROUPS_RUNG_RATIFIED ? [userSchema, groupSchema] : [userSchema];
  sendScim(res, 200, {
    schemas: [SCIM_LIST_RESPONSE_SCHEMA],
    totalResults: schemas.length,
    itemsPerPage: schemas.length,
    startIndex: 1,
    Resources: schemas,
  });
});

// ── Users ──────────────────────────────────────────────────────────────────

router.post('/v2/Users', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await providerFor(req);
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ScimError(400, 'invalidValue', 'the request body must be a SCIM User object');
    }
    const record = await scimProvisioningService.createUser(
      provider,
      auditActorFor(req),
      body as Record<string, unknown>,
    );
    sendScim(res, 201, scimUserResource(record));
  } catch (error) {
    sendScimError(res, error, 'create user');
  }
});

router.get('/v2/Users', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await providerFor(req);
    let filter: ScimUserFilter | undefined;
    if (req.query.filter !== undefined) {
      if (typeof req.query.filter !== 'string') {
        throw new ScimError(400, 'invalidFilter', 'filter must be a single expression');
      }
      filter = parseUserFilter(req.query.filter);
    }
    // RFC 7644 §3.4.2.4 gives the two parameters DIFFERENT floors, and the
    // first cut of this handler shared one helper between them (review
    // d4c0b5e2 B2): `startIndex` is 1-based, but `count` is NON-NEGATIVE and
    // `count=0` is the ordinary reconciliation request — "return no
    // resources but report totalResults", which is how a client asks how
    // many there are without fetching them.
    const startIndex = readBoundedInteger(req.query.startIndex, 1, 'startIndex', 1);
    const count = Math.min(readBoundedInteger(req.query.count, DEFAULT_PAGE_COUNT, 'count', 0), MAX_PAGE_COUNT);

    const page = await scimProvisioningService.listUsers(provider, { filter, startIndex, count });
    sendScim(res, 200, {
      schemas: [SCIM_LIST_RESPONSE_SCHEMA],
      totalResults: page.totalResults,
      itemsPerPage: page.resources.length,
      startIndex,
      Resources: page.resources.map(scimUserResource),
    });
  } catch (error) {
    sendScimError(res, error, 'list users');
  }
});

router.get('/v2/Users/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await providerFor(req);
    const record = await scimProvisioningService.getUser(provider, req.params.id);
    if (!record) {
      // An Account this Identity provider did not provision is INDISTINGUISHABLE from
      // one that does not exist. That is A24's read boundary: the refusal must
      // not confirm the existence of a board Account the directory has no
      // business knowing about.
      throw new ScimError(404, null, 'no such provisioned Account');
    }
    sendScim(res, 200, scimUserResource(record));
  } catch (error) {
    sendScimError(res, error, 'get user');
  }
});

// ── The lifecycle rung (candidate B) ───────────────────────────────────────
//
// PUT and PATCH answer with the resource as it now reads; DELETE answers 204
// and the resource STAYS readable to its own Identity provider as
// `active: false` (see `ScimProvisioningService.deleteUser` for why). Every
// refusal is the RFC 7644 §3.12 object; the deprovision itself is
// `ScimProvisioningService.applyLifecycle`, which is where AZ-A4 clause 2's
// mechanism lives — nothing about status is decided in this file.

function scimBody(req: Request): Record<string, unknown> {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ScimError(400, 'invalidValue', 'the request body must be a SCIM object');
  }
  return body as Record<string, unknown>;
}

router.put('/v2/Users/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await providerFor(req);
    const record = await scimProvisioningService.replaceUser(provider, auditActorFor(req), req.params.id, scimBody(req));
    sendScim(res, 200, scimUserResource(record));
  } catch (error) {
    sendScimError(res, error, 'replace user');
  }
});

router.patch('/v2/Users/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await providerFor(req);
    const record = await scimProvisioningService.patchUser(provider, auditActorFor(req), req.params.id, scimBody(req));
    sendScim(res, 200, scimUserResource(record));
  } catch (error) {
    sendScimError(res, error, 'patch user');
  }
});

router.delete('/v2/Users/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await providerFor(req);
    await scimProvisioningService.deleteUser(provider, auditActorFor(req), req.params.id);
    res.status(204).end();
  } catch (error) {
    sendScimError(res, error, 'delete user');
  }
});

// ── Groups (RH-LENSES-a, card 74e02a05; amendment A24.1) ──────────────────
//
// A SCIM Group resource IS a directory group reference. Every handler here
// resolves its provider through the same `providerFor(req)` the User rung
// uses, answers `application/scim+json` through `sendScim`, and errors
// through `sendScimError` — the authentication chain is unchanged, and this
// rung adds no gate and no scope of its own.

// A-L34: the SAME boolean the census reads. A surface the owner has not
// allowed is not registered at all -- there is nothing to reach.
if (GROUPS_RUNG_RATIFIED) {
router.post('/v2/Groups', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await providerFor(req);
    const record = await scimGroupProvisioningService.create(provider, auditActorFor(req), scimBody(req));
    sendScim(res, 201, scimGroupResource(record));
  } catch (error) {
    sendScimError(res, error, 'create group');
  }
});

router.get('/v2/Groups', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await providerFor(req);
    // The same two floors the User listing takes, for the same reason:
    // `startIndex` is 1-based and `count` is non-negative, because `count=0`
    // is the ordinary reconciliation request.
    const startIndex = readBoundedInteger(req.query.startIndex, 1, 'startIndex', 1);
    const count = Math.min(readBoundedInteger(req.query.count, DEFAULT_PAGE_COUNT, 'count', 0), MAX_PAGE_COUNT);
    const page = await scimGroupProvisioningService.list(provider, { startIndex, count });
    sendScim(res, 200, {
      schemas: [SCIM_LIST_RESPONSE_SCHEMA],
      totalResults: page.totalResults,
      itemsPerPage: page.resources.length,
      startIndex,
      Resources: page.resources.map(scimGroupResource),
    });
  } catch (error) {
    sendScimError(res, error, 'list groups');
  }
});

router.get('/v2/Groups/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await providerFor(req);
    const record = await scimGroupProvisioningService.get(provider, req.params.id);
    if (!record) {
      // A reference THIS Identity provider did not record is
      // indistinguishable from one that does not exist — A24's read
      // boundary, in the same words the User rung uses.
      throw new ScimError(404, null, 'no such Group');
    }
    sendScim(res, 200, scimGroupResource(record));
  } catch (error) {
    sendScimError(res, error, 'get group');
  }
});

router.put('/v2/Groups/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await providerFor(req);
    const record = await scimGroupProvisioningService.replace(
      provider, auditActorFor(req), req.params.id, scimBody(req),
    );
    sendScim(res, 200, scimGroupResource(record));
  } catch (error) {
    sendScimError(res, error, 'replace group');
  }
});

router.patch('/v2/Groups/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await providerFor(req);
    const record = await scimGroupProvisioningService.patch(
      provider, auditActorFor(req), req.params.id, scimBody(req),
    );
    sendScim(res, 200, scimGroupResource(record));
  } catch (error) {
    sendScimError(res, error, 'patch group');
  }
});

router.delete('/v2/Groups/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await providerFor(req);
    await scimGroupProvisioningService.remove(provider, auditActorFor(req), req.params.id);
    res.status(204).end();
  } catch (error) {
    sendScimError(res, error, 'delete group');
  }
});
}

// ── The terminal SCIM 404 (design §4.6) ───────────────────────────────────
//
// An unrouted `/scim/v2/*` path used to fall through to the application's
// own default handler and answer a NON-SCIM body, which a conforming client
// reads as a transport failure rather than as "no such resource" — so a
// client mis-configured by one path segment reports the board as DOWN.
//
// It is LAST in this file on purpose: Express matches in registration
// order, so every real route above claims its path first and only genuinely
// unrouted paths reach here. It answers the RFC 7644 §3.12 error object,
// with the SAME `application/scim+json` type every other refusal carries.
// It is MIDDLEWARE and not a route on purpose: `SCIM_ROUTE_CENSUS` and the
// router must agree entry-for-entry (`A-L8`), and a 404 responder is not a
// resource surface -- registering it as six method entries would dilute a
// census whose entire value is that it enumerates what this family SERVES.
router.use('/v2', (req: Request, res: Response): void => {
  sendScim(res, 404, {
    schemas: [SCIM_ERROR_SCHEMA],
    status: '404',
    detail: `no SCIM resource at ${req.path}`,
  });
});

/** RFC 7644 §3.4.2.4, with the floor passed in because the two parameters
 *  do not share one: `startIndex` is 1-based, `count` is non-negative. A
 *  malformed value is refused rather than coerced, so a client mis-paging
 *  learns of it instead of silently re-reading page one. */
function readBoundedInteger(value: unknown, fallback: number, name: string, minimum: number): number {
  if (value === undefined) return fallback;
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new ScimError(400, 'invalidValue', `${name} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

export default router;
