/** E159 fast-tier census. Production routers/stage, PostgreSQL-like service
 * doubles: malformed UUID reads throw 22P02, absent UUIDs return typed 404.
 * Each case is separate so mutations identify exactly the affected guard.
 * Uppercase fixtures are absent, and prove shape acceptance/read-through;
 * stored-row success and real PostgreSQL are anchored by the live suite. */
import express, { Router } from 'express';
import projects from '../routes/projects';
import personalities from '../routes/personalities';
import identityProviders from '../routes/identityProviders';
import credentials from '../routes/credentials';
import notificationEndpoints from '../routes/notificationEndpoints';
import appearance from '../routes/appearanceAdmin';
import services from '../routes/services';
import { sharedAuthorizationMiddleware } from '../middleware/sharedAuthorization';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { projectService } from '../services/ProjectService';
import { projectResourceService, ResourceContractError } from '../services/ProjectResourceService';
import { personalityService } from '../services/PersonalityService';
import { identityProviderService, IdentityProviderError } from '../services/identity/IdentityProviderService';
import { identityLinkService } from '../services/identity/IdentityLinkService';
import { principalService } from '../services/PrincipalService';
import { credentialLifecycleService, CredentialLifecycleError } from '../services/CredentialLifecycleService';
import { notificationEndpointService } from '../services/NotificationEndpointService';
import { appearanceService } from '../services/AppearanceService';
import { skillManager, SkillContractError } from '../services/SkillManager';
import { pool } from '../db/connection';
import { accessSurfaceService } from '../services/AccessSurfaceService';
import { auditService } from '../services/AuditService';

