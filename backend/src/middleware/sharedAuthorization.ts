import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { authorizationService, AuthorizationActor } from '../services/AuthorizationService';
import type { AuthorizationAction } from '../services/AuthorizationService';
import { authorizationRepository } from '../services/AuthorizationRepository';
import type { AuthorizationListScope } from '../services/AuthorizationRepository';
import type { GrantResourceType } from '../services/GrantService';
import type { AuthorizationResource } from '../services/AuthorizationService';
import { normalizePathForScope, requiredScopeFor, ROOT_SCOPE } from '../utils/scopeMap';
import { resolveActorRole } from '../utils/taskAutomationRole';
import { sendApiError } from '../utils/apiErrors';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { accessSurfaceService, type AccessLevel } from '../services/AccessSurfaceService';
import { auditService } from '../services/AuditService';
import { auditActorFromRequest } from '../utils/auditActor';

export function actorFromRequest(req: AuthRequest): AuthorizationActor {
  return {
    principalId: req.principal?.id ?? null,
    handle: req.userId ?? '',
    role: resolveActorRole({
      handle: req.userId ?? '',
      principalRole: req.principal?.role,
      sessionRole: req.sessionRole,
    }),
    scopes: req.scopes ?? null,
    authenticated: Boolean(req.userId),
    // AZ-S3: the middleware-resolved delegation chain rides into every
    // authorization decision so the SQL chain intersection is live.
    delegation: req.delegationLinks && req.delegationLinks.length > 1
      ? { links: req.delegationLinks }
      : null,
  };
}

/** Every protected route passes this shared ceiling before its handler. Row-
 * bearing handlers then call the same service with their ResourceRef. */
export const POINT_RESOURCE_ROUTE_TYPES: Record<string, GrantResourceType> = {
  tasks: 'task',
  projects: 'project',
  phases: 'phase',
  reports: 'report',
  skills: 'skill',
  personalities: 'personality',
  services: 'service',
};

const NON_OBJECT_SEGMENTS = new Set([
  'filter-options', 'board', 'current', 'next', 'notifications', 'auto-archive',
  'stats', 'batch', 'operating-contract',
  // Candidate A2 collection routes (design 986be411 §4; review d2ed1775 B1):
  // both are collection surfaces, not point resources — without this the
  // classifier synthesizes a Task id 'ids'/'bulk-archive' and 404s them.
  'ids', 'bulk-archive',
  // Candidate A3 scale-read collection routes (design 986be411 §5).
  'aggregates', 'graph',
]);

export interface PointAuthorizationTarget {
  alternativeAction?: 'shepherd';
  type: GrantResourceType;
  identifier: string;
  action: AuthorizationAction;
}

export async function filterAuthorizedResources<T>(
  req: AuthRequest,
  action: AuthorizationAction,
  values: T[],
  resourceFor: (value: T) => AuthorizationResource,
): Promise<T[]> {
  const actor = req.authorizationActor ?? actorFromRequest(req);
  const entries = values.map((value) => ({ value, resource: resourceFor(value) }));
  const allowedKeys = new Set<string>();
  const pending = new Map<GrantResourceType, string[]>();

  for (const entry of entries) {
    // Root/administrator and genuinely materialized rows can resolve without
    // another query. Every unresolved row is grouped into the ONE SQL adapter
    // below; list size never becomes an authorization-query count.
    const materialized = authorizationService.authorizeResource(actor, action, entry.resource, []);
    const key = `${entry.resource.type}:${entry.resource.id}`;
    if (materialized.allowed) {
      allowedKeys.add(key);
      continue;
    }
    const ids = pending.get(entry.resource.type) ?? [];
    ids.push(entry.resource.id);
    pending.set(entry.resource.type, ids);
  }

  await Promise.all([...pending.entries()].map(async ([type, ids]) => {
    const authorized = await authorizationRepository.authorizedIds(actor, type, ids, action);
    for (const id of authorized) allowedKeys.add(`${type}:${id}`);
  }));

  return entries
    .filter(({ resource }) => allowedKeys.has(`${resource.type}:${resource.id}`))
    .map(({ value }) => value);
}

