/**
 * CharterService transaction semantics (task f2735f1b, vocabulary A9).
 *
 * The load-bearing claims: one Charter per Project with concealment-before-
 * validation (an absent Project 404s identically whatever the body carries);
 * create needs no revision but replace is revision-bound; identical content
 * is a genuine no-op (no version churn, no mutation); every content change
 * appends exactly one attributable version row; archived Projects refuse
 * writes but still serve reads.
 */

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

import { pool } from '../db/connection';
import { CharterService, CharterError, CHARTER_CONTENT_MAX_LENGTH } from '../services/CharterService';

const PROJECT_ID = 'f2735f1b-0000-4000-8000-000000000001';
const CHARTER_ID = 'f2735f1b-0000-4000-8000-000000000002';
const REVISION = 'f2735f1b-0000-4000-8000-00000000rev1';

interface FakeState {
  projectStatus: string | null; // null = absent
  head: any | null;
  mutations: string[];
  versionInserts: any[][];
}

let state: FakeState;

function headRow(overrides: Record<string, any> = {}): any {
  return {
    id: CHARTER_ID,
    project_id: PROJECT_ID,
    content: '# Charter v1',
    content_hash: 'hash-1',
    version: 1,
    revision: REVISION,
    updated_by_principal_id: 'owner',
    created_at: 'now',
    updated_at: 'now',
    ...overrides,
  };
}

function armPool(): void {
  const query = async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.startsWith('SELECT id, status FROM projects')) {
      return { rows: state.projectStatus === null ? [] : [{ id: params[0], status: state.projectStatus }] };
    }
    if (sql.startsWith('SELECT id FROM projects')) {
      return { rows: state.projectStatus === null ? [] : [{ id: params[0] }] };
    }
    if (sql.startsWith('SELECT * FROM project_charters')) {
      return { rows: state.head ? [state.head] : [] };
    }
    if (sql.startsWith('INSERT INTO project_charters')) {
      state.mutations.push('INSERT head');
      state.head = headRow({ content: params[1], content_hash: params[2], updated_by_principal_id: params[3] });
      return { rows: [state.head] };
    }
    if (sql.startsWith('INSERT INTO project_charter_versions')) {
      state.mutations.push('INSERT version');
      state.versionInserts.push(params);
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE project_charters')) {
      state.mutations.push('UPDATE head');
      state.head = headRow({
        content: params[1], content_hash: params[2], version: params[3],
        revision: 'rotated-revision', updated_by_principal_id: params[4],
      });
      return { rows: [state.head] };
    }
    if (sql.startsWith('SELECT version, content_hash')) {
      return { rows: [{ version: 1, content_hash: 'hash-1', actor_principal_id: 'owner', created_at: 'now' }] };
    }
    if (sql.startsWith('SELECT version, content,')) {
      return { rows: params[1] === 1 ? [{ version: 1, content: '# Charter v1', content_hash: 'hash-1', actor_principal_id: 'owner', created_at: 'now' }] : [] };
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
  };
  (pool.query as jest.Mock).mockImplementation(query);
  (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
}

const service = new CharterService();

async function expectCharterError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected CharterError ${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(CharterError);
    expect((e as CharterError).status).toBe(status);
    expect((e as CharterError).code).toBe(code);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  state = { projectStatus: 'active', head: null, mutations: [], versionInserts: [] };
  armPool();
});

describe('create', () => {
  it('creates version 1 with one attributable version row and no revision required', async () => {
    const result = await service.put(PROJECT_ID, '# New charter', undefined, 'owner');
    expect(result.created).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.charter.version).toBe(1);
    expect(state.mutations).toEqual(['INSERT head', 'INSERT version']);
    // Create inlines version 1: params are (charter_id, content, hash, actor).
    expect(state.versionInserts[0][1]).toBe('# New charter');
    expect(state.versionInserts[0][3]).toBe('owner');
  });

  it('conceals an absent Project before validation: invalid body still 404s', async () => {
    state.projectStatus = null;
    await expectCharterError(service.put(PROJECT_ID, 12345, undefined, 'owner'), 404, 'PROJECT_NOT_FOUND');
    expect(state.mutations).toEqual([]);
  });

  it('refuses writes on an archived Project with no mutation', async () => {
    state.projectStatus = 'archived';
    await expectCharterError(service.put(PROJECT_ID, '# text', undefined, 'owner'), 409, 'PROJECT_ARCHIVED');
    expect(state.mutations).toEqual([]);
  });

  it('rejects empty and oversize content with stable codes', async () => {
    await expectCharterError(service.put(PROJECT_ID, '   ', undefined, 'owner'), 422, 'INVALID_CHARTER_VALUE');
    await expectCharterError(
      service.put(PROJECT_ID, 'x'.repeat(CHARTER_CONTENT_MAX_LENGTH + 1), undefined, 'owner'),
      400, 'VALUE_TOO_LONG',
    );
    expect(state.mutations).toEqual([]);
  });
});

describe('replace', () => {
  beforeEach(() => { state.head = headRow(); });

  it('requires the observed revision', async () => {
    await expectCharterError(service.put(PROJECT_ID, '# v2', undefined, 'owner'), 400, 'REVISION_REQUIRED');
    expect(state.mutations).toEqual([]);
  });

  it('rejects a stale revision without mutating', async () => {
    await expectCharterError(service.put(PROJECT_ID, '# v2', 'stale', 'owner'), 412, 'REVISION_MISMATCH');
    expect(state.mutations).toEqual([]);
  });

  it('identical content is a no-op: no version churn, no mutation', async () => {
    const result = await service.put(PROJECT_ID, '# Charter v1', REVISION, 'owner');
    expect(result.changed).toBe(false);
    expect(result.created).toBe(false);
    expect(result.charter.version).toBe(1);
    expect(state.mutations).toEqual([]);
  });

  it('a content change bumps the version and appends exactly one version row', async () => {
    const result = await service.put(PROJECT_ID, '# Charter v2', REVISION, 'editor');
    expect(result.changed).toBe(true);
    expect(result.charter.version).toBe(2);
    expect(result.charter.revision).toBe('rotated-revision');
    expect(state.mutations).toEqual(['UPDATE head', 'INSERT version']);
    expect(state.versionInserts[0][1]).toBe(2);
    expect(state.versionInserts[0][4]).toBe('editor');
  });
});

describe('reads', () => {
  it('get: absent charter is CHARTER_NOT_FOUND on an existing Project', async () => {
    await expectCharterError(service.get(PROJECT_ID), 404, 'CHARTER_NOT_FOUND');
  });

  it('get: absent Project is PROJECT_NOT_FOUND', async () => {
    state.projectStatus = null;
    await expectCharterError(service.get(PROJECT_ID), 404, 'PROJECT_NOT_FOUND');
  });

  it('reads serve archived Projects (archived = read-only, not invisible)', async () => {
    state.projectStatus = 'archived';
    state.head = headRow();
    const charter = await service.get(PROJECT_ID);
    expect(charter.version).toBe(1);
  });

  it('getVersion validates the version number and 404s an unknown one', async () => {
    state.head = headRow();
    await expectCharterError(service.getVersion(PROJECT_ID, 0), 400, 'INVALID_QUERY_VALUE');
    await expectCharterError(service.getVersion(PROJECT_ID, 1.5), 400, 'INVALID_QUERY_VALUE');
    await expectCharterError(service.getVersion(PROJECT_ID, 99), 404, 'CHARTER_VERSION_NOT_FOUND');
    const v1 = await service.getVersion(PROJECT_ID, 1);
    expect(v1.content).toBe('# Charter v1');
  });
});
