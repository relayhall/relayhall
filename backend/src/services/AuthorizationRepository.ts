import { pool } from '../db/connection';
import {
  AuthorizationAction,
  AuthorizationActor,
  AuthorizationResource,
  AuthorizationSqlDecision,
  AuthorizationSqlResource,
  authorizationService,
} from './AuthorizationService';
import type { GrantResourceType } from './GrantService';

/**
 * The list-query form of the point predicate: the FROM a query must read
 * through, and the WHERE conjunct it must carry.
 *
 * The type parameter is not decoration. A caller composes this FROM with its
 * own SELECT list and its own filter conditions, and those are written against
 * ONE resource shape; handing a Task board a Report scope would compile into
 * SQL whose column references resolve somewhere else entirely.
 * `AuthorizationListScope<'task'>` makes that a compile error instead.
 */
export interface AuthorizationListScope<T extends GrantResourceType = GrantResourceType> {
  type: T;
  /** The FROM clause the predicate's column references resolve against. */
  from: string;
  /**
   * The id COLUMN EXPRESSION inside that FROM (`t.id`, `r.id`, …).
   *
   * A caller that narrows a table which is not the resource table itself —
   * `task_history` rows, whose authority is the Task they belong to — needs to
   * SELECT the authorized ids as a set. Hand-writing `t.id` there would be a
   * second copy of `sqlResource`'s shape, and a copy cannot notice the shape
   * changing; card 08f42f36 is the type case for what a copy costs. So the
   * coordinate travels with the FROM it belongs to.
   */
  id: string;
  /** The predicate, rendered with placeholders starting at `paramOffset`. */
  render(paramOffset: number): AuthorizationSqlDecision;
}

interface PointDecision {
  exists: boolean;
  allowed: boolean;
  /**
   * Whether this caller must be answered as though the resource were ABSENT
   * (card `f9b7febe`).
   *
   * It is a THIRD fact because `exists` and `allowed` cannot express it
   * between them: a caller refused a WRITE may be refused because it cannot
   * write (and already knows the object exists, having read it) or because it
   * cannot see the object at all — and only the second is a disclosure. The
   * middleware used to read `allowed` alone and answer 403 for every non-read
   * action, which is exactly how `PATCH /tasks/:id` came to confirm the
   * existence of a Task `GET /tasks/:id` concealed.
   */
  concealed: boolean;
  resourceId?: string;
}

const POINT_TYPES = new Set<GrantResourceType>([
  'task', 'phase', 'project', 'report', 'skill', 'personality', 'service',
]);

/** The database row -> evaluator shape mapping. EXPORTED so the inheritance
 * rule it encodes (117: an orphan Task inherits nothing; a restricted Phase
 * suppresses its Tasks) is testable as the pure function it is; the query that
 * feeds it is asserted separately, so neither side can drift alone. */
export function mapResource(type: GrantResourceType, row: Record<string, unknown>): AuthorizationResource {
  const base: AuthorizationResource = { type, id: String(row.id) };
  if (type === 'task') {
    const inheritedProjectId = row.project_id && row.project_status === 'active'
      ? String(row.project_id) : null;
    return {
      ...base,
      ownerPrincipalId: (row.owner_principal_id as string | null) ?? null,
      claimantPrincipalId: (row.owner_principal_id as string | null) ?? null,
      creatorPrincipalId: (row.creator_principal_id as string | null) ?? null,
      shepherdPrincipalId: (row.shepherd_principal_id as string | null) ?? null,
      verifierPrincipalId: (row.verifier_principal_id as string | null) ?? null,
      visibility: (row.visibility as AuthorizationResource['visibility']) ?? 'private',
      // 117 / packet 16896595 decision 2: the inherited arm walks
      // Task -> Phase -> Project. An ORPHAN Task (`project_id IS NULL`) has no
      // ancestor row to read, so the field stays NULL and inherits NOTHING -
      // it is never coerced to a value the evaluator could act on. The same
      // is true of a Task whose Project is no longer a LIVE source (review
      // 66281121 finding 1): `status = 'active'` is the test, not
      // `<> 'archived'`, so a status value added later confers nothing until
      // someone decides it should.
      inheritedProjectId,
      inheritedVisibility: inheritedProjectId
        ? ((row.project_visibility as AuthorizationResource['visibility']) ?? null)
        : null,
      // The Task's own opt-out OR its Phase's. Ruling 44ee41f2 suppresses
      // ordinary inherited Project visibility under a restricted Phase, and
      // the Task is the object that holds the confidential content.
      restrictedAccess: Boolean(row.restricted_access) || Boolean(row.phase_restricted_access),
    };
  }
  if (type === 'project') {
    return {
      ...base,
      ownerPrincipalId: (row.owner_principal_id as string | null) ?? null,
      visibility: (row.visibility as AuthorizationResource['visibility']) ?? 'private',
    };
  }
  if (type === 'phase') {
    return {
      ...base,
      ownerPrincipalId: (row.project_owner_principal_id as string | null) ?? null,
      inheritedVisibility: (row.project_visibility as AuthorizationResource['visibility']) ?? 'private',
      restrictedAccess: Boolean(row.restricted_access),
    };
  }
  if (type === 'report') {
    return {
      ...base,
      ownerPrincipalId: (row.author_principal_id as string | null) ?? null,
      creatorPrincipalId: (row.author_principal_id as string | null) ?? null,
      visibility: (row.visibility as AuthorizationResource['visibility']) ?? 'default',
    };
  }
  return base;
}