/**
 * The row-form narrowing bound to ONE request, as a value.
 *
 * `filterAuthorizedResources` needs the request, which is why the services
 * that count Tasks for a surface — project statistics, the task distribution —
 * had no way to narrow and simply did not (card 72258a60's census). Handing
 * them the request would put middleware inside a service; handing them THIS
 * gives them the same decision as a REQUIRED parameter, so a caller that
 * forgets it fails to compile, and the service stays ignorant of Express.
 */
export type AuthorizedTaskNarrowing = <T>(
  rows: T[],
  idOf: (row: T) => string,
) => Promise<T[]>;

export function authorizedTaskNarrowing(req: AuthRequest): AuthorizedTaskNarrowing {
  return <T>(rows: T[], idOf: (row: T) => string): Promise<T[]> =>
    filterAuthorizedResources(req, 'read', rows, (row) => ({ type: 'task', id: idOf(row) }));
}

/**
 * A query executor a decision may run on - the pool, or an OPEN TRANSACTION.
 * Same shape and same reason as `AuthorizationRepository`'s `queryable`
 * (RH-P3.AZ-S7): a write path decides on its OWN client, so the decision is
 * part of the transaction that performs the write rather than a separate
 * observation beside it.
 */
export type AuthorizationQueryable = {
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
};

/**
 * The TARGET Project of a write, RESOLVED and DECIDED in one act.
 *
 * `POST /tasks` accepted a `project` and carried it straight into the INSERT
 * (card `9c177e6a`): `TaskManagerDB.resolveProjectId` turned a name or a UUID
 * into a `project_id` and nothing anywhere asked whether the caller could
 * reach that Project, so an outsider to a PRIVATE Project could put a Task
 * inside it - and `PATCH /tasks/:id` and `PATCH /tasks/batch` could move one
 * into it, through the same helper.
 *
 * Three things about the shape, each of them load-bearing:
 *
 *  1. It is a REQUIRED parameter of every path that writes `tasks.project_id`.
 *     Handing those services the request would put middleware inside a
 *     service; handing them THIS gives them the same decision every read
 *     surface makes, and a create path that forgets it fails to COMPILE. It is
 *     the `AuthorizedTaskNarrowing` shape above (card `72258a60`) at the point
 *     altitude. In particular the decision is NOT derived from the `TaskActor`
 *     the write already carries: that parameter is OPTIONAL, and its
 *     `authorization` field falls back to `SYSTEM_AUTHORIZATION_ACTOR`, which
 *     holds `root` - deriving it there would fail OPEN for exactly the callers
 *     that forgot to supply one.
 *
 *  2. It RESOLVES as well as decides, and returns ONE value for both refusals.
 *     "No such Project" and "no such Project FOR YOU" are not two outcomes a
 *     later branch has to remember to fold together - they are the same
 *     `null`, so the house rule (unreadable and absent are indistinguishable;
 *     AUTHZ `4d961e37` par.9.6, the 44d1bf89 rule) holds by construction
 *     rather than by discipline. Resolution runs the SAME query the point
 *     stage resolves a Project with (`AuthorizationRepository.resolve`:
 *     `id::text = $1 OR name = $1`, `LIMIT 2` and an exact-count test), so a
 *     Project addressable at `GET /projects/:id` is addressable here, one that
 *     is not is not, and an AMBIGUOUS identifier resolves to nothing rather
 *     than to whichever row sorted first.
 *
 *  3. The action is `read`, not `write`. The visibility arms of the shared
 *     predicate apply to `read` alone, so requiring `write` would mean only a
 *     Project's owner, an administrator or a grantee could file a Task in a
 *     SHARED Project - a policy change nobody ratified. What the card names is
 *     the outsider to a PRIVATE Project, and readability is exactly the line
 *     that separates them.
 */
