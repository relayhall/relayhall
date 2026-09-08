import { RequiredScope, scopesSatisfy } from '../utils/scopeMap';
import { accessProfileService, renderAuthoritySeam, type SelectorForm } from './AccessProfileService';
import { grantService } from './GrantService';
import type { GrantResourceType, GrantVerb } from './GrantService';

export type AuthorizationAction =
  | 'read'
  | 'write'
  | 'admin'
  | 'use'
  | 'invoke'
  | 'claim'
  | 'finish'
  | 'release'
  | 'shepherd'
  | 'verify';

export interface AuthorizationActor {
  principalId: string | null;
  handle: string;
  role: string | null;
  scopes: string[] | null;
  authenticated: boolean;
  /** AZ-S3 (design 4d961e37 §5): the middleware-resolved delegation chain,
   * acting identity first, ancestors up to the Account. null/absent for
   * Account-plane and legacy identities. Only ever server-populated. */
  delegation?: { links: DelegationActorLink[] } | null;
}

export interface DelegationActorLink {
  principalId: string;
  kind: string;
  /** The link's stored role — carried so the SQL side can honor a
   * root/administrator ACCOUNT as the authority superset it is (§5.1,
   * review 6c7d68d2 B2). Only ever server-populated. */
  role: string | null;
  parentPrincipalId: string | null;
  boundTaskId: string | null;
  legacyIdentity: boolean;
  ownExpression: {
    scopes: 'parent' | string[];
    objects: 'parent' | Array<{
      resourceType: GrantResourceType;
      // The RATIFIED set, read from its one definition. It was spelled out
      // here as three literals until RH-AZ.PROJ-b: own() expressions are
      // validated by `validateRules`, the SAME validator the profile store
      // uses, so a form added there is admissible HERE the moment it lands —
      // and a hand-copied union cannot notice.
      selectorForm: SelectorForm;
      selectorIds: string[];
      verbs: GrantVerb[];
    }>;
  } | null;
}

export interface AuthorizationGrant {
  resourceType: GrantResourceType;
  resourceId: string | null;
  verb: GrantVerb;
  expiresAt?: string | null;
}

export type AuthorizationVisibility = 'private' | 'shared' | 'public' | 'default';

export interface AuthorizationResource {
  type: GrantResourceType;
  id: string;
  ownerPrincipalId?: string | null;
  creatorPrincipalId?: string | null;
  spawnedByPrincipalId?: string | null;
  visibility?: AuthorizationVisibility | null;
  inheritedVisibility?: AuthorizationVisibility | null;
  /** Server-derived Task.project_id only when that Project exists and is active.
   * This supplies exact-Project Grant inheritance, never Phase-derived ownership. */
  inheritedProjectId?: string | null;
  claimantPrincipalId?: string | null;
  shepherdPrincipalId?: string | null;
  verifierPrincipalId?: string | null;
  /** Explicit owner-plane exception: TRUE suppresses inherited visibility and
   * the Task's exact-Project Grant arm (0e6f09a0). It never touches
   * the resource's OWN `visibility`, which is an explicit act by its owner.
   * Grants never toggle this implicitly. */
  restrictedAccess?: boolean;
}

export type AuthorizationBasis =
  | 'route'
  | 'root'
  | 'administrator'
  | 'owner'
  | 'claimant'
  | 'shepherd'
  | 'verifier'
  | 'initiator'
  | 'exact-grant'
  | 'wildcard-grant'
  | 'inherited-project-grant'
  | 'visibility';

export interface AuthorizationDecision {
  allowed: boolean;
  basis?: AuthorizationBasis;
  denial?: 'UNAUTHENTICATED' | 'SCOPE_CEILING' | 'ROLE_CEILING' | 'NO_AUTHORITY';
}

const ADMINISTRATOR_ROLES = new Set(['admin', 'operator', 'orchestrator']);
const WRITE_ROLES = new Set(['editor', 'user', 'agent', 'service', 'qa', 'reviewer']);

