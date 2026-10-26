jest.mock('../db/connection', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../services/AuthorizationRepository', () => ({ authorizationRepository: { authorizedIds: jest.fn() } }));
jest.mock('../services/ProjectService', () => ({ projectService: { getById: jest.fn() } }));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn() } }));
jest.mock('../services/FeedEventService', () => ({ feedEventService: { emit: jest.fn() } }));

import { pool } from '../db/connection';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { projectService } from '../services/ProjectService';
import { auditService } from '../services/AuditService';
import { feedEventService } from '../services/FeedEventService';
import { ProjectOwnershipService, setProjectOwnerInvalidationSink } from '../services/ProjectOwnershipService';

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const issuerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ownerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const nextId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const project = (owner: string | null = ownerId) => ({ id: projectId, status: 'active', revision: 'rev-1', owner_principal_id: owner });
const principal = (id: string, role = 'admin', overrides: Record<string, unknown> = {}) => ({
  id, handle: id, kind: 'human', status: 'active', role, parent_principal_id: null, ...overrides,
});
const actor = (role = 'admin', authMethod: import('../services/AuditService').AuditActor['authMethod'] = 'session') => ({
  authorization: { authenticated: true, principalId: issuerId, handle: 'issuer', role, scopes: role === 'user' ? ['projects:read', 'projects:write'] : ['root'] },
  authMethod,
  audit: { principalId: issuerId, handle: 'issuer', authMethod: 'session' as const },
});

function fixture(options: { owner?: string | null; target?: Record<string, unknown> | null; phaseIds?: string[]; issuerRole?: string } = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const rows = new Map<string, Record<string, unknown>>([
    [issuerId, principal(issuerId, options.issuerRole || 'admin')],
    [nextId, options.target === null ? undefined as never : principal(nextId, 'user', options.target || {})],
  ]);
  const client = {
    release: jest.fn(),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      if (sql.includes('SELECT * FROM projects')) return { rows: [project(options.owner === undefined ? ownerId : options.owner)] };
      if (sql.includes('FROM principals WHERE id = $1 FOR SHARE')) return { rows: rows.get(String(params[0])) ? [rows.get(String(params[0]))] : [] };
      if (sql.includes('SELECT id FROM phases')) return { rows: (options.phaseIds || []).map(id => ({ id })) };
      return { rows: [] };
    }),
  };
  (pool.connect as jest.Mock).mockResolvedValue(client);
  (projectService.getById as jest.Mock).mockResolvedValue({ id: projectId, revision: 'rev-2', ownerPrincipalId: nextId });
  (authorizationRepository.authorizedIds as jest.Mock).mockImplementation(async () => new Set([projectId]));
  return { client, statements };
}

