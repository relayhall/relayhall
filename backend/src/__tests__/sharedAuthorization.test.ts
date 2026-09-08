import { filterAuthorizedResources, pointAuthorizationTarget } from '../middleware/sharedAuthorization';
import { authorizationRepository } from '../services/AuthorizationRepository';

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
