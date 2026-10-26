import {
  evaluateSurfaceStage, filterAuthorizedResources, pointAuthorizationTarget, sharedAuthorizationMiddleware,
} from '../middleware/sharedAuthorization';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { authorizationService } from '../services/AuthorizationService';
import { accessSurfaceService } from '../services/AccessSurfaceService';
import { requiredScopeFor, scopesNamedByDenial } from '../utils/scopeMap';

describe('pointAuthorizationTarget', () => {
  it('classifies point reads and mutations across grantable route families', () => {
    expect(pointAuthorizationTarget('GET', '/tasks/abc12345')).toEqual({
      type: 'task', identifier: 'abc12345', action: 'read',
    });
    expect(pointAuthorizationTarget('DELETE', '/skills/skill-name')).toEqual({
      type: 'skill', identifier: 'skill-name', action: 'admin',
    });
    expect(pointAuthorizationTarget('PATCH', '/projects/project-name')).toEqual({
      type: 'project', identifier: 'project-name', action: 'write',
    });
  });

  it('maps disclosure POSTs and Task-role lifecycle paths to their narrow actions', () => {
    expect(pointAuthorizationTarget('POST', '/tasks/abc12345/brief')?.action).toBe('read');
    expect(pointAuthorizationTarget('POST', '/phases/11111111-1111-4111-8111-111111111111/brief')?.action).toBe('read');
    expect(pointAuthorizationTarget('POST', '/tasks/abc12345/claim')?.action).toBe('claim');
    // RH-P3.C3: `finish` is a declared AuthorizationAction with a claimant
    // arm; before this candidate no branch produced it, so the finish route
    // was classified as generic `write` and the predicate never saw the act
    // it has a name for.
    expect(pointAuthorizationTarget('POST', '/tasks/abc12345/finish')?.action).toBe('finish');
    // RH-P3.C3: meltdown recovery is shepherd authority (§2.6.4), not the
    // claimant's release.
    expect(pointAuthorizationTarget('POST', '/tasks/abc12345/recover')?.action).toBe('shepherd');
    expect(pointAuthorizationTarget('POST', '/tasks/abc12345/release')?.action).toBe('release');
    expect(pointAuthorizationTarget('POST', '/tasks/abc12345/subtasks/0/approve')?.action).toBe('verify');
    expect(pointAuthorizationTarget('POST', '/tasks/reviewer/abc12345/run')?.action).toBe('verify');
    expect(pointAuthorizationTarget('PATCH', '/tasks/abc12345/roles')?.action).toBe('shepherd');
  });

  /**
   * Review 66281121 finding 2. Express routes with `caseSensitive:false` and
   * `strict:false`, and `scopeMap.normalizePathForScope` has folded the
   * spelling at the ROUTE stage since A12 for exactly that reason. The OBJECT
   * stage did not, so a non-canonical spelling of the SAME handler got a
   * DIFFERENT object action — `/tasks/x/ACCESS` classified as the generic
   * `write` where the canonical `/access` demands `admin`, and a whole family
   * spelled `/TASKS/...` matched nothing and skipped the object check
   * entirely. This is a CLASS fix: `/phases/x/ACCESS` had the identical hole,
   * and the 085 policy surface is behind it.
   */
  it('classifies every spelling of the same handler identically', () => {
    const canonical = pointAuthorizationTarget('PATCH', '/tasks/abc12345/access');
    expect(canonical).toEqual({ type: 'task', identifier: 'abc12345', action: 'admin' });
    for (const path of [
      '/tasks/abc12345/ACCESS',
      '/tasks/abc12345/AcCeSs',
      '/tasks/abc12345/access/',
      '/TASKS/abc12345/access',
      '/Tasks/abc12345/Access',
      '/tasks//abc12345/access',
    ]) {
      expect(pointAuthorizationTarget('PATCH', path)).toEqual(canonical);
    }
  });

  it('closes the same hole on the ratified Phase policy surface', () => {
    const canonical = pointAuthorizationTarget('PATCH', '/phases/abc12345/access');
    expect(canonical?.action).toBe('admin');
    expect(pointAuthorizationTarget('PATCH', '/phases/abc12345/ACCESS')?.action).toBe('admin');
    expect(pointAuthorizationTarget('PATCH', '/PHASES/abc12345/access')?.type).toBe('phase');
  });

  it('folds every other route word too, so no spelling escapes its narrow action', () => {
    expect(pointAuthorizationTarget('POST', '/tasks/abc12345/BRIEF')?.action).toBe('read');
    expect(pointAuthorizationTarget('POST', '/tasks/abc12345/CLAIM')?.action).toBe('claim');
    expect(pointAuthorizationTarget('POST', '/tasks/abc12345/FINISH')?.action).toBe('finish');
    expect(pointAuthorizationTarget('POST', '/tasks/abc12345/RELEASE')?.action).toBe('release');
    expect(pointAuthorizationTarget('POST', '/tasks/abc12345/RECOVER')?.action).toBe('shepherd');
    expect(pointAuthorizationTarget('PATCH', '/tasks/abc12345/ROLES')?.action).toBe('shepherd');
    expect(pointAuthorizationTarget('POST', '/tasks/abc12345/subtasks/0/APPROVE')?.action).toBe('verify');
    expect(pointAuthorizationTarget('POST', '/tasks/REVIEWER/abc12345/run')?.action).toBe('verify');
    expect(pointAuthorizationTarget('POST', '/tasks/REVIEWER/abc12345/run')?.identifier).toBe('abc12345');
  });

  it('recognises a COLLECTION word at every spelling too', () => {
    // Review cf04a642 finding 1: the collection test is the same question as
    // the family test — "is this segment a fixed route word?" — so it folds
    // with them. Left case-sensitive, `/tasks/FILTER-OPTIONS` was classified
    // as a Task id and answered 404 where the canonical spelling worked.
    for (const word of ['filter-options', 'ids', 'batch', 'auto-archive',
      'operating-contract', 'aggregates', 'graph', 'bulk-archive']) {
      expect(pointAuthorizationTarget('GET', `/tasks/${word}`)).toBeNull();
      expect(pointAuthorizationTarget('GET', `/tasks/${word.toUpperCase()}`)).toBeNull();
    }
    expect(pointAuthorizationTarget('GET', '/projects/STATS/distribution')).toBeNull();
    expect(pointAuthorizationTarget('GET', '/projects/stats/distribution')).toBeNull();
  });

  it('passes the identifier VALUE through with its original case', () => {
    // The collection TEST folds; the identifier VALUE never does, because it
    // is caller data and `resolve` matches Project and Skill names exactly.
    expect(pointAuthorizationTarget('GET', '/skills/My-Skill')?.identifier).toBe('My-Skill');
    expect(pointAuthorizationTarget('GET', '/projects/RelayHall')).toEqual({
      type: 'project', identifier: 'RelayHall', action: 'read',
    });
    expect(pointAuthorizationTarget('GET', '/tasks/ABC12345')?.identifier).toBe('ABC12345');
  });

  it('does not mistake collection and named utility routes for object identifiers', () => {
    expect(pointAuthorizationTarget('GET', '/tasks')).toBeNull();
    expect(pointAuthorizationTarget('GET', '/tasks/filter-options')).toBeNull();
    expect(pointAuthorizationTarget('GET', '/tasks/operating-contract')).toBeNull();
    expect(pointAuthorizationTarget('POST', '/tasks/auto-archive')).toBeNull();
    expect(pointAuthorizationTarget('GET', '/projects/stats/distribution')).toBeNull();
    expect(pointAuthorizationTarget('GET', '/dashboard/summary')).toBeNull();
  });

  it('narrows a collection with one batched SQL-adapter call', async () => {
    const authorizedIds = jest.spyOn(authorizationRepository, 'authorizedIds')
      .mockResolvedValue(new Set(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']));
    const values = [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    ];
    const result = await filterAuthorizedResources(
      {
        userId: 'agent:test',
        principal: { id: '11111111-1111-4111-8111-111111111111', role: 'agent' },
        scopes: ['tasks:read'],
      } as any,
      'read',
      values,
      (value) => ({ type: 'task', id: value.id, visibility: 'private' }),
    );
    expect(result).toEqual([values[1]]);
    expect(authorizedIds).toHaveBeenCalledTimes(1);
    expect(authorizedIds).toHaveBeenCalledWith(
      expect.any(Object),
      'task',
      values.map((value) => value.id),
      'read',
    );
    authorizedIds.mockRestore();
  });
});

/**
 * Candidate A correction round (card f3b12d31, review of 24986997..8975606).
 *
 * The route ceiling refused with a bare FORBIDDEN for every cause, so the MCP
 * layer could not tell a credential that lacks a scope from a caller refused for
 * role or ownership - and a day-one credential without `principals:read` was no
 * longer told which scope it lacked. The ceiling already KNOWS which it is
 * (`authorizeRoute().denial`), so it now says so as data: `details.requiredScopes`
 * on the SCOPE_CEILING refusal and on nothing else. Status, code and text are
 * unchanged in every case.
 */
describe('the route ceiling names the scope it checked, and only when the scope is the reason', () => {
  const BARE = 'This identity is not authorized for the requested operation';

  afterEach(() => jest.restoreAllMocks());

  function reply() {
    const res: any = {
      statusCode: null as number | null,
      body: null as any,
      status(code: number) { res.statusCode = code; return res; },
      json(payload: unknown) { res.body = payload; return res; },
    };
    return res;
  }

  async function ask(method: string, path: string, who: { role: string; scopes: string[] | null }) {
    const req: any = {
      method, path, baseUrl: '', body: {}, userId: 'service-one', authMethod: 'api_key',
      principal: { id: '88888888-8888-4888-8888-888888888888', role: who.role },
      scopes: who.scopes,
    };
    const res = reply();
    const next = jest.fn();
    await sharedAuthorizationMiddleware(req, res, next);
    return { res, next };
  }

  // The exemplar route was `POST /principals/me/brief` until card 1118fefa
  // moved that ceiling to `authenticated`; from then on it is no example of a
  // scope-gated route, and the controls below would pass for the wrong reason.
  // `GET /principals` is the same family at the SAME unchanged ceiling.
  it('answers a credential that lacks the route scope with the scope the ceiling checked', async () => {
    // The premise, asserted rather than assumed: this is the route's own scope.
    expect(requiredScopeFor('GET', '/principals')).toBe('principals:read');
    const { res, next } = await ask('GET', '/principals', { role: 'agent', scopes: ['tasks:read'] });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      success: false, error: BARE, code: 'FORBIDDEN', message: BARE,
      details: { requiredScopes: ['principals:read'] },
    });
  });

  it('names what the ROUTE needs, never what the credential holds', async () => {
    const { res } = await ask('GET', '/principals', { role: 'agent', scopes: ['tasks:read', 'reports:read'] });
    // Not vacuous: the request WAS refused, so there was a body to leak into.
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/tasks:read|reports:read/);
  });

  it('names nothing when the credential holds the scope: the request moves on', async () => {
    const { res, next } = await ask('GET', '/principals', { role: 'agent', scopes: ['principals:read'] });
    expect(res.statusCode).toBeNull();
    expect(next).toHaveBeenCalled();
  });

  it('card 1118fefa: the SESSION brief is a self-identity ceiling - any credential reaches its own', async () => {
    // The one moved row, pinned in both directions. A four-scope task worker
    // and a credential with NO scopes both pass the ceiling for their OWN
    // session brief (what the payload encloses is the compiler's decision,
    // pinned in c4SessionBrief); the directory beside it still refuses them.
    expect(requiredScopeFor('POST', '/principals/me/brief')).toBe('authenticated');
    for (const scopes of [['tasks:read', 'tasks:write', 'reports:read', 'reports:write'], []]) {
      const own = await ask('POST', '/principals/me/brief', { role: 'agent', scopes });
      expect([scopes.join(','), own.res.statusCode, own.next.mock.calls.length]).toEqual([scopes.join(','), null, 1]);
      const directory = await ask('GET', '/principals', { role: 'agent', scopes });
      expect([scopes.join(','), directory.res.statusCode, directory.res.body?.details])
        .toEqual([scopes.join(','), 403, { requiredScopes: ['principals:read'] }]);
    }
    // A missing scope set is still not an identity: it fails closed.
    const unset = await ask('POST', '/principals/me/brief', { role: 'agent', scopes: null });
    expect(unset.res.statusCode).toBe(403);
    expect(unset.next).not.toHaveBeenCalled();
  });

  it('stays bare for a ROLE ceiling, even though the scope is also absent', async () => {
    expect(requiredScopeFor('DELETE', '/tasks/abc12345')).toBe('tasks:admin');
    const { res } = await ask('DELETE', '/tasks/abc12345', { role: 'agent', scopes: ['tasks:read'] });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ success: false, error: BARE, code: 'FORBIDDEN', message: BARE });
  });

  it('stays bare for an unmapped (root) route', async () => {
    const unmapped = '/no-such-route-family';
    expect(requiredScopeFor('GET', unmapped)).toBe('root');
    jest.spyOn(accessSurfaceService, 'listSurfaces').mockResolvedValue([]);
    const { res } = await ask('GET', unmapped, { role: 'admin', scopes: ['tasks:read'] });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ success: false, error: BARE, code: 'FORBIDDEN', message: BARE });
  });

  it('stays bare when the ceiling gave no reason (a caller that passes none)', async () => {
    const req: any = { method: 'GET', path: '/principals', baseUrl: '', userId: 'service-one', scopes: [] };
    const res = reply();
    expect(await evaluateSurfaceStage(req, res, '/principals', 'principals:read')).toBe(false);
    expect(res.body).toEqual({ success: false, error: BARE, code: 'FORBIDDEN', message: BARE });

    jest.spyOn(authorizationService, 'authorizeRoute').mockReturnValue({ allowed: false });
    const bare = await ask('GET', '/principals', { role: 'agent', scopes: ['tasks:read'] });
    expect(bare.res.body).toEqual({ success: false, error: BARE, code: 'FORBIDDEN', message: BARE });
  });

  it('never names the sentinels: `authenticated` is not a scope a credential can carry', async () => {
    const req: any = { method: 'GET', path: '/x', baseUrl: '', userId: 'service-one', scopes: null };
    const res = reply();
    expect(await evaluateSurfaceStage(req, res, '/x', 'authenticated', 'SCOPE_CEILING')).toBe(false);
    expect(res.body).toEqual({ success: false, error: BARE, code: 'FORBIDDEN', message: BARE });
  });
});

