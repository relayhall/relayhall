/**
 * Charter REST surface (task f2735f1b): route mechanics over the service —
 * strict query/body allowlists, If-Match plumbing, status codes (201 create /
 * 200 replace), stable error envelopes — plus the scope-map posture: reading
 * the authority index is projects:read, WRITING it is owner-plane (the root
 * sentinel), deliberately not the mintable projects:write.
 */
import express from 'express';
import http from 'http';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import projectsRouter from '../routes/projects';
import { requiredScopeFor } from '../utils/scopeMap';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHARTER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REVISION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let server: http.Server;
let baseUrl: string;
let projectStatus: string;
let head: any | null;

function charterRow(): any {
  return {
    id: CHARTER_ID, project_id: PROJECT_ID, content: '# Charter', content_hash: 'h',
    version: 1, revision: REVISION, updated_by_principal_id: 'owner',
    created_at: 'now', updated_at: 'now',
  };
}

function armPool(): void {
  const query = async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.startsWith('SELECT id, status FROM projects')) return { rows: [{ id: params[0], status: projectStatus }] };
    if (sql.startsWith('SELECT id FROM projects')) return { rows: [{ id: params[0] }] };
    if (sql.startsWith('SELECT * FROM project_charters')) return { rows: head ? [head] : [] };
    if (sql.startsWith('INSERT INTO project_charters')) {
      head = { ...charterRow(), content: params[1], content_hash: params[2] };
      return { rows: [head] };
    }
    if (sql.startsWith('INSERT INTO project_charter_versions')) return { rows: [] };
    if (sql.startsWith('UPDATE project_charters')) {
      head = { ...charterRow(), content: params[1], version: params[3], revision: 'rotated' };
      return { rows: [head] };
    }
    if (sql.startsWith('SELECT version, content_hash')) return { rows: [{ version: 1, content_hash: 'h', actor_principal_id: 'owner', created_at: 'now' }] };
    if (sql.startsWith('SELECT version, content,')) {
      return { rows: params[1] === 1 ? [{ version: 1, content: '# Charter', content_hash: 'h', actor_principal_id: 'owner', created_at: 'now' }] : [] };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
  };
  (pool.query as jest.Mock).mockImplementation(query);
  (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/projects', projectsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  projectStatus = 'active';
  head = null;
  armPool();
});

async function call(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined || method === 'GET' ? undefined : JSON.stringify(options.body),
  });
  const json: any = await response.json().catch(() => null);
  return { status: response.status, json };
}

describe('scope posture', () => {
  it('reads are projects:read; writes are owner-plane (root), not projects:write', () => {
    expect(requiredScopeFor('GET', `/projects/${PROJECT_ID}/charter`)).toBe('projects:read');
    expect(requiredScopeFor('GET', `/projects/${PROJECT_ID}/charter/versions`)).toBe('projects:read');
    expect(requiredScopeFor('GET', `/projects/${PROJECT_ID}/charter/versions/2`)).toBe('projects:read');
    expect(requiredScopeFor('PUT', `/projects/${PROJECT_ID}/charter`)).toBe('root');
    expect(requiredScopeFor('POST', `/projects/${PROJECT_ID}/charter`)).toBe('root');
    expect(requiredScopeFor('DELETE', `/projects/${PROJECT_ID}/charter`)).toBe('root');
  });
});

describe('GET /projects/:id/charter', () => {
  it('404 CHARTER_NOT_FOUND when unchartered', async () => {
    const r = await call('GET', `/projects/${PROJECT_ID}/charter`);
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('CHARTER_NOT_FOUND');
  });

  it('returns the head and rejects unknown query keys', async () => {
    head = charterRow();
    const ok = await call('GET', `/projects/${PROJECT_ID}/charter`);
    expect(ok.status).toBe(200);
    expect(ok.json.charter.version).toBe(1);
    expect(ok.json.charter.revision).toBe(REVISION);
    const bad = await call('GET', `/projects/${PROJECT_ID}/charter?verbose=1`);
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('UNKNOWN_FIELD');
  });
});

describe('PUT /projects/:id/charter', () => {
  it('creates with 201 and no If-Match', async () => {
    const r = await call('PUT', `/projects/${PROJECT_ID}/charter`, { body: { content: '# New' } });
    expect(r.status).toBe(201);
    expect(r.json.created).toBe(true);
    expect(r.json.charter.content).toBe('# New');
  });

  it('replace without If-Match is 400 REVISION_REQUIRED; stale is 412', async () => {
    head = charterRow();
    const missing = await call('PUT', `/projects/${PROJECT_ID}/charter`, { body: { content: '# v2' } });
    expect(missing.status).toBe(400);
    expect(missing.json.code).toBe('REVISION_REQUIRED');
    const stale = await call('PUT', `/projects/${PROJECT_ID}/charter`, { body: { content: '# v2' }, headers: { 'If-Match': 'stale' } });
    expect(stale.status).toBe(412);
    expect(stale.json.code).toBe('REVISION_MISMATCH');
  });

  it('replace with the observed revision returns 200 and the bumped head', async () => {
    head = charterRow();
    const r = await call('PUT', `/projects/${PROJECT_ID}/charter`, { body: { content: '# v2' }, headers: { 'If-Match': `"${REVISION}"` } });
    expect(r.status).toBe(200);
    expect(r.json.created).toBe(false);
    expect(r.json.changed).toBe(true);
    expect(r.json.charter.version).toBe(2);
  });

  it('rejects unknown body fields before the service runs', async () => {
    const r = await call('PUT', `/projects/${PROJECT_ID}/charter`, { body: { content: '# x', pinned: true } });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('UNKNOWN_FIELD');
  });

  it('archived Project refuses the write with 409', async () => {
    projectStatus = 'archived';
    const r = await call('PUT', `/projects/${PROJECT_ID}/charter`, { body: { content: '# x' } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('PROJECT_ARCHIVED');
  });
});

describe('versions', () => {
  it('lists metadata and serves one version with content', async () => {
    head = charterRow();
    const list = await call('GET', `/projects/${PROJECT_ID}/charter/versions`);
    expect(list.status).toBe(200);
    expect(list.json.versions[0].version).toBe(1);
    expect(list.json.versions[0].content).toBeUndefined();
    const one = await call('GET', `/projects/${PROJECT_ID}/charter/versions/1`);
    expect(one.status).toBe(200);
    expect(one.json.version.content).toBe('# Charter');
    const missing = await call('GET', `/projects/${PROJECT_ID}/charter/versions/9`);
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe('CHARTER_VERSION_NOT_FOUND');
    const invalid = await call('GET', `/projects/${PROJECT_ID}/charter/versions/abc`);
    expect(invalid.status).toBe(400);
    expect(invalid.json.code).toBe('INVALID_QUERY_VALUE');
  });
});