type Ceiling = 1 | 2 | 3;

function roleCeiling(role: string | null): Ceiling {
  const normalized = String(role || '').trim().toLowerCase();
  if (ADMINISTRATOR_ROLES.has(normalized)) return 3;
  if (WRITE_ROLES.has(normalized)) return 2;
  return 1;
}

/** The acting ceiling for an actor, §5.2-aware (review ab857740 B2): a
 * NON-legacy delegated CONNECTOR reaches ceiling 3 so that per-object
 * `*:admin` scopes — explicitly delegable to Connectors under rule 3 —
 * are exercisable; the root/administrator/owner arms stay unreachable for
 * every parented identity regardless (the chain branch never takes them).
 * Agents cap at the write ceiling: `*:admin` never reaches their layer. */
function actingCeiling(actor: AuthorizationActor): Ceiling {
  const chain = actor.delegation?.links;
  if (chain && chain.length > 1 && !chain[0].legacyIdentity) {
    return chain[0].kind === 'agent' ? 2 : 3;
  }
  return roleCeiling(actor.role);
}

function actionCeiling(action: AuthorizationAction): Ceiling {
  if (action === 'admin') return 3;
  if (action === 'read') return 1;
  return 2;
}

function requiredScopeCeiling(requiredScope: RequiredScope): Ceiling {
  if (requiredScope === 'authenticated') return 1;
  if (requiredScope === 'root' || requiredScope.endsWith(':admin')) return 3;
  if (requiredScope.endsWith(':read')) return 1;
  return 2;
}

export function grantAllows(verb: GrantVerb, action: AuthorizationAction): boolean {
  if (verb === 'admin') return true;
  if (verb === 'read') return action === 'read';
  if (verb === 'write') {
    return action === 'read' || action === 'write' || action === 'claim' || action === 'finish' || action === 'release';
  }
  return verb === action;
}

/** Owner contract 0e6f09a0: a Project admin Grant supplies only the ordinary
 * Task write subset. Reuse the canonical mapping, including its workflow acts;
 * no admin, Shepherd, Verifier, use or invoke authority crosses this boundary. */
function inheritedProjectGrantAllows(verb: GrantVerb, action: AuthorizationAction): boolean {
  return (verb === 'read' || verb === 'write' || verb === 'admin')
    && grantAllows('write', action)
    && grantAllows(verb === 'admin' ? 'write' : verb, action);
}

export interface AuthorizationSqlResource {
  type: GrantResourceType;
  id: string;
  owner?: string;
  creator?: string;
  spawnedBy?: string;
  visibility?: string;
  inheritedVisibility?: string;
  claimant?: string;
  shepherd?: string;
  verifier?: string;
  /**
   * The PROJECT coordinate of this resource shape, for the project-bounded
   * selector form (`all-in-project`, RH-AZ.PROJ-b).
   *
   * ABSENT is the fail-closed default and carries meaning: a shape that
   * declares no project column renders the project-bounded arm as the literal
   * `FALSE`, so no `all-in-project` rule can decide anything for that type
   * however the row got written. A shape must therefore declare this column
   * only when `SELECTOR_FORM_ADMISSIBILITY` admits the form for its type —
   * the two are cross-checked as one fact rather than asserted twice.
   */
  project?: string;
  /** Boolean EXPRESSION (not necessarily a bare column) that suppresses the
   * inherited-visibility and exact-Project Grant arms. A Task composes its own opt-out with its
   * Phase's, so the expression form is the general one. */
  restrictedAccess?: string;
  /** Boolean EXPRESSION that must hold for the inherited arm to apply at all:
   * the ancestor-exists conjunct. Absent means "always anchored". It exists so
   * an ORPHAN row fails closed as a STATED property of the predicate rather
   * than as an emergent consequence of NULL comparison. */
  inheritanceAnchor?: string;
}

export interface AuthorizationSqlDecision {
  sql: string;
  params: unknown[];
}