const ID = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
const UNKNOWN = 'f1e2d3c4-b5a6-4789-abcd-0123456789ab';
const BAD = ['not-a-uuid', 'relayhall-release-review', '*', '%25'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function pgUuid(id: string): void {
  if (!UUID.test(id)) throw Object.assign(new Error('invalid uuid'), { code: '22P02' });
}
interface Family { router: Router; mount: string; guarded: Record<string, string>; routes: string[]; excluded?: string[] }
// Explicit tables are checked against Express, including every excluded route.
const FAMILIES: Record<string, Family> = {
  projects: { router: projects, mount: '/projects', guarded: { id: 'INVALID_PROJECT_ID', resourceId: 'INVALID_RESOURCE_ID', skillId: 'INVALID_SKILL_ID' }, routes: [
    'POST /:id/brief', 'GET /:id/context', 'GET /:id/phases', 'GET /:id/compatibility', 'POST /:id/archive', 'POST /:id/unarchive',
    'GET /:id/stats', 'POST /:id/links', 'PUT /:id/links/:linkId', 'DELETE /:id/links/:linkId', 'GET /:id/resources', 'POST /:id/resources',
    'GET /:id/resources/:resourceId', 'PATCH /:id/resources/:resourceId', 'POST /:id/resources/:resourceId/archive', 'POST /:id/resources/:resourceId/restore', 'POST /:id/resources/:resourceId/replace',
    'PATCH /:id/resources', 'PUT /:id/resources', 'GET /:id/tool-instructions', 'PATCH /:id/tool-instructions', 'PUT /:id/tool-instructions',
    'GET /:id/skills', 'PUT /:id/skills/:skillId', 'DELETE /:id/skills/:skillId', 'GET /:id/tools', 'PUT /:id/tools', 'GET /:id/sessions',
    'GET /:id/charter', 'PUT /:id/charter', 'POST /:id/charter/approve', 'GET /:id/charter/versions', 'GET /:id/charter/versions/:version',
    'GET /:id/owner-access', 'GET /:id/owner-candidates', 'PUT /:id/owner', 'GET /:id', 'PATCH /:id',
    // Card b5c83682 (LENSES-c c1-B): the steward transfer of a Project's owner.
    'PUT /:id/owner/steward',
    // Card 41e24358: the Project's default Verifier and the picker's candidates.
    'PUT /:id/default-verifier', 'GET /:id/default-verifier/candidates',
  ] },
  personalities: { router: personalities, mount: '/personalities', guarded: { id: 'INVALID_PERSONALITY_ID' }, routes: ['PATCH /:id', 'DELETE /:id'], excluded: ['GET /:id'] },
  identityProviders: { router: identityProviders, mount: '/identity-providers', guarded: { id: 'INVALID_IDENTITY_PROVIDER_ID', linkId: 'INVALID_IDENTITY_LINK_ID', groupId: 'INVALID_GROUP_ID' }, routes: [
    'GET /:id', 'PATCH /:id', 'PUT /:id/scim-client', 'DELETE /:id/scim-client', 'DELETE /:id', 'POST /:id/test-connection',
    'GET /:id/invitations', 'POST /:id/invitations', 'GET /:id/links', 'GET /:id/login-groups', 'POST /:id/login-groups', 'DELETE /:id/login-groups/:groupId', 'DELETE /links/:linkId',
  ] },
  credentials: { router: credentials, mount: '/credentials', guarded: { id: 'INVALID_CREDENTIAL_ID' }, routes: ['POST /:id/reveal', 'POST /:id/revoke', 'POST /:id/rotate'], excluded: ['PATCH /:id'] },
  notificationEndpoints: { router: notificationEndpoints, mount: '/notification-endpoints', guarded: { id: 'INVALID_NOTIFICATION_ENDPOINT_ID' }, routes: ['DELETE /:id'] },
  appearance: { router: appearance, mount: '/appearance', guarded: { id: 'INVALID_APPEARANCE_ASSET_ID' }, routes: ['GET /asset-versions/:id'], excluded: ['POST /versions/:versionNo/revert', 'POST /assets/:kind', 'GET /asset-history/:kind'] },
  services: { router: services, mount: '/services', guarded: { version: 'INVALID_QUERY_VALUE' }, routes: ['GET /:id/descriptor/versions/:version', 'POST /:id/descriptor/versions/:version/retire'], excluded: ['GET /:id', 'PATCH /:id', 'PATCH /:id/owner-plane', 'GET /:id/descriptor', 'PUT /:id/descriptor', 'GET /:id/descriptor/versions', 'POST /:id/retire', 'DELETE /:id'] },
};
let reads: jest.SpyInstance[];
beforeEach(() => {
  jest.restoreAllMocks(); reads = [];
  jest.spyOn(accessSurfaceService, 'listSurfaces').mockResolvedValue([]);
  jest.spyOn(auditService, 'record').mockResolvedValue({} as never);
  // All un-stubbed database access fails closed; no database is used here.
  jest.spyOn(pool, 'query').mockRejectedValue(Object.assign(new Error('invalid uuid'), { code: '22P02' }) as never);
  jest.spyOn(pool, 'connect').mockRejectedValue(Object.assign(new Error('invalid uuid'), { code: '22P02' }) as never);
  jest.spyOn(authorizationRepository, 'authorizePoint').mockImplementation(async (_actor, type, id) => ({
    exists: id !== UNKNOWN && id !== ID.toUpperCase()
      && !(type === 'personality' && !UUID.test(id) && id !== 'relayhall-release-review'), allowed: true, concealed: false,
  } as never));
  const stub = (object: any, method: string, fn: (...args: any[]) => any) => {
    const spy = jest.spyOn(object, method).mockImplementation(fn); reads.push(spy); return spy;
  };
  stub(projectService, 'getById', async (id) => { pgUuid(id); return { id, status: 'active' }; });
  for (const method of ['get', 'patch', 'archive', 'restore', 'replace']) stub(projectResourceService, method, async (_id, child) => {
    pgUuid(child); throw new ResourceContractError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
  });
  for (const method of ['pinToProject', 'unlinkFromProject']) stub(skillManager, method, async (_id, child) => {
    pgUuid(child); throw new SkillContractError(404, 'SKILL_NOT_FOUND', 'Skill not found');
  });
  stub(personalityService, 'getById', async (id) => { pgUuid(id); return null; });
  stub(personalityService, 'retire', async (id) => { pgUuid(id); return null; });
  for (const method of ['require', 'update', 'setScimClient', 'remove', 'addLoginGroup', 'removeLoginGroup']) stub(identityProviderService, method, async (id, child) => {
    pgUuid(id); if (method === 'removeLoginGroup') pgUuid(child);
    throw new IdentityProviderError('PROVIDER_NOT_FOUND', 'Provider not found');
  });
  stub(identityProviderService, 'recordDiscoveryHealth', async () => undefined);
  stub(identityLinkService, 'unlink', async (id) => { pgUuid(id); throw new IdentityProviderError('PROVIDER_NOT_FOUND', 'Link not found'); });
  stub(principalService, 'getCredentialWithPrincipal', async (id) => { pgUuid(id); return null; });
  stub(credentialLifecycleService, 'reveal', async (id) => { pgUuid(id); throw new CredentialLifecycleError(404, 'CREDENTIAL_NOT_FOUND', 'Credential not found'); });
  stub(notificationEndpointService, 'remove', async (id) => { pgUuid(id); return false; });
  stub(appearanceService, 'getAssetByIdForRoot', async (id) => { pgUuid(id); return null; });
});
afterAll(() => jest.restoreAllMocks());

async function send(family: Family, route: string, param: string, value: string, authorized = true, suppliedBody?: unknown) {
  const [method, template] = route.split(' ');
  const path = template.replace(/:([A-Za-z]+)/g, (_match, name) => name === param ? value : name === 'version' ? '1' : ID);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { scopes: authorized ? ['root'] : ['tasks:read'], userId: 'census', authMethod: 'principal_api_key',
      // Project guards are measured without the separate account-owner arm.
      ...(family.mount === '/projects' || (!authorized && template.endsWith('/reveal')) ? {} : { principal: { id: ID, kind: 'service', role: 'agent', handle: 'census' } }),
    }); next();
  });
  app.use(family.mount, sharedAuthorizationMiddleware, family.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const body = template.endsWith('/scim-client') && method === 'PUT' ? { principalId: ID }
      : template.endsWith('/login-groups') && method === 'POST' ? { groupId: ID }
        : template.endsWith('/skills/:skillId') && method === 'PUT' ? { version: 1 } : {};
    const response = await fetch(`http://127.0.0.1:${port}${family.mount}${path}`, { method,
      headers: { 'Content-Type': 'application/json' }, ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(suppliedBody ?? body) }) });
    const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : {} };
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