export type AuthorizedProjectTarget = (
  nameOrId: string,
  queryable: AuthorizationQueryable,
) => Promise<string | null>;

export function authorizedProjectTarget(req: AuthRequest): AuthorizedProjectTarget {
  const actor = req.authorizationActor ?? actorFromRequest(req);
  return async (nameOrId, queryable) => {
    const found = await queryable.query(
      'SELECT id::text AS id FROM projects WHERE id::text = $1 OR name = $1 ORDER BY id LIMIT 2',
      [nameOrId],
    );
    if (found.rows.length !== 1) return null;
    const projectId = String(found.rows[0].id);
    const authorized = await authorizationRepository.authorizedIds(
      actor, 'project', [projectId], 'read', queryable,
    );
    return authorized.has(projectId) ? projectId : null;
  };
}

/**
 * The SAME decision `filterAuthorizedResources` makes row by row, in the form
 * a PAGINATED list query must carry in its own WHERE.
 *
 * Both forms resolve the actor identically (`req.authorizationActor` first, so
 * the middleware's already-built actor is reused), so the row form and the
 * query form cannot drift on who is asking. A route reaches for this one when
 * it reports a TOTAL: see `AuthorizationRepository.listScope`.
 */
export function authorizedListScope<T extends GrantResourceType>(
  req: AuthRequest,
  type: T,
  action: AuthorizationAction,
): AuthorizationListScope<T> {
  const actor = req.authorizationActor ?? actorFromRequest(req);
  return authorizationRepository.listScope(actor, type, action);
}

/** Vocabulary5.3: park and Service reassignment are bounded Shepherd acts.
 * This classifies only the payload shape. Authority still uses the canonical
 * point predicate, and execution descriptor/invoke checks stay in the writer. */
