import type { Pool } from 'pg';
import { runCreationTransaction } from '../db/creationTransaction';
import type { TaskActor } from '../services/TaskHistoryService';

const actor: TaskActor = { principalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', handle: 'builder',
  authorization: { principalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', handle: 'builder', role: 'user', scopes: ['tasks:write'], authenticated: true } };
function fixture() {
  const events: string[] = [];
  const client = { query: jest.fn(async (sql: string) => { events.push(sql); return { rows: [] }; }), release: jest.fn(() => events.push('release')) };
  const pool = { connect: jest.fn(async () => client) } as unknown as Pool;
  return { pool, client, events };
}
describe('explicit canonical creation transaction', () => {
  test('the same actor/client reaches the operation; delivery runs after commit and release', async () => {
    const { pool, client, events } = fixture();
    const result = await runCreationTransaction(pool, actor, async transaction => {
      expect(transaction.actor).toBe(actor); expect(transaction.client).toBe(client);
      await transaction.client.query('canonical write');
      await transaction.client.query('canonical history and audit');
      transaction.afterCommit(() => { events.push('delivery'); });
      return { created: 1 };
    });
    expect(result).toEqual({ created: 1 });
    expect(events).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ', "SET LOCAL statement_timeout = '15s'", "SET LOCAL lock_timeout = '5s'", 'canonical write', 'canonical history and audit', 'COMMIT', 'release', 'delivery']);
  });
  test('a later write failure rolls back and suppresses all queued delivery', async () => {
    const { pool, events } = fixture();
    await expect(runCreationTransaction(pool, actor, async transaction => {
      await transaction.client.query('canonical first write');
      transaction.afterCommit(() => { events.push('must not escape'); });
      throw new Error('later write failed');
    })).rejects.toThrow('later write failed');
    expect(events.slice(-2)).toEqual(['ROLLBACK', 'release']);
    expect(events).not.toContain('COMMIT'); expect(events).not.toContain('must not escape');
  });
  test('rollback failure still releases the owned client', async () => {
    const { pool, client } = fixture(); client.query.mockImplementation(async sql => { if (sql === 'ROLLBACK') throw new Error('rollback failed'); return { rows: [] }; });
    await expect(runCreationTransaction(pool, actor, async () => { throw new Error('write failed'); })).rejects.toThrow();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
  test('an unresolved/mismatched actor opens no connection', async () => {
    const { pool } = fixture();
    await expect(runCreationTransaction(pool, { ...actor, principalId: null }, async () => undefined)).rejects.toThrow('resolved creation actor');
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
