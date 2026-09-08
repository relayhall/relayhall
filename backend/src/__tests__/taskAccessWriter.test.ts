/**
 * RH-AZ.PROJ-a — the ONE attributed writer for `tasks.restricted_access`.
 *
 * `pool.connect` is SPIED, not module-mocked: mocking `db/connection` wholesale
 * drops its sibling exports and the suite hangs. The fake client records every
 * statement, so these controls assert what the writer SENT rather than what it
 * returned — an attribution that never reached the transaction is the defect
 * the database trigger exists to catch, and this is the control that catches it
 * one layer earlier.
 */
import { pool } from '../db/connection';
import { taskAccessService } from '../services/TaskAccessService';
import { ConflictFault, InvalidRequestFault, NotFoundFault } from '../utils/httpErrors';

const TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACTOR = '11111111-1111-4111-8111-111111111111';

interface FakeRow { id: string; project_id: string | null; status: string; restricted_access: boolean }

function fakeClient(row: FakeRow | null) {
  const statements: string[] = [];
  const client = {
    statements,
    released: 0,
    query: jest.fn(async (text: string, params?: unknown[]) => {
      void params;
      statements.push(text.replace(/\s+/g, ' ').trim());
      if (text.startsWith('SELECT id, project_id, status')) {
        return { rows: row ? [row] : [] };
      }
      if (text.startsWith('UPDATE tasks SET restricted_access')) {
        return { rows: [{ id: TASK, restricted_access: !row!.restricted_access }] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  return client;
}

function row(overrides: Partial<FakeRow> = {}): FakeRow {
  return { id: TASK, project_id: PROJECT, status: 'todo', restricted_access: false, ...overrides };
}

function useClient(client: ReturnType<typeof fakeClient>) {
  return jest.spyOn(pool, 'connect').mockResolvedValue(client as never);
}

afterEach(() => { jest.restoreAllMocks(); });

describe('TaskAccessService — the attributed writer', () => {
  it('sets BOTH audit GUCs, transaction-locally, BEFORE the update', async () => {
    const client = fakeClient(row());
    useClient(client);
    await taskAccessService.setRestrictedAccess(TASK, {
      restricted: true, reason: 'a stated reason', actorPrincipalId: ACTOR,
    });
    const actorAt = client.statements.findIndex((s) => s.includes('set_config'));
    const updateAt = client.statements.findIndex((s) => s.startsWith('UPDATE tasks SET restricted_access'));
    expect(actorAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(actorAt);
    const bound = client.query.mock.calls.filter((call) => String(call[0]).includes('set_config'));
    expect(bound.map((call) => (call[1] ?? [])[0])).toEqual([
      'relayhall.task_access_actor', 'relayhall.task_access_reason',
    ]);
    expect(bound.map((call) => (call[1] ?? [])[1])).toEqual([ACTOR, 'a stated reason']);
    // The third set_config argument is the TRANSACTION-LOCAL flag, and it is
    // literal in the statement rather than bound: a rollback takes the
    // attribution with it, and a recycled pool connection cannot inherit an
    // actor that never authorised anything.
    for (const call of bound) expect(String(call[0])).toContain('set_config($1, $2, TRUE)');
    expect(client.statements).toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('locks the row it is about to change', async () => {
    const client = fakeClient(row());
    useClient(client);
    await taskAccessService.setRestrictedAccess(TASK, {
      restricted: true, reason: 'a stated reason', actorPrincipalId: ACTOR,
    });
    expect(client.statements[0]).toBe('BEGIN');
    expect(client.statements[1]).toContain('FOR UPDATE');
  });

  it('refuses an ARCHIVED Task, as 085 refuses an archived Phase', async () => {
    // PhaseService.setRestrictedAccess runs under `requireActivePhase: true`
    // and 409s an archived Phase. An archived Task is read-only for the same
    // reason: an ACL flip on an object that has left the board would move its
    // updated_at and append a ledger row (review cf04a642 finding 2).
    const client = fakeClient(row({ status: 'archived' }));
    useClient(client);
    await expect(taskAccessService.setRestrictedAccess(TASK, {
      restricted: true, reason: 'a stated reason', actorPrincipalId: ACTOR,
    })).rejects.toBeInstanceOf(ConflictFault);
    expect(client.statements).toContain('ROLLBACK');
    expect(client.statements.some((s) => s.startsWith('UPDATE tasks'))).toBe(false);
    expect(client.statements.some((s) => s.includes('set_config'))).toBe(false);
  });

  it('refuses a no-op flip with 409 and writes nothing', async () => {
    const client = fakeClient(row({ restricted_access: true }));
    useClient(client);
    await expect(taskAccessService.setRestrictedAccess(TASK, {
      restricted: true, reason: 'a stated reason', actorPrincipalId: ACTOR,
    })).rejects.toBeInstanceOf(ConflictFault);
    expect(client.statements.some((s) => s.startsWith('UPDATE tasks'))).toBe(false);
  });

  it('refuses a missing Task without opening the audit context', async () => {
    const client = fakeClient(null);
    useClient(client);
    await expect(taskAccessService.setRestrictedAccess(TASK, {
      restricted: true, reason: 'a stated reason', actorPrincipalId: ACTOR,
    })).rejects.toBeInstanceOf(NotFoundFault);
    expect(client.statements.some((s) => s.includes('set_config'))).toBe(false);
  });

  it('validates the caller BEFORE taking a connection at all', async () => {
    const connect = useClient(fakeClient(row()));
    for (const input of [
      { restricted: 'yes', reason: 'a stated reason', actorPrincipalId: ACTOR },
      { restricted: true, reason: 'no', actorPrincipalId: ACTOR },
      { restricted: true, reason: 'x'.repeat(1001), actorPrincipalId: ACTOR },
      { restricted: true, reason: 'a stated reason', actorPrincipalId: 'not-a-uuid' },
      { restricted: true, reason: 'a stated reason' },
    ]) {
      await expect(taskAccessService.setRestrictedAccess(TASK, input as never))
        .rejects.toBeInstanceOf(InvalidRequestFault);
    }
    await expect(taskAccessService.setRestrictedAccess('not-a-uuid', {
      restricted: true, reason: 'a stated reason', actorPrincipalId: ACTOR,
    })).rejects.toBeInstanceOf(NotFoundFault);
    expect(connect).not.toHaveBeenCalled();
  });

  it('announces the ACL change CONTENT-FREE, in the same transaction', async () => {
    const client = fakeClient(row());
    useClient(client);
    await taskAccessService.setRestrictedAccess(TASK, {
      restricted: true, reason: 'the reason belongs in the ledger, not the feed',
      actorPrincipalId: ACTOR,
    });
    const emit = client.query.mock.calls.find(
      (call) => String(call[0]).includes('INSERT INTO feed_events'));
    expect(emit).toBeDefined();
    const params = emit![1] ?? [];
    expect(params[0]).toBe('task.acl_changed');
    // The reason must never reach the feed payload.
    expect(JSON.stringify(params)).not.toContain('belongs in the ledger');
    const emitAt = client.statements.findIndex((s) => s.includes('INSERT INTO feed_events'));
    const commitAt = client.statements.indexOf('COMMIT');
    expect(emitAt).toBeGreaterThan(-1);
    expect(commitAt).toBeGreaterThan(emitAt);
  });
});