export function isShepherdTaskPatch(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.getPrototypeOf(body) !== Object.prototype) return false;
  const row = body as Record<string, unknown>; const keys = Object.keys(row);
  if (keys.length === 1 && keys[0] === 'autoStart') return row.autoStart === false;
  return keys.includes('executionProfile') && keys.every(key => ['executionProfile', 'executionWarrantId'].includes(key))
    && row.executionProfile !== null && typeof row.executionProfile === 'object' && !Array.isArray(row.executionProfile);
}
export function pointAuthorizationTarget(method: string, mountedPath: string, body?: unknown): PointAuthorizationTarget | null {
  const segments = mountedPath.split('?')[0].replace(/\/{2,}/g, '/').split('/').filter(Boolean);
  // Express routes with `caseSensitive:false` and `strict:false`, so
  // `/tasks/x/access`, `/tasks/x/ACCESS` and `/TASKS/x/access/` all reach the
  // SAME handler. `scopeMap.normalizePathForScope` folds the spelling for
  // exactly this reason (scopeMap.ts:155-167) — the ROUTE stage has been
  // immune since A12. The OBJECT stage never was, and that asymmetry was a
  // hole, not a nicety (review 66281121 finding 2): `/TASKS/x` matched no
  // family and got NO object authorization at all, and `/tasks/x/ACCESS`
  // classified as the generic `write` instead of the `admin` the canonical
  // spelling requires — so a Task-write authority reached a policy surface
  // that demands Task-admin authority.
  //
  // Only the ROUTE WORDS fold, and the identifier VALUE never does: a Project
  // or Skill is addressable by name and a name is caller data, so the string
  // handed to `resolve` keeps its original case.
  //
  // The COLLECTION-WORD test folds as well (review cf04a642 finding 1). It is
  // the same question — "is this segment a fixed route word?" — and leaving it
  // case-sensitive left `/tasks/FILTER-OPTIONS` classified as a Task id while
  // `/tasks/filter-options` was correctly recognised as a collection. The
  // residual cost is stated rather than hidden: an object whose NAME equals a
  // collection word (a Project literally called `Stats`) gets no point stage,
  // at EVERY spelling — which is exactly what it already got at the canonical
  // lowercase one. `NON_OBJECT_SEGMENTS` being one flat list across families
  // is that pre-existing namespace hazard; making it family-aware is a
  // separate card, not a spelling repair.
  const routeWords = segments.map((segment) => segment.toLowerCase());
  const type = POINT_RESOURCE_ROUTE_TYPES[routeWords[0]];
  if (!type) return null;

  let identifierIndex = 1;
  if (routeWords[0] === 'tasks' && (routeWords[1] === 'reviewer' || routeWords[1] === 'orchestration')) {
    identifierIndex = 2;
  }
  const identifier = segments[identifierIndex];
  if (!identifier || NON_OBJECT_SEGMENTS.has(routeWords[identifierIndex])) return null;

  const upperMethod = method.toUpperCase();
  const tail = routeWords.slice(2);
  let action: AuthorizationAction;
  if (upperMethod === 'GET') action = 'read';
  else if (upperMethod === 'DELETE') action = 'admin';
  else if (tail.includes('prompt') || tail.includes('brief')) action = 'read';
  else if (routeWords.includes('reviewer') || tail.includes('approve') || tail.includes('reject')) action = 'verify';
  else if (tail.includes('roles')) action = 'shepherd';
  else if (tail.includes('access')) action = 'admin';
  else if (tail.includes('claim')) action = 'claim';
  // RH-P3.C3: `finish` was declared in AuthorizationService — claimant arm,
  // `write`-verb grant mapping, the lot — and no branch here ever produced
  // it, so POST /tasks/{id}/finish classified as generic `write` and the
  // shared predicate never evaluated the act it has a name for. The gap
  // mattered: `write` is refused for the Verifier arm too, so the route
  // ceiling happened to hold, but only by accident of the fallthrough, and
  // any future widening of `write` would have silently widened finishing.
  // Strategy 4e40f06f §2.6.4 (lifecycle moves belong to the claimant) via
  // Phase 2's no-route-bypasses-the-predicate rule.
  else if (tail.includes('finish')) action = 'finish';
  // RH-P3.C3: one-click meltdown recovery is the shepherd's single
  // operation (§2.6.4, RATIFIED 2026-08-02 — C4): force-release + reassign,
  // seeded from the last good report. It is shepherd authority, not the
  // claimant's `release`, so it classifies as `shepherd` — the same action
  // the role-assignment surface uses.
  else if (tail.includes('recover')) action = 'shepherd';
  else if (tail.includes('release')) action = 'release';
  else action = 'write';
  return { type, identifier: decodeURIComponent(identifier), action,
    ...(type === 'task' && upperMethod === 'PATCH' && segments.length === 2 && isShepherdTaskPatch(body)
      ? { alternativeAction: 'shepherd' as const } : {}) };
}


/**
 * ── THE THIRD STAGE: the Access-surface arm (SETGOV) ────────────────────────
 *
 * Design `7a9317b2` v3.3 §3.3; AUTHZ amendment **AZ-A5** (`4d961e37`) clauses
 * 2-5; acceptance annex `85a2218d` D6, D10, D15, D16, D17, D21.
 *
 * It runs INSIDE the route-ceiling stage, strictly AFTER that stage has
 * refused, and in this order and no other:
 *
 *   1. the existing route decision                       (already run, refused)
 *   2. `required !== 'root'`               -> refuse, unchanged  (D16, T5)
 *   3. resolve at most ONE Access surface                        (D15)
 *   4. non-`governable`                    -> refuse, unchanged  (I2, I3, D10)
 *   5. `origin === 'core'` + not a login session -> refuse       (I6, D17)
 *   6. the arm yields none | use | configure
 *   7. the family test, and the refusal shape
 *
 * Step 2 is why an Access bundle can never buy a scope: control returns before
 * resolution is even attempted for any scope-gated family, so the class of
 * defect where an access level silently confers `tasks:admin` is
 * UNREPRESENTABLE rather than refused (annex D16 is the runtime control).
 */