export class AuthorizationRepository {
  private async resolve(type: GrantResourceType, identifier: string): Promise<AuthorizationResource | null> {
    if (!POINT_TYPES.has(type)) return null;
    let text: string;
    let params: unknown[];
    switch (type) {
      case 'task':
        // Both joins are on PRIMARY KEYs, so neither can multiply a row, and
        // both are LEFT so an orphan Task still resolves (and is then decided
        // by the anchor, not by disappearing from the result).
        text = `SELECT t.id, t.owner_principal_id, t.creator_principal_id, t.visibility,
                       t.project_id, t.restricted_access,
                       ph.restricted_access AS phase_restricted_access,
                       p.visibility AS project_visibility, p.status AS project_status,
                       to_jsonb(t)->>'shepherd_principal_id' AS shepherd_principal_id,
                       to_jsonb(t)->>'verifier_principal_id' AS verifier_principal_id
                  FROM tasks t
                  LEFT JOIN phases ph ON ph.id = t.phase_id
                  LEFT JOIN projects p ON p.id = t.project_id
                 WHERE t.id::text LIKE $1 || '%' ORDER BY t.id LIMIT 2`;
        params = [identifier];
        break;
      case 'project':
        text = `SELECT id, owner_principal_id, visibility FROM projects
                 WHERE id::text = $1 OR name = $1 ORDER BY id LIMIT 2`;
        params = [identifier];
        break;
      case 'phase':
        text = `SELECT ph.id, ph.restricted_access,
                       p.owner_principal_id AS project_owner_principal_id,
                       p.visibility AS project_visibility
                  FROM phases ph JOIN projects p ON p.id = ph.project_id
                 WHERE ph.id::text = $1 LIMIT 2`;
        params = [identifier];
        break;
      case 'report':
        text = `SELECT id, author_principal_id, visibility FROM reports
                 WHERE id::text LIKE $1 || '%' ORDER BY id LIMIT 2`;
        params = [identifier];
        break;
      case 'skill':
        text = `SELECT id FROM skills WHERE id::text = $1 OR name = $1 ORDER BY id LIMIT 2`;
        params = [identifier];
        break;
      case 'personality':
        text = `SELECT id FROM personalities WHERE id::text = $1 OR slug = $1 ORDER BY id LIMIT 2`;
        params = [identifier];
        break;
      case 'service':
        text = `SELECT id FROM services WHERE id::text = $1 OR slug = $1 ORDER BY id LIMIT 2`;
        params = [identifier];
        break;
      default:
        return null;
    }
    const result = await pool.query(text, params);
    if (result.rows.length !== 1) return null;
    return mapResource(type, result.rows[0]);
  }