beforeEach(() => {
  jest.clearAllMocks();
  (auditService.record as jest.Mock).mockResolvedValue(undefined);
  (feedEventService.emit as jest.Mock).mockResolvedValue(undefined);
  // AZ-A12 clause 13: the owner-change recipients read finds no Group members here.
  (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
  setProjectOwnerInvalidationSink(() => undefined);
});

test('locks Project then unique sorted issuer/target Accounts, writes owner+revision, audit and content-free Project/Phase events atomically', async () => {
  const { client, statements } = fixture({ phaseIds: ['phase-1', 'phase-2'] });
  const notice = jest.fn(); setProjectOwnerInvalidationSink(notice);
  await new ProjectOwnershipService().change(projectId, nextId, 'rev-1', actor());
  const locked = statements.filter(x => x.sql.includes('FOR SHARE')).map(x => x.params[0]);
  expect(locked).toEqual([issuerId, nextId].sort());
  expect(statements.findIndex(x => x.sql.includes('FOR UPDATE'))).toBeLessThan(statements.findIndex(x => x.sql.includes('FOR SHARE')));
  expect(statements.find(x => x.sql.includes('UPDATE projects'))?.params).toEqual([projectId, nextId]);
  expect((auditService.record as jest.Mock).mock.calls[0][0]).toMatchObject({
    action: 'project.owner.change', resourceId: projectId,
    metadata: { oldOwnerPrincipalId: ownerId, newOwnerPrincipalId: nextId },
  });
  expect((auditService.record as jest.Mock).mock.calls[0][1]).toBe(client);
  expect((feedEventService.emit as jest.Mock).mock.calls.map(([, event]) => [event.name, event.objectId, event.payload])).toEqual([
    ['project.acl_changed', projectId, {}],
    ['phase.acl_changed', 'phase-1', {}],
    ['phase.acl_changed', 'phase-2', {}],
  ]);
  expect((feedEventService.emit as jest.Mock).mock.calls.every(([connection]) => connection === client)).toBe(true);
  expect(statements.at(-1)?.sql).toBe('COMMIT');
  expect(notice).toHaveBeenCalledWith([ownerId, nextId]);
  expect(client.release).toHaveBeenCalledTimes(1);
});

test.each([
  ['stale revision', 'rev-stale', actor(), 'REVISION_MISMATCH'],
  ['machine credential', 'rev-1', actor('admin', 'principal_api_key'), 'REQUIRES_HUMAN_LOGIN'],
  ['ordinary user with admin grant', 'rev-1', actor('user'), 'CURRENT_ROLE_CEILING'],
])('%s refuses before mutation', async (_label, revision, caller, code) => {
  const { statements } = fixture({ issuerRole: caller.authorization.role });
  await expect(new ProjectOwnershipService().change(projectId, nextId, revision, caller)).rejects.toMatchObject({ code });
  expect(statements.some(x => x.sql.includes('UPDATE projects'))).toBe(false);
  expect(statements.at(-1)?.sql).toBe('ROLLBACK');
  expect(feedEventService.emit).not.toHaveBeenCalled();
});

test.each([
  [{ status: 'disabled' }, 'INVALID_OWNER'],
  [{ kind: 'service' }, 'INVALID_OWNER'],
  [{ parent_principal_id: ownerId }, 'INVALID_OWNER'],
  [{ role: 'viewer' }, 'INEFFECTIVE_OWNER'],
])('target %j cannot receive ineffective owner arm', async (target, code) => {
  const { statements } = fixture({ target });
  await expect(new ProjectOwnershipService().change(projectId, nextId, 'rev-1', actor())).rejects.toMatchObject({ code });
  expect(statements.some(x => x.sql.includes('UPDATE projects'))).toBe(false);
  expect(statements.at(-1)?.sql).toBe('ROLLBACK');
});

test('audit or feed failure rolls back the owner update and never notifies', async () => {
  const { statements } = fixture();
  const notice = jest.fn(); setProjectOwnerInvalidationSink(notice);
  (feedEventService.emit as jest.Mock).mockRejectedValueOnce(new Error('feed unavailable'));
  await expect(new ProjectOwnershipService().change(projectId, nextId, 'rev-1', actor())).rejects.toThrow('feed unavailable');
  expect(statements.some(x => x.sql.includes('UPDATE projects'))).toBe(true);
  expect(statements.at(-1)?.sql).toBe('ROLLBACK');
  expect(notice).not.toHaveBeenCalled();
});

test('a current no-op rotates neither revision nor audit/feed and stale no-op still refuses', async () => {
  const { statements } = fixture({ owner: nextId });
  await new ProjectOwnershipService().change(projectId, nextId, 'rev-1', actor());
  expect(statements.some(x => x.sql.includes('UPDATE projects'))).toBe(false);
  expect(auditService.record).not.toHaveBeenCalled();
  expect(feedEventService.emit).not.toHaveBeenCalled();
  expect(statements.at(-1)?.sql).toBe('COMMIT');
});

test('clear sends null as the new owner and does not erase separate Grants', async () => {
  const { statements } = fixture();
  const notice = jest.fn(); setProjectOwnerInvalidationSink(notice);
  await new ProjectOwnershipService().change(projectId, null, 'rev-1', actor());
  expect(statements.find(x => x.sql.includes('UPDATE projects'))?.params).toEqual([projectId, null]);
  expect(statements.some(x => x.sql.includes('DELETE FROM grants'))).toBe(false);
  expect(notice).toHaveBeenCalledWith([ownerId]);
});

test('uppercase spelling of the current UUID is an actual no-op', async () => {
  const { statements } = fixture({ owner: nextId });
  await new ProjectOwnershipService().change(projectId, nextId.toUpperCase(), 'rev-1', actor());
  expect(statements.some(x => x.sql.includes('UPDATE projects'))).toBe(false);
  expect(auditService.record).not.toHaveBeenCalled();
});