/** The invocation record now belongs to the ARM, which emits it at the position
 * the clauses put it (round-1 review P4). Re-exported here so every existing
 * consumer of the prefix keeps its import and D16 keeps one spelling. */
export { SURFACE_ARM_TRACE_PREFIX } from '../services/AccessSurfaceService';

async function recordSurfaceRefusal(
  req: AuthRequest,
  surfaceKey: string,
  level: AccessLevel,
  refusal: string,
  family: 'read' | 'write' | null,
): Promise<void> {
  // Design §3.6: every refusal on a governable family is auditable with the
  // surface key and the COMPUTED LEVEL. `<object>.refused` is the ledger's
  // established denial spelling (`legacy.refused` in GrantService,
  // `${surface}.refused` in routes/warrants.ts) under 087's free-form CHECK, so
  // no schema change and no new convention.
  await auditService.record({
    action: 'surface.refused',
    actor: auditActorFromRequest(req),
    outcome: 'denied',
    resourceType: 'route',
    resourceId: null,
    metadata: {
      surfaceKey,
      accessLevel: level,
      family,
      refusal,
      method: req.method,
      path: normalizePathForScope(`${req.baseUrl || ''}${req.path}`),
    },
    // A ledger that is down must not turn a REFUSAL into a 500 — the caller is
    // refused either way, which is the safe direction. But it must not be
    // SILENT: round 1 of this candidate's review showed that a swallowed write
    // leaves §3.6's audit assertion measuring rows that happen to exist rather
    // than the refusals that happened (regression `e776b244`), and the same
    // swallow had already hidden a CHECK violation on the sibling act.
  }).catch((error) => logCaughtFailure('[SurfaceArm] refusal audit not written:', error));
}

/**
 * Returns true when the request may continue to the point stage. When it
 * returns false the response has already been sent.
 */
export async function evaluateSurfaceStage(
  req: AuthRequest,
  res: Response,
  mountedPath: string,
  required: ReturnType<typeof requiredScopeFor>,
): Promise<boolean> {
  const refuseUnchanged = (): boolean => {
    sendApiError(res, 403, 'FORBIDDEN', 'This identity is not authorized for the requested operation');
    return false;
  };

  // 2. The arm is NEVER consulted for a scope-gated route.
  if (required !== ROOT_SCOPE) return refuseUnchanged();

  const surfaces = await accessSurfaceService.listSurfaces();
  const surface = accessSurfaceService.resolveSurface(surfaces, mountedPath);

  // 3/4. No surface, or a `locked` / `always-self` surface: the arm is not
  //      consulted and the ratified gate decides, exactly as it does today.
  if (!surface || surface.governance !== 'governable') return refuseUnchanged();

  // 4b/5/6/7 are `accessSurfaceService.armDecision` (card `d0f030a9`): the
  // Settings shell asks the SAME function whether to render a navigation
  // entry, so the gate and the menu cannot come to disagree about what a
  // session may reach. The clause ORDER is unchanged and lives there; this
  // stage keeps what is its own — the audit write and the response shape.
  const family = accessSurfaceService.familyClassFor(surface, req.method, mountedPath);
  const decision = await accessSurfaceService.armDecision(
    { principalId: req.principal?.id ?? null, authMethod: req.authMethod },
    surface,
    family,
    undefined,
    // The mounted path is what the invocation record names, and passing it is
    // what marks this call a REQUEST rather than a menu question (P4).
    mountedPath,
  );

  if (decision.admitted) return true;

  switch (decision.refusal) {
    // 4b. The audited denial that names the surface and the arm. Written
    //     BEFORE the level is computed, so a row naming an authority-mutation
    //     surface confers nothing however it got into the store.
    case 'AUTHORITY_MUTATION_SURFACE':
    // 5. The authentication-kind refusal (I6), audited on the same shape.
    case 'AUTHENTICATION_KIND':
      await recordSurfaceRefusal(req, surface.key, decision.level, decision.refusal, null);
      return refuseUnchanged();

    // 3/4 and 6: the arm was not consulted, or the path is on no declared
    //     family. The ratified gate's own refusal, unaudited by this stage
    //     exactly as before — nothing about the surface was decided.
    case 'NOT_GOVERNABLE':
    case 'FAMILY_UNDECLARED':
      return refuseUnchanged();

    // 7. 404 on a read family — the 44d1bf89 concealment pattern (§9.6), so a
    //    Group at `none` cannot map a deployment by probing.
    case 'SURFACE_CONCEALED':
      await recordSurfaceRefusal(req, surface.key, decision.level, 'SURFACE_CONCEALED', family);
      sendApiError(res, 404, 'RESOURCE_NOT_FOUND', 'Resource not found');
      return false;

    // 7. 403 NAMING THE SURFACE on a write family of a surface the caller may
    //    read, because concealment there presents as a broken save.
    case 'SURFACE_LEVEL_INSUFFICIENT':
      await recordSurfaceRefusal(req, surface.key, decision.level, 'SURFACE_LEVEL_INSUFFICIENT', family);
      sendApiError(
        res,
        403,
        'SURFACE_LEVEL_INSUFFICIENT',
        `Changing '${surface.label}' requires the access level configure on that Access surface; this identity holds ${decision.level}`,
      );
      return false;
  }

  // `refusal` is exhausted above and `admitted` returned before it. A verdict
  // this stage cannot read is a refusal, never a fallthrough into the handler.
  return refuseUnchanged();
}

