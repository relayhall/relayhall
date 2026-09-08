/**
 * Project lifecycle and revision parity (task 47ef04a2; review 6fd3b9e0
 * findings 1 and 2).
 *
 * Projects carry an opaque revision; every mutation is revision-bound
 * (If-Match), archived projects refuse every detail mutation except the
 * canonical restore, the default collection excludes archived projects, and
 * the owner-facing deletion surfaces are GONE.
 */
import express from 'express';
import http from 'http';

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import projectsRouter from '../routes/projects';

const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  revision: string;
  is_hidden: boolean;
  source_dir: string | null;
  nfs_dir: string | null;
  resources: null;
  tool_instructions: null;
  created_at: string;
  updated_at: string;
}

function makeRow(id: string, name: string, status: string, revision: string): ProjectRow {
  return {
    id, name, description: null, status, revision,
    is_hidden: false, source_dir: null, nfs_dir: null,
    resources: null, tool_instructions: null,
    created_at: '2026-08-08T00:00:00Z', updated_at: '2026-08-08T00:00:00Z',
  };
}

let projects: Map<string, ProjectRow>;
let revCounter: number;
let nameLocks: string[];

function armPool(): void {
  projects = new Map([
    [P1, makeRow(P1, 'Alpha', 'active', 'rev-p1')],
    [P2, makeRow(P2, 'Beta', 'archived', 'rev-p2')],
  ]);
  revCounter = 0;
  nameLocks = [];

  const query = async (text: string, params: any[] = []): Promise<any> => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('pg_advisory_xact_lock')) {
      nameLocks.push(String(params[0]));
      return { rows: [{ pg_advisory_xact_lock: null }] };
    }
    if (sql.startsWith('SELECT * FROM projects WHERE id = $1 FOR UPDATE')
      || sql.startsWith('SELECT * FROM projects WHERE id = $1')) {
      const row = projects.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith('SELECT * FROM projects')) {
      let rows = Array.from(projects.values());
      if (sql.includes(`status != 'archived'`)) rows = rows.filter((r) => r.status !== 'archived');
      if (sql.includes('status = $1')) rows = rows.filter((r) => r.status === params[0]);
      return { rows };
    }
    if (sql.startsWith(`SELECT id FROM projects WHERE status != 'archived' AND id != $1`)) {
      const [selfId, name] = params;
      const hit = Array.from(projects.values()).find(
        (r) => r.status !== 'archived' && r.id !== selfId && r.name.trim().toLowerCase() === String(name).trim().toLowerCase(),
      );
      return { rows: hit ? [{ id: hit.id }] : [] };
    }
    if (sql.startsWith(`SELECT id FROM projects WHERE status != 'archived'`)) {
      const [name] = params;
      const hit = Array.from(projects.values()).find(
        (r) => r.status !== 'archived' && r.name.trim().toLowerCase() === String(name).trim().toLowerCase(),
      );
      return { rows: hit ? [{ id: hit.id }] : [] };
    }
    if (sql.startsWith('UPDATE projects SET')) {
      const id = params[params.length - 1];
      const row = projects.get(id);
      if (!row) return { rows: [] };
      revCounter += 1;
      const updated = { ...row, revision: `rot-${revCounter}` };
      if (sql.includes(`status = 'archived'`)) updated.status = 'archived';
      else if (sql.includes(`status = 'active'`)) updated.status = 'active';
      else {
        // detail update: apply name/description/status by parameter order
        const assignments = sql.slice('UPDATE projects SET '.length, sql.indexOf(' WHERE')).split(', ');
        let index = 0;
        for (const assignment of assignments) {
          const [column] = assignment.split(' = ');
          if (assignment.includes('$')) {
            const value = params[index++];
            if (column === 'name') updated.name = value;
            if (column === 'description') updated.description = value;
            if (column === 'status') updated.status = value;
            if (column === 'is_hidden') updated.is_hidden = value;
          }
        }
      }
      projects.set(id, updated);
      return { rows: [updated] };
    }
    if (sql.startsWith('SELECT * FROM project_links')) return { rows: [] };
    if (sql.startsWith('SELECT * FROM project_resources')) return { rows: [] };
    if (sql.startsWith('SELECT id, name, status FROM projects')) {
      const row = projects.get(params[0]);
      return { rows: row ? [{ id: row.id, name: row.name, status: row.status }] : [] };
    }
    throw new Error(`fake db has no handler for: ${sql.slice(0, 90)}`);
  };
  (pool.query as jest.Mock).mockImplementation(query);
  (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // The production server installs the shared authorization middleware before
  // this router. This contract test mounts the router directly, so provide the
  // already-authorized deployment administrator actor the list adapter expects.
  app.use('/projects', (req: any, _res, next) => {
    req.authorizationActor = {
      principalId: '99999999-9999-4999-8999-999999999999',
      handle: 'dashboard_user',
      role: 'orchestrator',
      scopes: null,
      authenticated: true,
    };
    next();
  });
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
    body: options.body === undefined || method === 'GET' ? undefined : JSON.stringify(options.body),
  });
  const json: any = await response.json().catch(() => null);
  return { status: response.status, json };
}

