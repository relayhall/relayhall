import {
  AuthorizationAction, AuthorizationActor, AuthorizationService,
} from '../services/AuthorizationService';
import { authorizationRepository, mapResource } from '../services/AuthorizationRepository';
import { grantService, GrantVerb } from '../services/GrantService';

const service = new AuthorizationService();
const taskId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const actor: AuthorizationActor = {
  principalId: '33333333-3333-4333-8333-333333333333', handle: 'member',
  role: 'user', scopes: ['tasks:read', 'tasks:write'], authenticated: true,
};
const actions: AuthorizationAction[] = ['read', 'write', 'claim', 'finish', 'release', 'admin', 'shepherd', 'verify', 'use', 'invoke'];
const ordinary = ['read', 'write', 'claim', 'finish', 'release'];
const task = () => mapResource('task', {
  id: taskId, project_id: projectId, project_status: 'active', project_visibility: 'private',
  visibility: 'private', restricted_access: false, phase_restricted_access: false,
});
const grant = (verb: GrantVerb, resourceId: string | null = projectId) => ({ resourceType: 'project' as const, resourceId, verb });

describe('approved exact Project Grant inheritance', () => {
  it.each(['read', 'write', 'admin', 'use', 'invoke'] as GrantVerb[])('projects %s supplies only its ratified ordinary Task subset', (verb) => {
    const expected = verb === 'read' ? ['read'] : verb === 'write' || verb === 'admin' ? ordinary : [];
    const admitted = actions.filter((action) => service.authorizeResource(actor, action, task(), [grant(verb)]).allowed);
    expect(admitted).toEqual(expected);
  });

  it.each([
    ['Task restriction', { restricted_access: true }],
    ['Phase restriction', { phase_restricted_access: true }],
    ['orphan', { project_id: null }],
    ['missing Project', { project_status: null }],
    ['archived Project', { project_status: 'archived' }],
    ['unknown Project state', { project_status: 'future-state' }],
  ] as const)('%s suppresses this arm while an exact Task Grant remains valid', (_label, changes) => {
    const resource = mapResource('task', {
      id: taskId, project_id: projectId, project_status: 'active', visibility: 'private',
      project_visibility: 'private', restricted_access: false, phase_restricted_access: false, ...changes,
    });
    expect(service.authorizeResource(actor, 'read', resource, [grant('admin')]).allowed).toBe(false);
    expect(service.authorizeResource(actor, 'write', resource, [{ resourceType: 'task', resourceId: taskId, verb: 'write' }]).allowed).toBe(true);
  });

  it.each([null, '44444444-4444-4444-8444-444444444444'])('a wildcard or different Project %s confers nothing', (id) => {
    expect(service.authorizeResource(actor, 'read', task(), [grant('admin', id)]).allowed).toBe(false);
  });

  it('ignores expired exact Project Grants and keeps the route ceiling independent', () => {
    const now = new Date('2026-09-06T12:00:00Z');
    expect(service.authorizeResource(actor, 'read', task(), [{ ...grant('read'), expiresAt: now.toISOString() }], now).allowed).toBe(false);
    expect(service.authorizeRoute({ ...actor, scopes: ['projects:write'] }, 'tasks:read').allowed).toBe(false);
    expect(service.authorizeRoute({ ...actor, scopes: ['tasks:read'] }, 'tasks:write').allowed).toBe(false);
    expect(service.authorizeResource({ ...actor, role: 'viewer' }, 'write', task(), [grant('admin')]).denial).toBe('ROLE_CEILING');
  });

  it('the Grant evaluator retains typed wildcards by default and offers exact-only evaluation explicitly', () => {
    const ordinarySeam = grantService.activeGrantCondition(4);
    const exact = grantService.activeGrantCondition(4, { exactOnly: true });
    expect(ordinarySeam.sql).toContain('g.resource_id IS NULL');
    expect(exact.sql).not.toContain('g.resource_id IS NULL');
    expect(exact.sql).toContain('g.resource_id = <RESOURCE_ID_COLUMN>');
    for (const seam of [ordinarySeam, exact]) {
      expect(seam.sql).toContain("mp.status = 'active'");
      expect(seam.sql).toContain('g.expires_at > NOW()');
      expect(seam.bind(actor.principalId!, 'project', 'write')).toEqual([actor.principalId, 'project', 'write']);
    }
  });

  it.each(['project', 'inheritanceAnchor', 'restrictedAccess'] as const)('a Task SQL shape without %s cannot activate Project inheritance', (field) => {
    const resource = { ...authorizationRepository.sqlResource('task').resource };
    delete resource[field];
    expect(service.sqlCondition(actor, 'read', resource).params).not.toContain('project');
  });

  it.each(['phase', 'project', 'report', 'skill', 'service', 'personality'] as const)('adds no inherited Project Grant source to %s', (type) => {
    const resource = authorizationRepository.sqlResource(type).resource;
    const decision = service.sqlCondition(actor, 'read', resource);
    // A Project's own Grant arms are existing behavior; they use its own id.
    if (type !== 'project') expect(decision.params).not.toContain('project');
    else expect(resource.project).toBeUndefined();
    expect(service.authorizeResource(actor, 'write', { type, id: taskId, inheritedProjectId: projectId }, [grant('write')]).allowed).toBe(false);
  });
});
