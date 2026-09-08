/**
 * registryOwnerRoute.test.ts — RH-P3.AZ-S3 round-6 (review 6c7d68d2 B1):
 * the owner-targeted Connector registration THROUGH THE PRODUCTION REST
 * ROUTE. A root caller posting {kind:'connector', ownerAccountId} must
 * persist the Connector principal under the NAMED Account — the exact
 * value-drop the round-5 regression hid from service-level tests — and a
 * non-root caller naming a foreign owner refuses 403 before any write.
 */
import express from 'express';
import http from 'http';

const db = {
  queries: [] as Array<{ text: string; params?: unknown[] }>,
  script: [] as Array<(text: string, params?: unknown[]) => { rows: any[] } | null>,
};
function scripted(text: string, params?: unknown[]): { rows: any[] } {
  db.queries.push({ text, params });
  for (const handler of db.script) {
    const result = handler(text, params);
    if (result) return result;
  }
  return { rows: [] };
}
jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(async (text: string, params?: unknown[]) => scripted(text, params)),
    connect: jest.fn(async () => ({
      query: jest.fn(async (text: string, params?: unknown[]) => scripted(text, params)),
      release: jest.fn(),
    })),
  },
}));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn(async () => ({})) } }));
jest.mock('../services/PrincipalService', () => {
  const actual = jest.requireActual('../services/PrincipalService');
  return {
    ...actual,
    principalService: {
      invalidatePrincipals: jest.fn(),
      getPrincipalById: jest.fn(),
      getPrincipalByHandle: jest.fn(),
    },
  };
});

import servicesRouter from '../routes/services';

const ROOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NAMED_ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONNECTOR_PRINCIPAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const identity = { principalId: ROOT_ID, scopes: ['root'] as string[] };

let server: http.Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).principal = { id: identity.principalId, handle: 'caller' };
    (req as any).userId = 'caller';
    (req as any).scopes = identity.scopes;
    next();
  });
  app.use('/services', servicesRouter);
  server = app.listen(0, () => {
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => {
  jest.clearAllMocks();
  db.queries.length = 0;
  db.script.length = 0;
  identity.principalId = ROOT_ID;
  identity.scopes = ['root'];
});

function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const serviceRow = () => ({
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', slug: 'route-conn', name: 'Route conn', description: '',
  kind: 'connector', runtime_mode: 'direct', status: 'draft', visibility_tier: 'assigned-only',
  delivery_mode: 'none', delivery_endpoint: null, delivery_poll_interval_seconds: null,
  telemetry_tier: 'none', current_descriptor_version: null, revision: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  principal_id: CONNECTOR_PRINCIPAL, created_by_principal_id: ROOT_ID, updated_by_principal_id: ROOT_ID,
  created_at: 'now', updated_at: 'now', retired_at: null,
});

describe('owner-targeted Connector registration through the production route (B1)', () => {
  it('a ROOT caller registering for a NAMED Account persists the Connector under that Account', async () => {
    db.script.push((text, params) => /SELECT id, kind, status, parent_principal_id, legacy_identity FROM principals/.test(text)
      ? { rows: params?.[0] === NAMED_ACCOUNT
          ? [{ id: NAMED_ACCOUNT, kind: 'service', status: 'active', parent_principal_id: null, legacy_identity: false }]
          : [] } : null);
    db.script.push((text) => /INSERT INTO principals/.test(text) ? { rows: [{ id: CONNECTOR_PRINCIPAL }] } : null);
    db.script.push((text) => /INSERT INTO services/.test(text) ? { rows: [serviceRow()] } : null);

    const { status } = await post('/services', {
      slug: 'route-conn', name: 'Route conn', kind: 'connector', ownerAccountId: NAMED_ACCOUNT,
    });
    expect(status).toBe(201);
    // The owner lookup ran against the NAMED Account…
    const ownerLookup = db.queries.find((q) => /SELECT id, kind, status, parent_principal_id, legacy_identity FROM principals/.test(q.text))!;
    expect(ownerLookup.params?.[0]).toBe(NAMED_ACCOUNT);
    // …and the persisted Connector principal parents to it, not the caller.
    const principalInsert = db.queries.find((q) => /INSERT INTO principals/.test(q.text))!;
    expect(principalInsert.params).toContain(NAMED_ACCOUNT);
    expect(principalInsert.params).not.toContain(ROOT_ID);
  });

  it('a NON-root caller naming a foreign owner refuses 403 before any write', async () => {
    identity.principalId = CONNECTOR_PRINCIPAL;
    identity.scopes = ['services:write'];
    const { status, json } = await post('/services', {
      slug: 'route-conn2', name: 'X', kind: 'connector', ownerAccountId: NAMED_ACCOUNT,
    });
    expect(status).toBe(403);
    expect(json.code).toBe('OWNER_OUT_OF_SUBTREE');
    expect(db.queries.some((q) => /INSERT INTO/.test(q.text))).toBe(false);
  });
});
