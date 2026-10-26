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
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn().mockResolvedValue({}) } }));

import { pool } from '../db/connection';
import { authorizationRepository } from '../services/AuthorizationRepository';
import type { CharterApprovalActor } from '../services/CharterService';
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

describe('human Project Charter approval', () => {
  const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const actor = (overrides: any = {}): CharterApprovalActor => ({
    authMethod: 'session',
    audit: { principalId: OWNER, handle: 'owner', authMethod: 'session' },
    authorization: { principalId: OWNER, handle: 'owner', role: 'user',
      scopes: ['projects:write'], authenticated: true },
    ...overrides,
  });
  let principal: any;
  let owner: string | null;
  let writesAllowed: boolean;
  let adminsAllowed: boolean;
  let authority: jest.SpyInstance;
  beforeEach(() => {
    principal = { id: OWNER, handle: 'owner', kind: 'human', status: 'active', role: 'user', parent_principal_id: null };
    owner = OWNER; writesAllowed = true; adminsAllowed = false;
    const ordinaryQuery = (pool.query as jest.Mock).getMockImplementation()!;
    const query = jest.fn(async (text: string, params?: any[]) => {
      if (text.startsWith('SELECT id, handle, kind')) return { rows: principal ? [principal] : [] };
      if (text.startsWith('SELECT owner_principal_id')) return { rows: [{ owner_principal_id: owner }] };
      // Card b5c83682 (LENSES-c gate (i)): the Group-owner arm reads the owner's kind
      // after the administrator test refused; a person owner is no Group, so it refuses.
      if (text.startsWith('SELECT p.id::text AS project_id')) {
        return { rows: owner ? [{ project_id: PROJECT_ID, id: owner, kind: 'human', status: 'active' }] : [] };
      }
      return ordinaryQuery(text, params);
    });
    (pool.connect as jest.Mock).mockResolvedValue({ query, release: jest.fn() });
    authority = jest.spyOn(authorizationRepository, 'authorizedIds').mockImplementation(async (_actor, _type, ids, action, queryable) => {
      expect(queryable).toBeDefined();
      return new Set((action === 'write' ? writesAllowed : adminsAllowed) ? ids : []);
    });
  });
  afterEach(() => authority.mockRestore());

  test('active human owner creates and revises with attributable versions', async () => {
    const first = await service.approve(PROJECT_ID, '# Approved', undefined, actor());
    expect(first.created).toBe(true);
    expect(first.charter.updatedByPrincipalId).toBe(OWNER);
    expect(state.versionInserts[0][3]).toBe(OWNER);
    const next = await service.approve(PROJECT_ID, '# Revised', first.charter.revision, actor());
    expect(next.charter.version).toBe(2);
    expect(next.charter.updatedByPrincipalId).toBe(OWNER);
  });

  test.each(['principal_api_key', 'api_key', 'reports_api_key', undefined])('refuses authentication method %s', async authMethod => {
    await expect(service.approve(PROJECT_ID, '# Denied', undefined, actor({ authMethod }))).rejects.toMatchObject({ status: 403 });
    expect(state.mutations).toEqual([]);
  });
  test.each([false, 0, '', null, undefined, {}, { authorization: null }])('invalid approval actor %p cannot fall into root write', async bad => {
    await expect(service.approve(PROJECT_ID, '# Denied', undefined, bad as any)).rejects.toMatchObject({ status: 403 });
    expect(state.mutations).toEqual([]);
  });
  test.each([
    { kind: 'service' }, { kind: 'agent' }, { status: 'disabled' },
    { parent_principal_id: 'parent' }, { role: 'viewer' }, { role: null },
  ])('refuses current Account %p', async patch => {
    Object.assign(principal, patch);
    await expect(service.approve(PROJECT_ID, '# Denied', undefined, actor())).rejects.toMatchObject({ status: 403 });
    expect(state.mutations).toEqual([]);
  });
  test('refuses missing live Account, missing request scope and narrower session role', async () => {
    principal = null;
    await expect(service.approve(PROJECT_ID, '# Denied', undefined, actor())).rejects.toMatchObject({ status: 403 });
    principal = { id: OWNER, handle: 'owner', kind: 'human', status: 'active', role: 'admin', parent_principal_id: null };
    for (const authorization of [
      { ...actor().authorization, scopes: [] },
      { ...actor().authorization, role: 'viewer' },
    ]) {
      await expect(service.approve(PROJECT_ID, '# Denied', undefined, actor({ authorization }))).rejects.toMatchObject({ status: 403 });
    }
    expect(state.mutations).toEqual([]);
  });
  test('project write alone is insufficient for a nonowner; canonical project admin permits approval', async () => {
    owner = 'someone-else';
    await expect(service.approve(PROJECT_ID, '# Denied', undefined, actor())).rejects.toMatchObject({ status: 403 });
    expect(state.mutations).toEqual([]);
    adminsAllowed = true; principal.role = 'operator';
    const approved = await service.approve(PROJECT_ID, '# Admin approved', undefined,
      actor({ authorization: { ...actor().authorization, role: 'operator' } }));
    expect(approved.created).toBe(true);
  });
  test('revoked object write refuses even the owner; lookup errors roll back', async () => {
    writesAllowed = false;
    await expect(service.approve(PROJECT_ID, '# Denied', undefined, actor())).rejects.toMatchObject({ status: 403 });
    authority.mockRejectedValueOnce(new Error('test lookup failure'));
    await expect(service.approve(PROJECT_ID, '# Denied', undefined, actor())).rejects.toThrow('test lookup failure');
    expect(state.mutations).toEqual([]);
  });
  test('approval retains revision conflicts and archived-project refusal', async () => {
    state.head = headRow();
    await expect(service.approve(PROJECT_ID, '# New', 'stale', actor())).rejects.toMatchObject({ code: 'REVISION_MISMATCH' });
    state.projectStatus = 'archived';
    await expect(service.approve(PROJECT_ID, '# New', REVISION, actor())).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
    expect(state.mutations).toEqual([]);
  });
});
