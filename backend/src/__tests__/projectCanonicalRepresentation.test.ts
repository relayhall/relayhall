/**
 * Canonical Resource representation (task 47ef04a2; schema 28b76f54).
 *
 * Every read surface returns the same camelCase canonical record with an
 * opaque revision — snake_case storage names, normalized_name and migration
 * provenance never leak. List order and cursor behavior are deterministic.
 */

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import { ProjectResourceService } from '../services/ProjectResourceService';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const service = new ProjectResourceService();

function row(id: string, overrides: Record<string, any> = {}): any {
  return {
    id, project_id: PROJECT_ID, kind: 'reference', name: 'Docs',
    normalized_name: 'docs', description: null, state: 'active',
    agent_visibility: 'hidden', export_policy: 'installation-only',
    details: { url: 'https://d.example.test', category: 'documentation' },
    revision: 'rev-1', migration_provenance: { surface: 'projects.resources' },
    archived_at: null, created_at: '2026-08-08T00:00:00Z', updated_at: '2026-08-08T00:00:00Z',
    ...overrides,
  };
}

const R1 = '11111111-1111-4111-8111-111111111111';

function armPool(rows: any[]): jest.Mock {
  const mock = pool.query as jest.Mock;
  mock.mockImplementation(async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('SELECT id FROM projects')) return { rows: [{ id: params[0] }] };
    if (sql.startsWith('SELECT * FROM project_resources WHERE id = $1')) {
      const found = rows.find((r) => r.id === params[0] && r.project_id === params[1]);
      return { rows: found ? [found] : [] };
    }
    if (sql.includes('FROM project_resources')) {
      const limit = params[params.length - 1];
      return { rows: rows.slice(0, limit) };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
  });
  return mock;
}

beforeEach(() => jest.clearAllMocks());

describe('canonical representation', () => {
  it('get() returns the exact camelCase canonical field set', async () => {
    armPool([row(R1)]);
    const resource = await service.get(PROJECT_ID, R1);
    expect(Object.keys(resource).sort()).toEqual([
      'agentVisibility', 'archivedAt', 'createdAt', 'description', 'details',
      'exportPolicy', 'id', 'kind', 'name', 'projectId', 'revision', 'state', 'updatedAt',
    ]);
    expect(resource.projectId).toBe(PROJECT_ID);
    expect(resource.agentVisibility).toBe('hidden');
    expect(resource.exportPolicy).toBe('installation-only');
    // Storage spellings never leak.
    const serialized = JSON.stringify(resource);
    expect(serialized).not.toContain('agent_visibility');
    expect(serialized).not.toContain('normalized_name');
    expect(serialized).not.toContain('migration_provenance');
    expect(serialized).not.toContain('projects.resources');
  });

  it('details arrive parsed whether storage returned an object or a JSON string', async () => {
    armPool([row(R1, { details: JSON.stringify({ url: 'https://d.example.test', category: 'other' }) })]);
    const resource = await service.get(PROJECT_ID, R1);
    expect(resource.details).toEqual({ url: 'https://d.example.test', category: 'other' });
  });

  it('archived rows carry archivedAt and state together', async () => {
    armPool([row(R1, { state: 'archived', archived_at: '2026-08-08T01:00:00Z' })]);
    const resource = await service.get(PROJECT_ID, R1);
    expect(resource.state).toBe('archived');
    expect(resource.archivedAt).toBe('2026-08-08T01:00:00Z');
  });

  it('list() defaults to active-only and exposes nextCursor as null on a short page', async () => {
    const mock = armPool([row(R1)]);
    const result = await service.list(PROJECT_ID);
    expect(result.resources).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
    const listSql: string = mock.mock.calls.find((c) => String(c[0]).includes('FROM project_resources'))![0];
    expect(listSql).toContain(`state = 'active'`);
    expect(listSql.replace(/\s+/g, ' ')).toContain(`ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, kind, normalized_name, id`);
  });

  it('list(includeArchived) drops the active filter but keeps the deterministic order', async () => {
    const mock = armPool([row(R1)]);
    await service.list(PROJECT_ID, { includeArchived: true });
    const listSql: string = mock.mock.calls.find((c) => String(c[0]).includes('FROM project_resources'))![0];
    expect(listSql).not.toContain(`state = 'active'`);
  });

  it('an invalid cursor fails closed', async () => {
    armPool([row(R1)]);
    await expect(service.list(PROJECT_ID, { cursor: '!!not-base64-json!!' }))
      .rejects.toMatchObject({ code: 'INVALID_CURSOR', status: 400 });
  });

  it('a kind filter outside the four kinds fails closed', async () => {
    armPool([row(R1)]);
    await expect(service.list(PROJECT_ID, { kind: 'notebook' as any }))
      .rejects.toMatchObject({ code: 'UNKNOWN_FIELD' });
  });
});