  /** The FROM clause and column shape one resource type presents to the
   * shared predicate. Not private: it is the coordinate the inheritance rule
   * is CONFIGURED at, and a control that hand-copies the shape instead of
   * reading it cannot notice the shape changing. */
  sqlResource(type: GrantResourceType): { from: string; resource: AuthorizationSqlResource } {
    switch (type) {
      case 'task':
        return {
          // 117: the inherited-visibility arm walks Task -> Phase -> Project.
          // Both joins are on PRIMARY KEYs (`phases.id`, `projects.id`), so
          // neither can multiply a row; both are LEFT so an orphan Task is
          // still a candidate row and is refused by the anchor conjunct
          // instead of silently vanishing from a list.
          from: 'tasks t LEFT JOIN phases ph ON ph.id = t.phase_id'
            + ' LEFT JOIN projects p ON p.id = t.project_id',
          resource: {
            type, id: 't.id', owner: 't.owner_principal_id', claimant: 't.owner_principal_id',
            creator: 't.creator_principal_id', visibility: 't.visibility',
            shepherd: 't.shepherd_principal_id', verifier: 't.verifier_principal_id',
            inheritedVisibility: 'p.visibility',
            // RH-AZ.PROJ-b: the project-bounded selector form reads THIS
            // column. It is the Task's OWN `project_id`, the same coordinate
            // the inheritance anchor uses — not a walk through the Phase — so
            // one Task has exactly one project perimeter and a reader does not
            // have to ask which of two answers a selector meant.
            project: 't.project_id',
            restrictedAccess: '(t.restricted_access OR COALESCE(ph.restricted_access, FALSE))',
            inheritanceAnchor: "t.project_id IS NOT NULL AND p.status = 'active'",
          },
        };
      case 'project':
        // NO `project` column, deliberately: a Project's project coordinate is
        // its own id, so declaring it would make `all-in-project` a second
        // spelling of `exact`. `SELECTOR_FORM_ADMISSIBILITY` refuses the form
        // for this type at the write, and this absence is the evaluator half of
        // the same decision.
        return {
          from: 'projects p',
          resource: { type, id: 'p.id', owner: 'p.owner_principal_id', visibility: 'p.visibility' },
        };
      case 'phase':
        return {
          from: 'phases ph JOIN projects p ON p.id = ph.project_id',
          resource: {
            type, id: 'ph.id', owner: 'p.owner_principal_id', inheritedVisibility: 'p.visibility',
            project: 'ph.project_id',
            restrictedAccess: 'ph.restricted_access',
          },
        };
      case 'report':
        return {
          from: 'reports r',
          resource: {
            type, id: 'r.id', owner: 'r.author_principal_id', creator: 'r.author_principal_id',
            visibility: 'r.visibility',
          },
        };
      case 'blueprint':
        return { from: 'blueprints b', resource: { type, id: 'b.id', owner: 'b.created_by_principal_id', visibility: "'shared'" } };
      case 'skill':
        return { from: 'skills s', resource: { type, id: 's.id', visibility: "'shared'" } };
      case 'personality':
        return { from: 'personalities pe', resource: { type, id: 'pe.id', visibility: "'shared'" } };
      case 'service':
        return { from: 'services se', resource: { type, id: 'se.id', visibility: "'shared'" } };
      default:
        throw new Error('Unsupported authorization resource type');
    }
  }

  /**
   * The narrowing a PAGINATED list must carry in its own WHERE.
   *
   * `filterAuthorizedResources` narrows rows AFTER they are read, which is the
   * right shape for a list that reports no total. A paginated list cannot use
   * it and stay honest: its `total` and `hasMore` are computed by a COUNT the
   * narrowing never reached, and a count over rows the caller may not read is
   * a disclosure in its own right - the reason `/tasks/aggregates` counts the
   * NARROWED set rather than the queried one. So the narrowing moves INTO the
   * query, and it is the SAME `sqlCondition` that `authorizedIds` and
   * therefore `authorizePoint` run - never a second copy of the rule.
   */
  listScope<T extends GrantResourceType>(
    actor: AuthorizationActor,
    type: T,
    action: AuthorizationAction,
  ): AuthorizationListScope<T> {
    const { from, resource } = this.sqlResource(type);
    return {
      type,
      from,
      id: resource.id,
      render: (paramOffset: number) => authorizationService.sqlCondition(actor, action, resource, paramOffset),
    };
  }