function equality(column: string | undefined, param: string): string | null {
  return column ? `${column} = ${param}` : null;
}

function active(grant: AuthorizationGrant, now: Date): boolean {
  if (!grant.expiresAt) return true;
  const expiry = new Date(grant.expiresAt).getTime();
  return Number.isFinite(expiry) && expiry > now.getTime();
}

function samePrincipal(actor: AuthorizationActor, principalId: string | null | undefined): boolean {
  return Boolean(actor.principalId && principalId && actor.principalId === principalId);
}

function visibleToAuthenticated(value: AuthorizationVisibility | null | undefined): boolean {
  return value === 'public' || value === 'shared' || value === 'default';
}

export class AuthorizationService {
  /** Route-only decision. Object-bearing routes call authorizeResource after
   * this ceiling check; there is deliberately no second route policy. */
  authorizeRoute(actor: AuthorizationActor, requiredScope: RequiredScope): AuthorizationDecision {
    if (!actor.authenticated) return { allowed: false, denial: 'UNAUTHENTICATED' };
    if (actor.scopes?.includes('root')) return { allowed: true, basis: 'root' };
    if (requiredScopeCeiling(requiredScope) > actingCeiling(actor)) {
      return { allowed: false, denial: 'ROLE_CEILING' };
    }
    if (!scopesSatisfy(actor.scopes, requiredScope)) {
      return { allowed: false, denial: 'SCOPE_CEILING' };
    }
    return {
      allowed: true,
      basis: 'route',
    };
  }