describe('revision-bound project mutation', () => {
  it('reads include the opaque revision', async () => {
    const result = await call('GET', `/projects/${P1}`);
    expect(result.status).toBe(200);
    expect(result.json.project.revision).toBe('rev-p1');
  });

  it('PATCH without If-Match is REVISION_REQUIRED', async () => {
    const result = await call('PATCH', `/projects/${P1}`, { body: { description: 'x' } });
    expect(result.status).toBe(400);
    expect(result.json.code).toBe('REVISION_REQUIRED');
  });

  it('PATCH with a stale revision is 412 REVISION_MISMATCH', async () => {
    const result = await call('PATCH', `/projects/${P1}`, { body: { description: 'x' }, headers: { 'If-Match': 'stale' } });
    expect(result.status).toBe(412);
    expect(result.json.code).toBe('REVISION_MISMATCH');
  });

  it('PATCH with the exact revision succeeds and rotates it', async () => {
    const result = await call('PATCH', `/projects/${P1}`, { body: { description: 'x' }, headers: { 'If-Match': '"rev-p1"' } });
    expect(result.status).toBe(200);
    expect(result.json.project.revision).not.toBe('rev-p1');
  });

  it('PATCH may not archive; the archive route is canonical', async () => {
    const result = await call('PATCH', `/projects/${P1}`, { body: { status: 'archived' }, headers: { 'If-Match': 'rev-p1' } });
    expect(result.status).toBe(409);
    expect(result.json.code).toBe('PROJECT_ARCHIVED');
    expect(projects.get(P1)!.status).toBe('active');
  });

  it('renaming to an active project name is PROJECT_NAME_CONFLICT', async () => {
    // Restore Beta's name to active by trying to rename Alpha -> beta (case-insensitive vs archived Beta is fine; use a live collision instead)
    projects.set(P2, { ...projects.get(P2)!, status: 'active' });
    const result = await call('PATCH', `/projects/${P1}`, { body: { name: '  beta ' }, headers: { 'If-Match': 'rev-p1' } });
    expect(result.status).toBe(409);
    expect(result.json.code).toBe('PROJECT_NAME_CONFLICT');
  });
});

describe('archived-project immutability and canonical restore', () => {
  it('every detail PATCH on an archived project is 409 PROJECT_ARCHIVED', async () => {
    for (const body of [{ description: 'x' }, { name: 'NewName' }, { status: 'active' }]) {
      const result = await call('PATCH', `/projects/${P2}`, { body, headers: { 'If-Match': 'rev-p2' } });
      expect(result.status).toBe(409);
      expect(result.json.code).toBe('PROJECT_ARCHIVED');
    }
    expect(projects.get(P2)!.status).toBe('archived');
  });

  it('archive requires If-Match and rotates the revision', async () => {
    const missing = await call('POST', `/projects/${P1}/archive`, { body: {} });
    expect(missing.status).toBe(400);
    expect(missing.json.code).toBe('REVISION_REQUIRED');

    const ok = await call('POST', `/projects/${P1}/archive`, { body: {}, headers: { 'If-Match': 'rev-p1' } });
    expect(ok.status).toBe(200);
    expect(ok.json.project.status).toBe('archived');
  });

  it('unarchive requires the exact revision and rechecks name uniqueness', async () => {
    const stale = await call('POST', `/projects/${P2}/unarchive`, { body: {}, headers: { 'If-Match': 'nope' } });
    expect(stale.status).toBe(412);

    // An ACTIVE project already holds the name 'Beta' -> restore collides.
    projects.set(P1, { ...projects.get(P1)!, name: 'beta' });
    const collision = await call('POST', `/projects/${P2}/unarchive`, { body: {}, headers: { 'If-Match': 'rev-p2' } });
    expect(collision.status).toBe(409);
    expect(collision.json.code).toBe('PROJECT_NAME_CONFLICT');
    expect(projects.get(P2)!.status).toBe('archived');

    // Without the collision the restore succeeds.
    projects.set(P1, { ...projects.get(P1)!, name: 'Alpha' });
    const ok = await call('POST', `/projects/${P2}/unarchive`, { body: {}, headers: { 'If-Match': 'rev-p2' } });
    expect(ok.status).toBe(200);
    expect(ok.json.project.status).toBe('active');
  });
});

