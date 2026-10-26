import express from 'express';
import type { AddressInfo } from 'net';
import { requiredScopeFor, isMintableScope } from '../utils/scopeMap';
import { metricsConfig, opaqueProjectRef, renderCoreMetrics } from '../services/ProductMetricsService';

const scoped = { value: ['metrics:read'] };
jest.mock('../db/connection', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../services/PrincipalService', () => {
  const actual = jest.requireActual('../services/PrincipalService');
  const stub = Object.create(Object.getPrototypeOf(actual.principalService));
  Object.assign(stub, actual.principalService, {
    authenticatePrincipalKey: jest.fn(async (parts: any) => parts.keyId === 'aaaaaaaaaaaa' ? {
      principal: { id: '00000000-0000-4000-8000-000000000001', handle: 'collector', kind: 'service', status: 'active', legacyIdentity: true },
      credential: { id: 'credential', scopes: scoped.value, transport: 'api' },
    } : undefined), bumpCredentialLastUsed: jest.fn(), isLegacyEnvKeyRevoked: jest.fn(async () => false),
  });
  return { ...actual, principalService: stub };
});
import { authMiddleware } from '../middleware/auth';
import { sharedAuthorizationMiddleware } from '../middleware/sharedAuthorization';
import metricsRouter from '../routes/metrics';
import { productMetricsService } from '../services/ProductMetricsService';

const key = 'rh_dev_aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const config = { projectLimit: 1, labelKey: 'test-only-stable-label-key-0123456789' };
test('metrics scope is mintable and gates only the exact GET surface', () => {
  expect(isMintableScope('metrics:read')).toBe(true);
  expect(requiredScopeFor('GET', '/metrics/')).toBe('metrics:read');
  for (const method of ['POST', 'PATCH', 'DELETE', 'HEAD']) expect(requiredScopeFor(method, '/metrics')).toBe('root');
  expect(requiredScopeFor('GET', '/metrics/other')).toBe('root');
});
test('cap configuration fails closed and the default is 200 projects', () => {
  expect(metricsConfig({ RELAYHALL_METRICS_LABEL_KEY: config.labelKey }).projectLimit).toBe(200);
  for (const bad of ['0', '-1', '1.5', 'garbage', '10001']) expect(() => metricsConfig({ RELAYHALL_METRICS_LABEL_KEY: config.labelKey, RELAYHALL_METRICS_PROJECT_LIMIT: bad })).toThrow();
  expect(() => metricsConfig({})).toThrow();
});
test('bounded detail preserves complete aggregate and declares unavailable sources without fictional numbers', () => {
  const text = renderCoreMetrics({ accountId: 'owner-id', projectCount: 3, observedAt: 1000,
    projects: [{ project_id: 'secret-project-id', status: 'todo', value: '2' }],
    totals: [{ status: 'todo', value: '9' }, { status: 'completed', value: 3 }] }, config);
  expect(text).toContain('relayhall_tasks_aggregate{status="todo"} 9');
  expect(text).toContain('relayhall_metrics_truncated{family="projects"} 1');
  expect(text).toContain('relayhall_metrics_omitted_projects 2');
  expect(text).toContain('relayhall_metrics_source_available{source="governor"} 0');
  expect(text).not.toMatch(/owner-id|secret-project-id|relayhall_governor_ceiling|_total/);
  expect(text.endsWith('\n')).toBe(true);
  const samples = text.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(' ')[0]);
  expect(new Set(samples).size).toBe(samples.length);
  expect(opaqueProjectRef('owner-id', 'project', config.labelKey)).toBe(opaqueProjectRef('owner-id', 'project', config.labelKey));
  expect(opaqueProjectRef('owner-id', 'project', config.labelKey)).not.toBe(opaqueProjectRef('foreign-id', 'project', config.labelKey));
});
test('unsafe or negative source counts refuse the whole scrape', () => {
  for (const value of [-1, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => renderCoreMetrics({ accountId: 'owner', projectCount: value, observedAt: 1, projects: [], totals: [] }, config)).toThrow();
});

describe('production ingress authentication and route ceiling', () => {
  let server: ReturnType<typeof express.application.listen>, base: string;
  const scrape = jest.spyOn(productMetricsService, 'scrape');
  beforeAll(done => {
    process.env.RELAYHALL_METRICS_LABEL_KEY = config.labelKey;
    const app = express(); app.use('/metrics', authMiddleware, sharedAuthorizationMiddleware, metricsRouter);
    server = app.listen(0, () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; done(); });
  });
  afterAll(done => { delete process.env.RELAYHALL_METRICS_LABEL_KEY; server.close(() => done()); });
  beforeEach(() => { scoped.value = ['metrics:read']; scrape.mockReset().mockResolvedValue('# TYPE relayhall_projects gauge\nrelayhall_projects 1\n'); });
  test('anonymous and wrong scope refuse before data access', async () => {
    expect((await fetch(base + '/metrics')).status).toBe(401);
    scoped.value = ['tasks:read'];
    expect((await fetch(base + '/metrics', { headers: { authorization: 'Bearer ' + key } })).status).toBe(403);
    expect(scrape).not.toHaveBeenCalled();
  });
  test('the one authenticated scrape is text and a source failure is non-200', async () => {
    const options = { headers: { authorization: 'Bearer ' + key } };
    const good = await fetch(base + '/metrics', options);
    expect(good.status).toBe(200); expect(good.headers.get('content-type')).toContain('version=0.0.4');
    expect(good.headers.get('cache-control')).toBe('no-store');
    scrape.mockRejectedValueOnce(new Error('source unavailable'));
    expect((await fetch(base + '/metrics', options)).status).toBe(503);
    expect((await fetch(base + '/metrics?account=foreign', options)).status).toBe(400);
    expect((await fetch(base + '/metrics', { ...options, method: 'POST' })).status).toBeGreaterThanOrEqual(400);
    expect(scrape).toHaveBeenCalledTimes(2);
  });
});