  authorizeResource(
    actor: AuthorizationActor,
    action: AuthorizationAction,
    resource: AuthorizationResource,
    grants: AuthorizationGrant[] = [],
    now = new Date(),
  ): AuthorizationDecision {
    if (!actor.authenticated) return { allowed: false, denial: 'UNAUTHENTICATED' };

    const root = actor.scopes?.includes('root') ?? false;
    if (root) return { allowed: true, basis: 'root' };

    const ceiling = actingCeiling(actor);
    if (actionCeiling(action) > ceiling) {
      return { allowed: false, denial: 'ROLE_CEILING' };
    }

    const actingChain = actor.delegation?.links;
    if (actingChain && actingChain.length > 1 && !actingChain[0].legacyIdentity) {
      // §5.1: for parented principals the root/administrator/owner arms
      // never apply and object authority is the SQL-side chain
      // intersection. Only the task-ROLE and initiator arms evaluate on the
      // acting identity alone (AZ-26), under the §8.2 bound-task FINAL
      // write cap (T36) for Agent identities.
      if (actingChain[0].kind === 'agent' && action !== 'read'
        && resource.type === 'task' && resource.id !== actingChain[0].boundTaskId) {
        return { allowed: false, denial: 'NO_AUTHORITY' };
      }
      const roleDecision = this.roleArmDecision(actor, action, resource);
      if (roleDecision) return roleDecision;
      return { allowed: false, denial: 'NO_AUTHORITY' };
    }

    if (ADMINISTRATOR_ROLES.has(String(actor.role || '').toLowerCase())) {
      return { allowed: true, basis: 'administrator' };
    }

    // tasks.owner_principal_id is the claimant identifier (owner-facing label:
    // Assignee), not generic ownership. It therefore receives the bounded
    // Task-role authority below, never the owner/admin arm.
    if (resource.type !== 'task' && samePrincipal(actor, resource.ownerPrincipalId)) {
      return { allowed: true, basis: 'owner' };
    }

    const claimantId = resource.claimantPrincipalId ?? (
      resource.type === 'task' ? resource.ownerPrincipalId : null
    );
    if (samePrincipal(actor, claimantId)) {
      if (['read', 'write', 'claim', 'finish', 'release'].includes(action)) {
        return { allowed: true, basis: 'claimant' };
      }
    }
    if (samePrincipal(actor, resource.shepherdPrincipalId)) {
      if (action === 'read' || action === 'shepherd' || action === 'release') {
        return { allowed: true, basis: 'shepherd' };
      }
    }
    if (samePrincipal(actor, resource.verifierPrincipalId)) {
      if (action === 'read' || action === 'verify') {
        return { allowed: true, basis: 'verifier' };
      }
    }
    // Compatibility window for Tasks created before assignable Verifiers:
    // the legacy verifier-capable identities may judge only while no exact
    // Verifier is assigned. Once the server-written field is set, identity
    // equality above is the sole Verifier arm.
    if (
      resource.type === 'task' &&
      action === 'verify' &&
      !resource.verifierPrincipalId &&
      (actor.role === 'qa' || actor.role === 'reviewer')
    ) {
      return { allowed: true, basis: 'verifier' };
    }

    if (
      action === 'read' &&
      (samePrincipal(actor, resource.creatorPrincipalId) || samePrincipal(actor, resource.spawnedByPrincipalId))
    ) {
      return { allowed: true, basis: 'initiator' };
    }

    const live = grants.filter((grant) => grant.resourceType === resource.type && active(grant, now));
    const exact = live.find((grant) => grant.resourceId === resource.id && grantAllows(grant.verb, action));
    if (exact) return { allowed: true, basis: 'exact-grant' };
    const wildcard = live.find((grant) => grant.resourceId === null && grantAllows(grant.verb, action));
    if (wildcard) return { allowed: true, basis: 'wildcard-grant' };

    if (resource.type === 'task' && resource.inheritedProjectId && !resource.restrictedAccess) {
      const inherited = grants.find((grant) => grant.resourceType === 'project'
        && grant.resourceId === resource.inheritedProjectId && active(grant, now)
        && inheritedProjectGrantAllows(grant.verb, action));
      if (inherited) return { allowed: true, basis: 'inherited-project-grant' };
    }

    if (action === 'read') {
      // Owner ruling 44ee41f2, extended to the Task by run packet 16896595
      // decision 3: read visibility is the UNION of the resource's OWN
      // visibility and the visibility it INHERITS from its live ancestor
      // chain. The two are INDEPENDENT arms, and the rule is expressed on the
      // resource SHAPE, not on its type - a `??` fallback would be dead code
      // for any resource whose own visibility column is NOT NULL (a Task's is).
      // `restrictedAccess` suppresses the inherited arm only. An absent
      // `inheritedVisibility` - an ORPHAN Task, `project_id IS NULL` - inherits
      // nothing and therefore fails closed.
      if (visibleToAuthenticated(resource.visibility)) {
        return { allowed: true, basis: 'visibility' };
      }
      if (!resource.restrictedAccess && visibleToAuthenticated(resource.inheritedVisibility)) {
        return { allowed: true, basis: 'visibility' };
      }
    }

    return { allowed: false, denial: 'NO_AUTHORITY' };
  }

  /** SQL adapter for list/point parity. All expressions are internal schema
   * identifiers supplied by AuthorizationRepository; no caller text is ever
   * interpolated. Grant arms deliberately compose GrantService's P2.5 seam. */
  /** In-memory task-role/initiator arms shared by the Account fast path and
   * the delegated-actor path (AZ-26: these evaluate on the ACTING identity
   * alone, gated by chain liveness which the middleware enforces). */
  private roleArmDecision(
    actor: AuthorizationActor,
    action: AuthorizationAction,
    resource: AuthorizationResource,
  ): AuthorizationDecision | null {
    if (!actor.principalId) return null;
    if (resource.type === 'task') {
      if (['read', 'write', 'claim', 'finish', 'release'].includes(action)
        && (resource.claimantPrincipalId ?? resource.ownerPrincipalId) === actor.principalId) {
        return { allowed: true, basis: 'claimant' };
      }
      if ((action === 'read' || action === 'shepherd' || action === 'release')
        && resource.shepherdPrincipalId === actor.principalId) {
        return { allowed: true, basis: 'shepherd' };
      }
      if ((action === 'read' || action === 'verify')
        && resource.verifierPrincipalId === actor.principalId) {
        return { allowed: true, basis: 'verifier' };
      }
    }
    if (action === 'read'
      && (resource.creatorPrincipalId === actor.principalId
        || resource.spawnedByPrincipalId === actor.principalId)) {
      return { allowed: true, basis: 'initiator' };
    }
    return null;
  }