export async function sharedAuthorizationMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const mountedPath = `${req.baseUrl || ''}${req.path}`;
  const required = requiredScopeFor(req.method, mountedPath);
  const decision = authorizationService.authorizeRoute(actorFromRequest(req), required);
  if (!decision.allowed) {
    // The route stage has refused. The Access-surface arm is the ONLY thing
    // that may still admit the request, and only by substituting for the
    // `root` sentinel on a governable surface's declared families.
    try {
      if (!await evaluateSurfaceStage(req, res, mountedPath, required)) return;
    } catch {
      sendApiError(res, 503, 'AUTHORIZATION_UNAVAILABLE', 'Authorization could not be evaluated');
      return;
    }
  }
  const actor = actorFromRequest(req);
  req.authorizationActor = actor;

  const target = pointAuthorizationTarget(req.method, mountedPath, req.body);
  if (!target) {
    next();
    return;
  }
  try {
    let point = await authorizationRepository.authorizePoint(
      actor,
      target.type,
      target.identifier,
      target.action,
    );
    if (!point.allowed && target.alternativeAction) {
      point = await authorizationRepository.authorizePoint(actor, target.type, target.identifier, target.alternativeAction);
    }
    // Card f9b7febe. ABSENT and UNREADABLE are ONE answer, on every verb.
    // This branch used to read `target.action === 'read'` instead of the
    // repository's `concealed`, which made the concealment a property of the
    // VERB rather than of what the caller can see: `GET /tasks/:id` answered
    // 404 for a Task the caller may not read, `PATCH /tasks/:id` answered 403
    // for the same Task, and the difference confirmed the id. The 403 below
    // survives for the case it is actually for - a caller who CAN read the
    // resource and lacks authority for THIS act - because concealing that one
    // presents as a broken save and discloses nothing.
    if (!point.exists || point.concealed) {
      sendApiError(res, 404, 'RESOURCE_NOT_FOUND', 'Resource not found');
      return;
    }
    if (!point.allowed) {
      sendApiError(res, 403, 'FORBIDDEN', 'This identity is not authorized for the requested resource');
      return;
    }
    next();
  } catch {
    sendApiError(res, 503, 'AUTHORIZATION_UNAVAILABLE', 'Authorization could not be evaluated');
  }
}