  /** One SQL-list adapter for both collection narrowing and point decisions.
   * Candidate ids are already bounded by the route's domain query.
   *
   * `queryable` (RH-P3.AZ-S7) lets a caller run THIS predicate — the same
   * one, never a copy — on its own OPEN TRANSACTION, so a decision can see
   * rows the transaction has written but not yet committed. That is what
   * lets the assignment-access coupling PROVE readability inside the
   * assignment act (ruling 7440b579 R1) instead of asserting it. Omitted,
   * it is the pool, exactly as before. */
  async authorizedIds(
    actor: AuthorizationActor,
    type: GrantResourceType,
    ids: string[],
    action: AuthorizationAction,
    queryable: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> } = pool,
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const uniqueIds = [...new Set(ids.map(String))];
    const { from, resource } = this.sqlResource(type);
    const condition = authorizationService.sqlCondition(actor, action, resource, 2);
    const result = await queryable.query(
      `SELECT ${resource.id}::text AS id
         FROM ${from}
        WHERE ${resource.id}::text = ANY($1::text[])
          AND ${condition.sql}`,
      [uniqueIds, ...condition.params],
    );
    return new Set(result.rows.map((row) => String(row.id)));
  }

  /**
   * Which of `ids` a SELECTOR of the actor's covers — the grant arm and the
   * Access-profile arm, and nothing else.
   *
   * ── WHY THIS EXISTS (round-1 review finding S2-B1, `8981983f`) ──
   *
   * `authorizedIds` answers "may this actor read this row", which is the
   * right question almost everywhere. For `service` rows it is satisfied by
   * `sqlResource`'s visibility literal `'shared'`, so it is TRUE for every
   * authenticated caller and no selector can narrow it. KNOWLEDGE-DESIGN
   * `94747de9` §5.5 limb (c) needs the other question — "does a SELECTOR of
   * this caller's reach this row" — because A21 says the scope is "always
   * evaluated against an object selector ... never a flat estate-wide grant",
   * and §5.5 says a source outside it is undisclosed absolutely.
   *
   * -- HOW IT ASKS IT (round-2 finding R2-F2, verdict `cd392c55`) --
   *
   * The first version composed the two selector FRAGMENTS by hand. That was a
   * second predicate in everything but name, and it was wrong in the way a
   * hand-rolled predicate is always wrong: it evaluated only the acting
   * principal's DIRECT grants and profiles and omitted the delegation-chain
   * intersection `sqlCondition` performs - excluding rows a delegated caller
   * legitimately reaches, and admitting rows outside its effective authority.
   *
   * So it now calls `sqlCondition` ITSELF and removes exactly one thing: the
   * VISIBILITY arms. `visibilityArms` contributes nothing when the resource
   * shape carries no visibility column, so dropping those two fields is the
   * entire difference from `authorizedIds`. Every other arm - grants,
   * profiles, ownership, the AZ-S3 chain intersection - is the shipped one.
   *
   * -- THE ADMINISTRATOR ARM, SUPPRESSED BY RULING (terminal finding P2) --
   *
   * `sqlCondition`'s fourth short-circuit returns TRUE unconditionally for a
   * NON-DELEGATED actor whose role is `admin`, `operator` or `orchestrator`
   * (census `abc71ffb` F2). Left in place it made this question unable to
   * refuse for those roles, which contradicted both ratified A21 and this
   * route's own production comment. Owner ruling `623632b0` option (a)
   * settled it: the selector is enforced for EVERY NON-ROOT caller. So the
   * call below passes `withoutAdministratorArm`, an opt-in flag on the
   * shipped predicate that every other caller leaves alone.
   *
   * `root` keeps its A12.1 sentinel arm and is additionally short-circuited
   * at the route, where a reader can see it.
   */
  async selectorCoveredIds(
    actor: AuthorizationActor,
    type: GrantResourceType,
    ids: string[],
    action: AuthorizationAction = 'read',
    queryable: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> } = pool,
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const uniqueIds = [...new Set(ids.map(String))];
    const { from, resource } = this.sqlResource(type);
    // The SHIPPED predicate, with the VISIBILITY arms alone removed.
    const {
      visibility: _visibility,
      inheritedVisibility: _inheritedVisibility,
      ...selectorResource
    } = resource;
    const condition = authorizationService.sqlCondition(actor, action, selectorResource, 2, {
      withoutAdministratorArm: true,
    });
    const result = await queryable.query(
      `SELECT ${resource.id}::text AS id
         FROM ${from}
        WHERE ${resource.id}::text = ANY($1::text[])
          AND ${condition.sql}`,
      [uniqueIds, ...condition.params],
    );
    return new Set(result.rows.map((row) => String(row.id)));
  }

  /**
   * The point decision, and - when it refuses - WHICH refusal it is.
   *
   * Card `f9b7febe`: for a Task the caller may not read, `GET /tasks/:id`
   * answered 404 and `PATCH /tasks/:id` answered 403, so an id could be
   * confirmed by writing to it. The rule the product already holds (AUTHZ
   * `4d961e37` par.9.6, the 44d1bf89 rule) is that an object the caller cannot
   * READ is reported exactly as an absent one - on EVERY verb, not only on the
   * verb whose own decision happens to be the read.
   *
   * So a refusal asks a second question, and only a refusal does: may this
   * caller read the resource at all? A caller that CAN read it and cannot
   * write it learns nothing from a 403 it did not already know, and that 403
   * is the answer a person editing a Task they can see has to receive - a
   * concealed 404 there presents as a broken save. The distinction is the
   * whole repair: this is not "404 everything".
   *
   * The extra query runs ONLY on a refusal of a non-read action, on a request
   * already bound for a 4xx, and it is the SAME predicate - never a copy.
   */
  async authorizePoint(
    actor: AuthorizationActor,
    type: GrantResourceType,
    identifier: string,
    action: AuthorizationAction,
    queryable: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> } = pool,
  ): Promise<PointDecision> {
    const resource = await this.resolve(type, identifier);
    if (!resource) return { exists: false, allowed: false, concealed: true };
    const allowed = (await this.authorizedIds(actor, type, [resource.id], action, queryable))
      .has(resource.id);
    if (allowed) return { exists: true, allowed: true, concealed: false, resourceId: resource.id };
    // For `read` the decision just made IS the read decision; asking again
    // would be the same query with the same answer.
    const readable = action === 'read'
      ? false
      : (await this.authorizedIds(actor, type, [resource.id], 'read', queryable)).has(resource.id);
    return { exists: true, allowed: false, concealed: !readable, resourceId: resource.id };
  }
}

export const authorizationRepository = new AuthorizationRepository();