describe.each(Object.entries(FAMILIES))('%s mocked route census', (name, family) => {
  it('table equals every parameterised route in the production router', () => {
    const stack = family.router.stack.filter((layer: any) => layer.route && layer.route.path.includes(':'))
      .flatMap((layer: any) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`));
    expect(stack.sort()).toEqual([...family.routes, ...family.excluded ?? []].sort());
  });
  for (const route of family.routes) for (const [param, code] of Object.entries(family.guarded).filter(([param]) => route.includes(`:${param}`))) {
    describe(`${route} :${param}`, () => {
      it.each(param === 'version' ? ['latest', '-1', '2147483648', '99999999999'] : BAD)('malformed %p is refused before addressed-object reads', async (bad) => {
        const answer = await send(family, route, param, bad);
        expect([answer.status, answer.body.code]).toEqual([400, code]);
        // Parent Project authorization is allowed; no handler/service reads.
        expect(reads.flatMap((spy) => spy.mock.calls)).toEqual([]);
        if (name === 'services') expect(authorizationRepository.authorizePoint).not.toHaveBeenCalled();
      });
      it('route-specific authority order remains first', async () => {
        // Brief's route ceiling is authenticated; owner writes may admit
        // only by reading the Project. Their pre-read answer is shape refusal.
        // Card 41e24358: the default Verifier route's ceiling is authenticated
        // too (its gate is in the handler), so its pre-read answer is the shape refusal.
        const expected = name === 'projects' && ['POST /:id/brief', 'PUT /:id/owner', 'PUT /:id/default-verifier'].includes(route) ? 400 : 403;
        expect((await send(family, route, param, 'not-a-uuid', false)).status).toBe(expected);
      });
      if (param !== 'version') {
        it('uppercase UUID passes shape validation and remains an absent-object 404', async () => {
          expect((await send(family, route, param, ID.toUpperCase())).status).toBe(404);
        });
        it('unknown UUID retains 404', async () => {
          expect((await send(family, route, param, UNKNOWN)).status).toBe(404);
        });
      }
    });
  }
});

describe('credential rotation denial pre-read guard', () => {
  it.each(BAD)('malformed %p preserves exact-copy 422 without a credential read', async (bad) => {
    const answer = await send(FAMILIES.credentials, 'POST /:id/rotate', 'id', bad, true, { scopes: [] });
    expect([answer.status, answer.body.code]).toEqual([422, 'ROTATION_IS_EXACT_COPY']);
    expect(principalService.getCredentialWithPrincipal).not.toHaveBeenCalled();
    expect(auditService.record).toHaveBeenCalledTimes(1);
  });
});