describe('canonical bounded reads (review c99117a1 finding 1)', () => {
  it('ordinary project reads carry NO compatibility-held legacy values', async () => {
    // Storage row carries legacy bytes; the canonical read must not.
    projects.set(P1, {
      ...projects.get(P1)!,
      source_dir: '/private/source',
      nfs_dir: '/private/nfs',
      resources: { repositories: { main: 'https://user:secret@git.invalid/r.git' } } as any,
      tool_instructions: { testing: 'PRIVATE INSTRUCTION' } as any,
    });
    for (const path of [`/projects/${P1}`, '/projects']) {
      const result = await call('GET', path);
      const serialized = JSON.stringify(result.json);
      expect(serialized).not.toContain('source_dir');
      expect(serialized).not.toContain('/private/source');
      expect(serialized).not.toContain('nfs_dir');
      expect(serialized).not.toContain('secret@git.invalid');
      expect(serialized).not.toContain('PRIVATE INSTRUCTION');
      expect(serialized).not.toContain('toolInstructions');
      expect(serialized).not.toContain('"links"');
    }
    const single = await call('GET', `/projects/${P1}`);
    // `goal` joined the canonical bounded record with migration 079 (RH-P2.4):
    // the ratified Goal PROPERTY at the project altitude. Everything else the
    // c99117a1 finding excluded stays excluded.
    expect(Object.keys(single.json.project).sort()).toEqual(
      ['created_at', 'description', 'goal', 'id', 'is_hidden', 'name', 'revision', 'status', 'updated_at'],
    );
  });
});

describe('canonical field validation (review c99117a1 finding 3)', () => {
  it('whitespace-only names, non-string descriptions and non-boolean flags are 422 with zero persistence', async () => {
    for (const body of [
      { name: '   ' },
      { name: 'Valid', description: 42 },
      { name: 'Valid', is_hidden: 'false' },
      { name: 'x'.repeat(121) },
    ]) {
      const result = await call('POST', '/projects', { body });
      expect(result.status).toBe(422);
      expect(result.json.code).toBe('INVALID_PROJECT_VALUE');
    }
    const patch = await call('PATCH', `/projects/${P1}`, { body: { description: 42 }, headers: { 'If-Match': 'rev-p1' } });
    expect(patch.status).toBe(422);
    expect(projects.get(P1)!.revision).toBe('rev-p1');
  });

  it('a project cannot be born archived (review 5d229bf1 finding 3)', async () => {
    const result = await call('POST', '/projects', { body: { name: 'Born archived', status: 'archived' } });
    expect(result.status).toBe(422);
    expect(result.json.code).toBe('INVALID_PROJECT_VALUE');
    expect(result.json.message).toContain('archive');
  });

  it('unknown query keys on detail read and mutation routes fail closed (review c99117a1 finding 2)', async () => {
    expect((await call('GET', `/projects/${P1}?spy=1`)).json.code).toBe('UNKNOWN_FIELD');
    expect((await call('PATCH', `/projects/${P1}?spy=1`, { body: { description: 'x' }, headers: { 'If-Match': 'rev-p1' } })).json.code).toBe('UNKNOWN_FIELD');
    expect((await call('POST', `/projects/${P1}/archive?spy=1`, { headers: { 'If-Match': 'rev-p1' } })).json.code).toBe('UNKNOWN_FIELD');
    expect((await call('POST', `/projects/${P1}/unarchive?spy=1`, { headers: { 'If-Match': 'rev-p1' } })).json.code).toBe('UNKNOWN_FIELD');
    expect(projects.get(P1)!.status).toBe('active');
    expect(projects.get(P1)!.revision).toBe('rev-p1');
  });
});

describe('OpenAPI matches the runtime Project contract exactly (reviews 5d229bf1/09c90755)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildOpenApiSpec } = require('../openapi/spec');

  it('the Project schema requires exactly the nine runtime keys and forbids extras', () => {
    const spec: any = buildOpenApiSpec();
    const schema = spec.components.schemas.Project;
    expect([...schema.required].sort()).toEqual(
      ['created_at', 'description', 'goal', 'id', 'is_hidden', 'name', 'revision', 'status', 'updated_at'],
    );
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
  });

  it('list items admit the includeStats aggregate; envelopes are strict; create body is required', () => {
    const spec: any = buildOpenApiSpec();
    const listItem = spec.components.schemas.ProjectListItem;
    expect(listItem.properties.stats).toBeTruthy();
    expect(listItem.additionalProperties).toBe(false);
    const listItems = spec.paths['/projects'].get.responses['200']
      .content['application/json'].schema.properties.projects.items;
    expect(listItems.$ref).toBe('#/components/schemas/ProjectListItem');
    expect(spec.components.schemas.ProjectEnvelope.additionalProperties).toBe(false);
    expect(spec.paths['/projects'].post.requestBody.required).toBe(true);
    expect(spec.components.schemas.ProjectCreateBody.properties.status.enum).toEqual(['active']);
  });

  it('the single-read runtime response satisfies the strict Project schema key set', async () => {
    const result = await call('GET', `/projects/${P1}`);
    const spec: any = buildOpenApiSpec();
    const schema = spec.components.schemas.Project;
    expect(Object.keys(result.json.project).sort()).toEqual([...schema.required].sort());
  });
});

