import express from 'express';
import http from 'http';

jest.mock('../services/ProjectOwnershipService', () => ({
  projectOwnershipService: { access: jest.fn(), candidates: jest.fn(), change: jest.fn() },
}));
jest.mock('../middleware/sharedAuthorization', () => ({
  actorFromRequest: jest.fn(() => ({ authenticated: true, principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'admin', scopes: ['root'] })),
  authorizedTaskNarrowing: jest.fn(),
  filterAuthorizedResources: jest.fn(),
  authorizedProjectTarget: jest.fn(),
}));

import projectsRouter from '../routes/projects';
import { projectOwnershipService } from '../services/ProjectOwnershipService';
import { buildOpenApiSpec } from '../openapi/spec';

const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let server: http.Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).authMethod = 'session';
    (req as any).principal = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', handle: 'admin' };
    next();
  });
  app.use('/projects', projectsRouter);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => jest.clearAllMocks());

async function put(body: unknown, revision = 'rev-1') {
  return fetch(`${origin}/projects/${id}/owner`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': revision },
    body: JSON.stringify(body),
  });
}

test.each([
  [{ ownerPrincipalId: [id] }, 'array'],
  [{ ownerPrincipalId: { id } }, 'object'],
  [{ ownerPrincipalId: 1 }, 'number'],
  [{ ownerPrincipalId: null, role: 'admin' }, 'extra field'],
  [[], 'array body'],
])('owner route refuses malformed %s without invoking mutation', async (body, _label) => {
  const response = await put(body);
  expect(response.status).toBe(422);
  expect(((await response.json()) as any).code).toBe('INVALID_OWNER');
  expect(projectOwnershipService.change).not.toHaveBeenCalled();
});

test('owner route accepts explicit null with If-Match and server-derived actor', async () => {
  (projectOwnershipService.change as jest.Mock).mockResolvedValue({ id, ownerPrincipalId: null, revision: 'rev-2' });
  const response = await put({ ownerPrincipalId: null });
  expect(response.status).toBe(200);
  expect(((await response.json()) as any).project.ownerPrincipalId).toBeNull();
  expect(projectOwnershipService.change).toHaveBeenCalledWith(id, null, 'rev-1', expect.objectContaining({ authMethod: 'session' }));
});

test('unexpected lookup failure emits fixed 503 without hostile error properties', async () => {
  const secret = 'postgresql://private-user:private-password@private-host';
  (projectOwnershipService.change as jest.Mock).mockRejectedValue(Object.assign(new Error(secret), {
    code: 'PRIVATE_CODE', details: { secret }, stack: secret,
  }));
  const response = await put({ ownerPrincipalId: null });
  const text = await response.text();
  expect(response.status).toBe(503);
  expect(text).toContain('OWNER_CHANGE_UNAVAILABLE');
  expect(text).not.toContain(secret);
  expect(text).not.toContain('PRIVATE_CODE');
});

test('OpenAPI declares every owner path parameter and requires nullable owner body', () => {
  const paths = (buildOpenApiSpec() as any).paths;
  for (const [path, method] of [['/projects/{id}/owner', 'put'], ['/projects/{id}/owner-access', 'get'], ['/projects/{id}/owner-candidates', 'get']]) {
    expect(paths[path][method].parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path', required: true })]));
  }
  const put = paths['/projects/{id}/owner'].put;
  expect(put.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'If-Match', required: true })]));
  expect(put.requestBody.content['application/json'].schema.required).toEqual(['ownerPrincipalId']);
});
