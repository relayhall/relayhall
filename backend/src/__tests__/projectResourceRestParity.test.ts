/**
 * REST surface parity for the canonical Project Resource contract
 * (task 47ef04a2; contract 21a04c23 §3): canonical routes are mounted with
 * revision/idempotency header mechanics, strict query handling, and every
 * legacy writer fails closed with LEGACY_COMPATIBILITY_ONLY naming its
 * replacement — no hidden translation, no legacy mutation.
 */
import express from 'express';
import http from 'http';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../services/ProjectService', () => ({
  projectService: {
    getById: jest.fn(async (id: string) => ({ id, name: 'Fixture', status: 'active', links: [] })),
    update: jest.fn(async (id: string) => ({ id, name: 'Fixture', status: 'active' })),
    list: jest.fn(async () => []),
  },
}));

import { pool } from '../db/connection';
import projectsRouter from '../routes/projects';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESOURCE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REVISION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let server: http.Server;
let baseUrl: string;
let mutationLog: string[];

function armPool(): void {
  mutationLog = [];
  const resourceRow = {
    id: RESOURCE_ID, project_id: PROJECT_ID, kind: 'reference', name: 'docs',
    normalized_name: 'docs', description: null, state: 'active',
    agent_visibility: 'hidden', export_policy: 'installation-only',
    details: { url: 'https://d.example.test', category: 'documentation' },
    revision: REVISION, archived_at: null, created_at: 'now', updated_at: 'now',
  };
  const query = async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.startsWith('SELECT id, name, status FROM projects')) return { rows: [{ id: params[0], name: 'Fixture', status: 'active' }] };
    if (sql.startsWith('SELECT id, status FROM projects')) return { rows: [{ id: params[0], status: 'active' }] };
    if (sql.startsWith('SELECT id FROM projects')) return { rows: [{ id: params[0] }] };
    if (sql.startsWith('SELECT * FROM project_resource_replacements')) return { rows: [] };
    if (sql.startsWith('SELECT * FROM project_resources WHERE id = $1')) {
      return { rows: params[0] === RESOURCE_ID ? [resourceRow] : [] };
    }
    if (sql.startsWith('SELECT * FROM project_resources WHERE project_id')) return { rows: [resourceRow] };
    if (sql.startsWith('SELECT * FROM project_resources')) return { rows: [resourceRow] };
    if (sql.startsWith('UPDATE project_resources') || sql.startsWith('INSERT INTO project_resource')) {
      mutationLog.push(sql.slice(0, 40));
      return { rows: [{ ...resourceRow, revision: 'new-revision' }] };
    }
    if (sql.startsWith('SELECT source_surface')) return { rows: [] };
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
  armPool();
});

async function call(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined || method === 'GET' || method === 'HEAD'
      ? undefined
      : JSON.stringify(options.body),
  });
  const json: any = await response.json().catch(() => null);
  return { status: response.status, json };
}

describe('legacy writers fail closed with LEGACY_COMPATIBILITY_ONLY', () => {
  const legacyCalls: Array<[string, string]> = [
    ['PATCH', `/projects/${PROJECT_ID}/resources`],
    ['PUT', `/projects/${PROJECT_ID}/resources`],
    ['GET', `/projects/${PROJECT_ID}/tool-instructions`],
    ['PATCH', `/projects/${PROJECT_ID}/tool-instructions`],
    ['PUT', `/projects/${PROJECT_ID}/tool-instructions`],
    ['POST', `/projects/${PROJECT_ID}/links`],
    ['PUT', `/projects/${PROJECT_ID}/links/${RESOURCE_ID}`],
    ['DELETE', `/projects/${PROJECT_ID}/links/${RESOURCE_ID}`],
    ['PUT', `/projects/${PROJECT_ID}/tools`],
    // A14.3 hard cut: the live project↔registry read moved to /skills; the
    // retired read path answers like the other compatibility surfaces.
    ['GET', `/projects/${PROJECT_ID}/tools`],
  ];
  for (const [method, path] of legacyCalls) {
    it(`${method} ${path.replace(PROJECT_ID, ':id').replace(RESOURCE_ID, ':child')}`, async () => {
      const result = await call(method, path, { body: {} });
      expect(result.status).toBe(409);
      expect(result.json.code).toBe('LEGACY_COMPATIBILITY_ONLY');
      expect(result.json.suggestion).toBeTruthy();
      expect(mutationLog).toHaveLength(0);
    });
  }

  it('PATCH /projects/:id with sourceDir/nfsDir is compatibility-held', async () => {
    for (const body of [{ sourceDir: '/srv/x' }, { nfsDir: '/mnt/x' }]) {
      const result = await call('PATCH', `/projects/${PROJECT_ID}`, { body });
      expect(result.status).toBe(409);
      expect(result.json.code).toBe('LEGACY_COMPATIBILITY_ONLY');
    }
  });
});