describe('hostile inputs fail closed (review 73df8efe finding 4)', () => {
  it('unknown query keys on the project list are rejected', async () => {
    const result = await call('GET', '/projects?bogus=1');
    expect(result.status).toBe(400);
    expect(result.json.code).toBe('UNKNOWN_FIELD');
  });

  it('invalid status and non-boolean flags are rejected', async () => {
    expect((await call('GET', '/projects?status=paused-ish')).json.code).toBe('INVALID_QUERY_VALUE');
    expect((await call('GET', '/projects?includeArchived=1')).json.code).toBe('INVALID_QUERY_VALUE');
  });

  it('create with the legacy links writer is LEGACY_COMPATIBILITY_ONLY', async () => {
    const result = await call('POST', '/projects', { body: { name: 'New', links: [{ type: 'git', title: 'x', url: 'https://x' }] } });
    expect(result.status).toBe(409);
    expect(result.json.code).toBe('LEGACY_COMPATIBILITY_ONLY');
  });

  it('unknown body fields on create and PATCH are rejected before any mutation', async () => {
    const create = await call('POST', '/projects', { body: { name: 'New', notebook: true } });
    expect(create.status).toBe(400);
    expect(create.json.code).toBe('UNKNOWN_FIELD');

    const patch = await call('PATCH', `/projects/${P1}`, { body: { description: 'x', extra: 1 }, headers: { 'If-Match': 'rev-p1' } });
    expect(patch.status).toBe(400);
    expect(patch.json.code).toBe('UNKNOWN_FIELD');
    expect(projects.get(P1)!.revision).toBe('rev-p1');
  });

  it('archive and unarchive take no request body', async () => {
    const archived = await call('POST', `/projects/${P1}/archive`, { body: { reason: 'x' }, headers: { 'If-Match': 'rev-p1' } });
    expect(archived.status).toBe(400);
    expect(archived.json.code).toBe('UNKNOWN_FIELD');
    expect(projects.get(P1)!.status).toBe('active');
  });
});

describe('name-collision serialization (review 73df8efe finding 1)', () => {
  it('create, rename and restore all take the advisory name lock before the conflict check', async () => {
    await call('POST', '/projects', { body: { name: 'Brand New' } }).catch(() => null);
    await call('PATCH', `/projects/${P1}`, { body: { name: 'Renamed' }, headers: { 'If-Match': 'rev-p1' } });
    await call('POST', `/projects/${P2}/unarchive`, { body: {}, headers: { 'If-Match': 'rev-p2' } });
    // one lock per name-mutating path, keyed on the normalized name
    expect(nameLocks.length).toBe(3);
    expect(nameLocks[0]).toBe('Brand New');
    expect(nameLocks[1]).toBe('Renamed');
    expect(nameLocks[2]).toBe('Beta');
  });
});

describe('default collection and removed deletion surfaces', () => {
  it('GET /projects excludes archived by default and includes them only explicitly', async () => {
    const byDefault = await call('GET', '/projects');
    expect(byDefault.status).toBe(200);
    expect(byDefault.json.projects.map((p: any) => p.id)).toEqual([P1]);

    const explicit = await call('GET', '/projects?includeArchived=true');
    expect(explicit.json.projects.map((p: any) => p.id).sort()).toEqual([P1, P2].sort());

    const archivedView = await call('GET', '/projects?status=archived');
    expect(archivedView.json.projects.map((p: any) => p.id)).toEqual([P2]);
  });

  it('duplicate active names are refused at create', async () => {
    const result = await call('POST', '/projects', { body: { name: ' alpha ' } });
    expect(result.status).toBe(409);
    expect(result.json.code).toBe('PROJECT_NAME_CONFLICT');
  });

  it('DELETE /projects/:id and the delete preview are gone', async () => {
    const del = await call('DELETE', `/projects/${P1}`);
    expect(del.status).toBe(404);
    const hard = await call('DELETE', `/projects/${P1}?hard=true`);
    expect(hard.status).toBe(404);
    const preview = await call('GET', `/projects/${P1}/delete-preview`);
    expect(preview.status).toBe(404);
    expect(projects.get(P1)).toBeTruthy();
  });
});
