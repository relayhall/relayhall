import fs from 'fs';
import path from 'path';
import { TaskManagerDB } from '../services/TaskManagerDB';

jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn() } }));

const taskId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';

describe('server-owned Task role assignment', () => {
  it('updates a dedicated role column only after the migration columns exist', async () => {
    const query = jest.fn(async (sql: string, _params: unknown[]) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      // RH-P3.C1: the role write now emits task.updated in its transaction.
      if (sql.includes('pg_advisory_xact_lock') || sql.startsWith('INSERT INTO feed_events')) return { rows: [] };
      if (sql.includes('FROM pg_attribute')) return { rows: [{ present: true }] };
      if (sql.startsWith('UPDATE tasks SET')) return { rows: [{ id: taskId }] };
      if (/SELECT id, kind, bound_task_id, legacy_identity FROM principals/.test(sql)) {
        return { rows: [{ id: 'p', kind: 'human', bound_task_id: null, legacy_identity: false }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const manager = new TaskManagerDB({
      query,
      connect: async () => ({ query, release: jest.fn() }),
    } as any);
    await expect(manager.assignTaskRoles(taskId, { verifierPrincipalId: principalId })).resolves.toBe('updated');
    const update = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE tasks SET'));
    expect(update?.[0]).toContain('verifier_principal_id');
    expect(update?.[0]).toContain('owner_principal_id <>');
    expect(update?.[1]).toEqual([taskId, principalId]);
  });

  it('returns the stable self-review outcome when the guarded update refuses', async () => {
    const query = jest.fn(async (sql: string) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('FROM pg_attribute')) return { rows: [{ present: true }] };
      if (sql.startsWith('UPDATE tasks SET')) return { rows: [] };
      if (sql.startsWith('SELECT id, owner_principal_id')) {
        return { rows: [{ id: taskId, owner_principal_id: principalId }] };
      }
      if (/SELECT id, kind, bound_task_id, legacy_identity FROM principals/.test(sql)) {
        return { rows: [{ id: 'p', kind: 'human', bound_task_id: null, legacy_identity: false }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const manager = new TaskManagerDB({
      query,
      connect: async () => ({ query, release: jest.fn() }),
    } as any);
    await expect(manager.assignTaskRoles(taskId, { verifierPrincipalId: principalId })).resolves.toBe('self_review');
  });

  it('keeps role ids out of generic Task POST/PATCH', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tasks.ts'), 'utf8');
    expect(source).toContain('SERVER_WRITTEN_TASK_ROLE_FIELDS');
    expect(source).toContain("router.patch('/:id/roles'");
    expect(source.match(/rejectCallerWrittenTaskRoles\(req, res\)/g)).toHaveLength(2);
    expect(source).toContain('CLAIMANT_VERIFIER_CONFLICT');
    expect(source).toContain('SERVICE_INVOKE_REQUIRED');
  });
});