describe('canonical route mechanics', () => {
  it('GET list returns the canonical typed shape', async () => {
    const result = await call('GET', `/projects/${PROJECT_ID}/resources`);
    expect(result.status).toBe(200);
    expect(Array.isArray(result.json.resources)).toBe(true);
    expect(result.json.resources[0]).toMatchObject({
      id: RESOURCE_ID, kind: 'reference', state: 'active',
      agentVisibility: 'hidden', exportPolicy: 'installation-only', revision: REVISION,
    });
    expect(result.json).toHaveProperty('nextCursor');
  });

  it('unknown query keys fail closed', async () => {
    const result = await call('GET', `/projects/${PROJECT_ID}/resources?includeHidden=true`);
    expect(result.status).toBe(400);
    expect(result.json.code).toBe('UNKNOWN_FIELD');
  });

  it('duplicate query values fail closed', async () => {
    const result = await call('GET', `/projects/${PROJECT_ID}/resources?kind=repository&kind=reference`);
    expect(result.status).toBe(400);
    expect(result.json.code).toBe('INVALID_QUERY_VALUE');
  });

  it('boolean-as-number is rejected for includeArchived', async () => {
    const result = await call('GET', `/projects/${PROJECT_ID}/resources?includeArchived=1`);
    expect(result.status).toBe(400);
    expect(result.json.code).toBe('INVALID_QUERY_VALUE');
  });

  it('PATCH without If-Match is REVISION_REQUIRED', async () => {
    const result = await call('PATCH', `/projects/${PROJECT_ID}/resources/${RESOURCE_ID}`, { body: { name: 'x' } });
    expect(result.status).toBe(400);
    expect(result.json.code).toBe('REVISION_REQUIRED');
    expect(mutationLog).toHaveLength(0);
  });

  it('PATCH accepts the RFC 7232 quoted If-Match form', async () => {
    const result = await call('PATCH', `/projects/${PROJECT_ID}/resources/${RESOURCE_ID}`, {
      body: { name: 'renamed' },
      headers: { 'If-Match': `"${REVISION}"` },
    });
    expect(result.status).toBe(200);
    expect(result.json.resource.revision).toBe('new-revision');
  });

  it('PATCH with kind in the body points to /replace', async () => {
    const result = await call('PATCH', `/projects/${PROJECT_ID}/resources/${RESOURCE_ID}`, {
      body: { kind: 'workspace' },
      headers: { 'If-Match': REVISION },
    });
    expect(result.status).toBe(422);
    expect(result.json.message).toContain('replace');
    expect(mutationLog).toHaveLength(0);
  });

  it('replace without Idempotency-Key is IDEMPOTENCY_KEY_REQUIRED', async () => {
    const result = await call('POST', `/projects/${PROJECT_ID}/resources/${RESOURCE_ID}/replace`, {
      body: { kind: 'environment', name: 'docs', details: { url: 'https://e.example.test', stage: 'development' } },
      headers: { 'If-Match': REVISION },
    });
    expect(result.status).toBe(400);
    expect(result.json.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(mutationLog).toHaveLength(0);
  });

  it('replace succeeds with paired result and 201', async () => {
    const result = await call('POST', `/projects/${PROJECT_ID}/resources/${RESOURCE_ID}/replace`, {
      body: { kind: 'environment', name: 'docs', details: { url: 'https://e.example.test', stage: 'development' } },
      headers: { 'If-Match': REVISION, 'Idempotency-Key': 'route-parity-key-0123456789' }, // gitleaks:allow — synthetic idempotency fixture
    });
    expect(result.status).toBe(201);
    expect(result.json.replacement).toBeTruthy();
    expect(result.json.replaced).toBeTruthy();
    expect(result.json.requestId).toBeTruthy();
  });

  it('unknown body fields fail closed on create', async () => {
    const result = await call('POST', `/projects/${PROJECT_ID}/resources`, {
      body: { kind: 'reference', name: 'x', notebook: true, details: { url: 'https://d.example.test', category: 'other' } },
    });
    expect(result.status).toBe(400);
    expect(result.json.code).toBe('UNKNOWN_FIELD');
    expect(mutationLog).toHaveLength(0);
  });

  it('resource archive/restore refuse bodies and query parameters with zero mutation (review a4ff69b7 finding 2)', async () => {
    for (const action of ['archive', 'restore']) {
      const withBody = await call('POST', `/projects/${PROJECT_ID}/resources/${RESOURCE_ID}/${action}`, {
        body: { unexpectedPrivateField: 'discarded' },
        headers: { 'If-Match': REVISION },
      });
      expect(withBody.status).toBe(400);
      expect(withBody.json.code).toBe('UNKNOWN_FIELD');

      const withQuery = await call('POST', `/projects/${PROJECT_ID}/resources/${RESOURCE_ID}/${action}?unexpected=true`, {
        headers: { 'If-Match': REVISION },
      });
      expect(withQuery.status).toBe(400);
      expect(withQuery.json.code).toBe('UNKNOWN_FIELD');
    }
    expect(mutationLog).toHaveLength(0);
  });

  it('an invalid body against an absent project is a concealed 404, never a 422 (review 73df8efe finding 5)', async () => {
    const absent = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    (pool.query as jest.Mock).mockImplementation(async (text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM projects')) return { rows: [] }; // project absent/denied
      throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
    });
    (pool.connect as jest.Mock).mockResolvedValue({
      query: (pool.query as unknown) as (t: string, p?: any[]) => Promise<any>,
      release: jest.fn(),
    });
    const result = await call('POST', `/projects/${absent}/resources`, {
      body: { kind: 'notebook', name: 'x', details: { junk: true } },
    });
    expect(result.status).toBe(404);
    expect(result.json.code).toBe('PROJECT_NOT_FOUND');
  });

  it('context endpoint rejects query parameters (the legacy role/taskId surface is gone)', async () => {
    const result = await call('GET', `/projects/${PROJECT_ID}/context?role=agent`);
    expect(result.status).toBe(400);
    expect(result.json.code).toBe('UNKNOWN_FIELD');
  });
});
