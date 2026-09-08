jest.mock('../db/connection', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../services/LifecyclePolicyService', () => ({ lifecyclePolicyService: { evaluate: jest.fn(async () => undefined) } }));
jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn(async () => undefined) } }));
import { pool } from '../db/connection';
import { ProjectService } from '../services/ProjectService';
import { auditService } from '../services/AuditService';
import { taskHistoryService } from '../services/TaskHistoryService';
import { grantService } from '../services/GrantService';
import type { CreationTransaction } from '../db/creationTransaction';
const actor = { principalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', handle: 'caller', authMethod: 'session' as const };
/**
 * Contract B (`ProjectService.create`, the `PROJECT_CREATOR_REQUIRED` guard):
 * a create naming a caller principal writes that caller's creator Grant pair,
 * and refuses outright without the resolved authority to write it. This
 * fixture predates that guard and named a principal with no `authorization`,
 * so every case here died on the refusal before it reached the transaction
 * question this file is about. It carries the authority now.
 */
const authorization = {
  principalId: actor.principalId, handle: actor.handle, role: 'admin',
  scopes: ['projects:write'], authenticated: true,
};
const caller = {
  principalId: actor.principalId, authMethod: actor.authMethod,
  scopes: ['projects:write'], audit: actor, authorization,
};
/**
 * The creator-Grant write is GrantService's own subject, drilled there against
 * real rows; what THIS file must still see is that it is handed the SUPPLIED
 * client rather than reaching for the pool, so the stub records its arguments
 * and the first case asserts them. Stubbed rather than run, because the real
 * write resolves the grantee through the pool this file mocks away - and a
 * stub that swallowed the client seam would leave that claim unasserted.
 */
const createForProjectCreator = jest
  .spyOn(grantService, 'createForProjectCreator')
  .mockResolvedValue(undefined);
function fixture() {
  const query = jest.fn(async (sql: string, _values?: any[]) => ({ rows: sql.startsWith('SELECT * FROM projects') ? [{ id: 'project', name: 'Project', status: 'active' }] : [] }));
  const client = { query, release: jest.fn() };
  const transaction = { client, actor, afterCommit: jest.fn() } as unknown as CreationTransaction;
  return { client, transaction };
}
describe('canonical creation under an outer transaction', () => {
  // `clearAllMocks` clears calls, never implementations, so the creator-Grant
  // stub above survives every case; it is re-armed anyway, so a future
  // `resetMocks` in the jest config cannot silently empty it.
  beforeEach(() => { jest.clearAllMocks(); createForProjectCreator.mockResolvedValue(undefined); });
  test('Project insert and caller audit share the supplied client without changing ownership or transaction ownership', async () => {
    const { transaction, client } = fixture();
    const result = await new ProjectService().create({ name: 'Project' }, caller, transaction);
    expect(result.name).toBe('Project');
    expect(createForProjectCreator).toHaveBeenCalledWith(client, expect.any(String), authorization, actor);
    const insert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO projects'))!;
    expect(insert[0]).not.toContain('owner_principal_id');
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ principalId: actor.principalId, authMethod: 'session' }), action: 'project.create' }), client);
    expect(client.query.mock.calls.some(([sql]) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql))).toBe(false);
    expect(client.release).not.toHaveBeenCalled(); expect(pool.connect).not.toHaveBeenCalled();
  });
  test('audit failure propagates so the outer transaction can roll back the already inserted Project', async () => {
    const { transaction, client } = fixture();
    (auditService.record as jest.Mock).mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(new ProjectService().create({ name: 'Project' }, caller, transaction)).rejects.toThrow('audit unavailable');
    expect(client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO projects'))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  });
  test('missing authoritative history schema refuses the transaction rather than silently omitting history', async () => {
    const { transaction } = fixture();
    await expect(taskHistoryService.recordChange('task', 'Title', 'create', null, 'todo', actor.handle, actor.principalId, transaction.client)).rejects.toThrow('attributed task history');
    expect(pool.query).not.toHaveBeenCalled();
  });
  test('history INSERT uses supplied client and propagates a failure', async () => {
    const { transaction, client } = fixture();
    client.query.mockImplementation(async sql => {
      if (sql.includes('pg_attribute')) return { rows: ['actor_principal_id', 'task_title', 'field', 'changed_by'].map(column_name => ({ column_name })) } as any;
      throw new Error('history insert unavailable');
    });
    await expect(taskHistoryService.recordChange('task', 'Title', 'create', null, 'todo', actor.handle, actor.principalId, transaction.client)).rejects.toThrow('history insert unavailable');
    const insert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO task_history'))!;
    expect(insert[1]).toContain(actor.principalId); expect(pool.query).not.toHaveBeenCalled();
  });
});
