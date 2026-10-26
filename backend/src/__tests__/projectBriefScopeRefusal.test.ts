/**
 * POST /projects/:id/brief answers a missing-scope refusal with the scopes it
 * found missing as data (card fbeb86f1, owner ruling D6).
 *
 * Project awareness is the handler that checks projects:read and tasks:read
 * itself, after the route ceiling (tasks:read) has let the request in. This
 * mounts the PRODUCTION projects router over a real HTTP listener and uses the
 * REAL awareness service: the refusal is raised before any row is read, so the
 * mocked pool is never touched, and the body that comes back is what a REST
 * client and the MCP layer (errorFromRest) actually see.
 */
jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import express from 'express';
import http from 'http';
import { pool } from '../db/connection';
import projectsRouter from '../routes/projects';
import { projectAwarenessService } from '../services/ProjectAwarenessService';
import { ResourceContractError } from '../services/ProjectResourceService';

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEXT = 'Project awareness requires projects:read and tasks:read';

let server: http.Server;
let baseUrl = '';
let heldScopes: string[] | null = ['tasks:read'];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // The real server installs the guard chain before this router. This
    // harness supplies only what the awareness handler itself reads.
    (req as any).scopes = heldScopes;
    next();
  });
  app.use('/projects', projectsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  heldScopes = ['tasks:read'];
});

afterEach(() => jest.restoreAllMocks());

async function brief(): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/projects/${PROJECT}/brief`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  return { status: response.status, body: await response.json() };
}

describe('POST /projects/:id/brief scope refusal', () => {
  it('keeps the code and text and adds details.requiredScopes for the scope that is absent', async () => {
    const { status, body } = await brief();
    expect(status).toBe(403);
    expect(body).toEqual({
      success: false, error: TEXT, code: 'INSUFFICIENT_SCOPE', message: TEXT,
      details: { requiredScopes: ['projects:read'] },
    });
    // Nothing was read before the refusal.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('names both when neither is held, and never what the credential holds', async () => {
    heldScopes = ['principals:read', 'reports:read'];
    const { status, body } = await brief();
    expect(status).toBe(403);
    expect(body.details).toEqual({ requiredScopes: ['projects:read', 'tasks:read'] });
    expect(JSON.stringify(body)).not.toMatch(/principals:read|reports:read/);
  });

  it('adds nothing to a refusal that is not about a scope', async () => {
    jest.spyOn(projectAwarenessService, 'compile')
      .mockRejectedValue(new ResourceContractError(404, 'PROJECT_NOT_FOUND', 'Project not found'));
    const { status, body } = await brief();
    expect(status).toBe(404);
    expect(body).toEqual({
      success: false, error: 'Project not found', code: 'PROJECT_NOT_FOUND', message: 'Project not found',
    });
    expect(body.details).toBeUndefined();
  });

  it('keeps the field detail exactly as it was', async () => {
    jest.spyOn(projectAwarenessService, 'compile')
      .mockRejectedValue(new ResourceContractError(422, 'RESOURCE_INVALID', 'Invalid', 'name'));
    const { body } = await brief();
    expect(body.details).toEqual({ field: 'name' });
  });
});