/**
 * The rule the ceiling above and every handler-level scope refusal share
 * (card fbeb86f1): a refusal may name a scope only when the absence of that
 * scope is the whole reason, and what it names is the requirement.
 */
describe('scopesNamedByDenial: the one rule for when a refusal may name a scope', () => {
  it('names the required scope for the scope-ceiling denial and nothing else', () => {
    expect(scopesNamedByDenial('blueprints:use', 'SCOPE_CEILING')).toEqual(['blueprints:use']);
    for (const denial of ['ROLE_CEILING', 'UNAUTHENTICATED', 'NO_AUTHORITY', 'NOT_FOUND', 'SOMETHING_ELSE', undefined]) {
      expect(scopesNamedByDenial('blueprints:use', denial)).toBeUndefined();
    }
  });

  it('never names the sentinels, whatever the denial says', () => {
    expect(scopesNamedByDenial('root', 'SCOPE_CEILING')).toBeUndefined();
    expect(scopesNamedByDenial('authenticated', 'SCOPE_CEILING')).toBeUndefined();
  });

  it('agrees with the authorizer on what is a scope-ceiling denial', () => {
    const lacking: any = { principalId: 'p', handle: 'h', role: 'agent', scopes: ['tasks:read'], authenticated: true };
    const decision = authorizationService.authorizeRoute(lacking, 'reports:read');
    expect(decision.allowed).toBe(false);
    expect(scopesNamedByDenial('reports:read', decision.denial)).toEqual(['reports:read']);
    const viewer: any = { ...lacking, role: 'viewer', scopes: null };
    const roleDecision = authorizationService.authorizeRoute(viewer, 'tasks:write');
    expect(roleDecision.denial).toBe('ROLE_CEILING');
    expect(scopesNamedByDenial('tasks:write', roleDecision.denial)).toBeUndefined();
  });
});