  /** The read-visibility UNION as SQL, shared by BOTH SQL planes so the
   * account/legacy arm and the delegation-chain account arm cannot drift from
   * each other or from the point evaluator above (run packet 16896595 §2.3:
   * the same rule expressed three times is one class, not three coordinates).
   * Own visibility and inherited visibility are independent arms;
   * `restrictedAccess` gates only the inherited one; `inheritanceAnchor` is
   * the ancestor-exists conjunct that makes an orphan fail closed. */
  private visibilityArms(resource: AuthorizationSqlResource): string[] {
    const arms: string[] = [];
    if (resource.visibility) {
      arms.push(`${resource.visibility} IN ('public', 'shared', 'default')`);
    }
    if (resource.inheritedVisibility) {
      const inheritanceEnabled = resource.restrictedAccess ? `NOT (${resource.restrictedAccess})` : 'TRUE';
      const anchor = resource.inheritanceAnchor ? `(${resource.inheritanceAnchor}) AND ` : '';
      arms.push(`(${anchor}${inheritanceEnabled} AND ${resource.inheritedVisibility} IN ('public', 'shared', 'default'))`);
    }
    return arms;
  }

  /**
   * `options.withoutAdministratorArm` suppresses the fourth short-circuit
   * below -- the one that returns unconditional TRUE for a NON-DELEGATED
   * `admin`, `operator` or `orchestrator`.
   *
   * It exists for ONE caller: `AuthorizationRepository.selectorCoveredIds`,
   * which answers "does a SELECTOR of this caller's reach this row" for
   * vocabulary amendment A21's `knowledge-contents:read`. A21 is ratified as
   * "always evaluated against an object selector ... never a flat estate-wide
   * grant", and an arm that returns TRUE for a whole role IS a flat
   * estate-wide grant. Owner ruling `623632b0` option (a) settled it: the
   * selector is enforced for every NON-ROOT caller, administrators included.
   *
   * It is opt-IN and defaults to the shipped behaviour, so every other caller
   * of this predicate is byte-identical to before. `root` keeps its A12.1
   * sentinel arm above -- suppressing a role arm is not the same as
   * suppressing the global sentinel.
   */
  sqlCondition(
    actor: AuthorizationActor,
    action: AuthorizationAction,
    resource: AuthorizationSqlResource,
    paramOffset = 1,
    options: { withoutAdministratorArm?: boolean } = {},
  ): AuthorizationSqlDecision {
    if (!actor.authenticated) return { sql: 'FALSE', params: [] };
    if (actor.scopes?.includes('root')) return { sql: 'TRUE', params: [] };
    if (actionCeiling(action) > actingCeiling(actor)) return { sql: 'FALSE', params: [] };

    const chain = actor.delegation?.links && actor.delegation.links.length > 1
      && !actor.delegation.links[0].legacyIdentity ? actor.delegation.links : null;

    if (!options.withoutAdministratorArm
      && !chain && ADMINISTRATOR_ROLES.has(String(actor.role || '').toLowerCase())) {
      return { sql: 'TRUE', params: [] };
    }

    const params: unknown[] = [];
    const nextParam = (value: unknown): string => {
      params.push(value);
      return `$${paramOffset + params.length - 1}`;
    };
    // The acting-principal parameter binds LAZILY: an action whose arms
    // never reference it (e.g. admin) must not leave an unused  gap —
    // PostgreSQL refuses statements with unreferenced parameters.
    let principalParamMemo: string | null = null;
    const principalParam = (): string | null => {
      if (!actor.principalId) return null;
      if (!principalParamMemo) principalParamMemo = nextParam(actor.principalId);
      return principalParamMemo;
    };
    /**
     * `equality`, but the parameter is bound ONLY when the column exists.
     *
     * `equality` returns null for an absent column — by which time an eager
     * `nextParam` has already pushed, leaving the statement carrying a
     * placeholder nothing references. PostgreSQL refuses that outright:
     * 42P18, "could not determine data type of parameter $n". Binding inside
     * the guard makes the pair inseparable, so the hazard cannot be
     * reintroduced by adding another optional column (card dae6b980).
     */
    const equalityLazy = (column: string | undefined, value: unknown): string | null =>
      (column ? equality(column, nextParam(value)) : null);

    const arms: string[] = [];
    const addPrincipalArm = (column: string | undefined): void => {
      if (!column || !actor.principalId) return;
      const param = principalParam();
      const arm = param ? equality(column, param) : null;
      if (arm) arms.push(arm);
    };

    // Task-ROLE and initiator arms: the ACTING identity alone (AZ-26).
    if (resource.type === 'task' && actor.principalId) {
      if (['read', 'write', 'claim', 'finish', 'release'].includes(action)) {
        const column = resource.claimant ?? resource.owner;
        if (column) {
          const claimant = equality(column, principalParam()!);
          if (claimant) arms.push(claimant);
        }
      }
      if (action === 'read' || action === 'shepherd' || action === 'release') {
        if (resource.shepherd) {
          const shepherd = equality(resource.shepherd, principalParam()!);
          if (shepherd) arms.push(shepherd);
        }
      }
      if (action === 'read' || action === 'verify') {
        if (resource.verifier) {
          const verifier = equality(resource.verifier, principalParam()!);
          if (verifier) arms.push(verifier);
        }
      }
      if (
        action === 'verify' &&
        resource.verifier &&
        (actor.role === 'qa' || actor.role === 'reviewer')
      ) {
        arms.push(`${resource.verifier} IS NULL`);
      }
    }
    if (action === 'read' && actor.principalId) {
      for (const column of [resource.creator, resource.spawnedBy]) {
        if (!column) continue;
        const initiator = equality(column, principalParam()!);
        if (initiator) arms.push(initiator);
      }
    }

    // §8.2 (RH-P3.AZ-S5, AZ-19): READ authority for a minted Agent DEFAULTS
    // to its TASK CONTEXT — the bound Task, its Phase and its Project.
    // Like the task-role arms this evaluates on the ACTING identity alone
    // (AZ-26), gated by the middleware chain liveness; anything beyond the
    // context needs an explicit ceiling grant through own()/sources (T22:
    // off-context reads keep refusing; broad read is an explicit act,
    // never a side effect of warrant breadth).
    {
      const actingLink = actor.delegation?.links?.[0];
      if (action === 'read' && actingLink?.kind === 'agent'
        && actingLink.boundTaskId && !actingLink.legacyIdentity) {
        if (resource.type === 'task') {
          arms.push(`${resource.id} = ${nextParam(actingLink.boundTaskId)}`);
        } else if (resource.type === 'phase') {
          arms.push(`${resource.id} IN (SELECT ctx.phase_id FROM tasks ctx WHERE ctx.id = ${nextParam(actingLink.boundTaskId)} AND ctx.phase_id IS NOT NULL)`);
        } else if (resource.type === 'project') {
          arms.push(`${resource.id} IN (SELECT ctx.project_id FROM tasks ctx WHERE ctx.id = ${nextParam(actingLink.boundTaskId)} AND ctx.project_id IS NOT NULL)`);
        }
      }
    }

    // Object-authority core for ONE principal id: the wildcard-grant and
    // profile seams (AZ-S1/AZ-S2), verb-for-verb.
    const authorityCore = (principalId: string): string[] => {
      const parts: string[] = [];
      for (const verb of ['read', 'write', 'use', 'invoke', 'admin'] as GrantVerb[]) {
        if (!grantAllows(verb, action)) continue;
        const seam = grantService.activeGrantCondition(paramOffset + params.length);
        parts.push(renderAuthoritySeam(seam.sql, resource.id, resource.project));
        params.push(...seam.bind(principalId, resource.type, verb));
        const profileSeam = accessProfileService.activeProfileCondition(paramOffset + params.length);
        parts.push(renderAuthoritySeam(profileSeam.sql, resource.id, resource.project));
        params.push(...profileSeam.bind(principalId, resource.type, verb));
      }
      // 0e6f09a0: exact live Project Grants only, inside this SAME per-principal
      // core so the delegation intersection and final Agent bound-Task cap
      // remain outside the new source. No Project Profile or ownership arm.
      // Missing shape metadata fails closed; Phase shapes acquire no new arm.
      if (resource.type === 'task' && resource.project
        && resource.inheritanceAnchor && resource.restrictedAccess) {
        for (const verb of ['read', 'write', 'admin'] as GrantVerb[]) {
          if (!inheritedProjectGrantAllows(verb, action)) continue;
          const seam = grantService.activeGrantCondition(paramOffset + params.length, { exactOnly: true });
          parts.push(`((${resource.inheritanceAnchor}) AND NOT (${resource.restrictedAccess})`
            + ` AND ${renderAuthoritySeam(seam.sql, resource.project)})`);
          params.push(...seam.bind(principalId, 'project', verb));
        }
      }
      return parts;
    };

    if (!chain) {
      // Account / legacy plane: the pre-S3 arms, unchanged in meaning.
      if (resource.type !== 'task') addPrincipalArm(resource.owner);
      if (actor.principalId) arms.push(...authorityCore(actor.principalId));
      if (action === 'read') {
        arms.push(...this.visibilityArms(resource));
      }
      return { sql: arms.length > 0 ? `(${arms.join(' OR ')})` : 'FALSE', params };
    }

    // ── The delegation chain intersection (AZ-S3, §5.1/AZ-26) ──────────
    // effective(acting) = own(acting) ∩ own(intermediate)… ∩
    // authority(Account), each side live. A NON-legacy delegated link with
    // no own_expression contributes FALSE — inheritance is never implicit
    // (AZ-24). The own-rule selector shapes mirror the profile rules.
    const ownRuleSql = (rules: Array<{
      resourceType: GrantResourceType;
      // The ratified set, read from its one definition (RH-AZ.PROJ-b). This
      // was a hand-copied three-literal union; `validateRules` has admitted
      // four forms since card 95572530 and a copy cannot notice.
      selectorForm: SelectorForm;
      selectorIds: string[];
      verbs: GrantVerb[];
    }>): string[] => {
      const parts: string[] = [];
      for (const rule of rules) {
        if (rule.resourceType !== resource.type) continue;
        const verbMatches = rule.verbs.some((verb) => grantAllows(verb, action));
        if (!verbMatches) continue;
        // EXHAUSTIVE, AND THE DEFAULT ADMITS NOTHING (RH-AZ.PROJ-b).
        //
        // This was three branches with `all-except` as the trailing `else`.
        // own() expressions are validated by `validateRules`, so the day a
        // fourth form was added to `SELECTOR_FORMS` that `else` would have read
        // `all-in-project` — a rule pinned to ONE project — as "everything
        // EXCEPT those ids", inverting a narrowing into the broadest arm the
        // cap can express. own() is the principal-level NARROWING tool; a form
        // it does not recognise must contribute nothing, which is what an arm
        // absent from the OR-list means.
        if (rule.selectorForm === 'all-of-type') {
          parts.push('TRUE');
        } else if (rule.selectorForm === 'exact') {
          parts.push(`${resource.id} = ANY(${nextParam(rule.selectorIds)}::uuid[])`);
        } else if (rule.selectorForm === 'all-except') {
          parts.push(`NOT (${resource.id} = ANY(${nextParam(rule.selectorIds)}::uuid[]))`);
        } else if (rule.selectorForm === 'all-in-project') {
          // Same shape as the seam's arm, on the same coordinate: absent, the
          // rule admits nothing rather than everything.
          if (resource.project) {
            parts.push(`(${resource.project} IS NOT NULL AND ${resource.project} = ANY(${nextParam(rule.selectorIds)}::uuid[]))`);
          }
        }
      }
      return parts;
    };

    const sides: string[] = [];
    for (let index = 0; index < chain.length; index += 1) {
      const link = chain[index];
      const isAccount = !link.parentPrincipalId;
      if (isAccount) {
        // §5.1 (review 6c7d68d2 B2): effective(parent) for a
        // root/administrator Account is BOARD-WIDE object authority — the
        // Account side is the superset TRUE, while root itself remains
        // non-delegable (the child's scopes were already stripped) and the
        // owner-plane route gates still bind every mutation surface.
        if (ADMINISTRATOR_ROLES.has(String(link.role || '').toLowerCase())) {
          sides.push('TRUE');
          continue;
        }
        const accountParts: string[] = [];
        // §5.1/AZ-26 (review e5e437a0 B3): Task-ROLE authority
        // (claimant/shepherd/verifier/initiator) evaluates on the ACTING
        // identity alone and NEVER inherits down the chain. For tasks the
        // 'owner' column IS the claimant field, so the Account owner arm is
        // omitted entirely — no parameter is bound for it (an unreferenced
        // placeholder would break the prepared statement) — and a delegated
        // child must reach a task through an independent Account
        // object-authority source (grant/profile), not because its ancestor
        // claims it.
        // The capability-plane resources (skill, personality, service)
        // declare no owner column at all, so this arm must bind nothing for
        // them either — the same reason the task case is excluded above.
        if (resource.type !== 'task') {
          const ownerArm = equalityLazy(resource.owner, link.principalId);
          if (ownerArm) accountParts.push(ownerArm);
        }
        accountParts.push(...authorityCore(link.principalId));
        if (action === 'read') {
          accountParts.push(...this.visibilityArms(resource));
        }
        sides.push(accountParts.length > 0 ? `(${accountParts.join(' OR ')})` : 'FALSE');
      } else {
        // §5.1 (review 731415a7 B1): the stored own() expression is THE
        // principal-level narrowing tool — a FINAL AND-CAP over every
        // delegated object-authority source. Direct/group grants and
        // Access profiles on the delegated identity are sources INSIDE the
        // cap: they can never authorize an object the owner's own()
        // selector excludes, and the parent-side intersection still binds
        // everything.
        const own = link.ownExpression;
        if (!own) {
          sides.push('FALSE');
          continue;
        }
        let capSql: string;
        if (own.objects === 'parent') {
          capSql = 'TRUE';
        } else {
          const capParts = ownRuleSql(own.objects);
          capSql = capParts.length > 0 ? `(${capParts.join(' OR ')})` : 'FALSE';
        }
        const sourceParts: string[] = [capSql, ...authorityCore(link.principalId)];
        sides.push(`(${capSql} AND (${sourceParts.join(' OR ')}))`);
      }
    }
    arms.push(`(${sides.join(' AND ')})`);

    let sql = arms.length > 0 ? `(${arms.join(' OR ')})` : 'FALSE';

    // §8.2 bound-task FINAL write cap (T36, sol B5): an Agent's write-class
    // authority NEVER leaves its bound task — role arms included.
    if (chain[0].kind === 'agent' && action !== 'read' && resource.type === 'task') {
      if (!chain[0].boundTaskId) return { sql: 'FALSE', params: [] };
      const bound = nextParam(chain[0].boundTaskId);
      sql = `(${sql} AND ${resource.id} = ${bound})`;
    }

    return { sql, params };
  }
}

export const authorizationService = new AuthorizationService();
