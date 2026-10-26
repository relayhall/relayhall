import fs from 'fs';
import path from 'path';
import { TaskManagerDB } from '../services/TaskManagerDB';
import { accessVehicleService } from '../services/AccessVehicleService';

jest.mock('../services/AuditService', () => ({ auditService: { record: jest.fn() } }));

const taskId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';

describe('server-owned Task role assignment', () => {
  afterEach(() => jest.restoreAllMocks());

  it('updates a dedicated role column only after the migration columns exist', async () => {
    const materialize = jest.spyOn(accessVehicleService, 'materializeRole').mockResolvedValue([]);
    jest.spyOn(accessVehicleService, 'detachRole').mockResolvedValue(undefined);
    const query = jest.fn(async (sql: string, _params: unknown[]) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      // RH-P3.C1: the role write now emits task.updated in its transaction.
      if (sql.includes('pg_advisory_xact_lock') || sql.startsWith('INSERT INTO feed_events')) return { rows: [] };
      if (sql.includes('FROM pg_attribute')) return { rows: [{ present: true }] };
      // Owner ruling E462 S4b: the lock also reads `verification_none`, which a Verifier clears.
      if (sql.includes('SELECT shepherd_principal_id, verifier_principal_id, verification_none FROM tasks'))
        return { rows: [{ shepherd_principal_id: null, verifier_principal_id: null, verification_none: false }] };
      if (sql.startsWith('UPDATE tasks SET')) return { rows: [{ id: taskId, project_id: null,
        owner_principal_id: null, shepherd_principal_id: null, verifier_principal_id: principalId }] };
      if (/SELECT id, kind, bound_task_id, legacy_identity FROM principals/.test(sql)) {
        return { rows: [{ id: 'p', kind: 'human', bound_task_id: null, legacy_identity: false }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const manager = new TaskManagerDB({
      query,
      connect: async () => ({ query, release: jest.fn() }),
    } as any);
    const assigner = { principalId, handle: 'fixture', role: 'admin', scopes: ['root'], authenticated: true,
      delegation: null } as any;
    await expect(manager.assignTaskRoles(taskId, { verifierPrincipalId: principalId },
      { principalId, handle: 'fixture', authMethod: 'system' }, undefined, assigner)).resolves.toBe('updated');
    expect(materialize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      taskId, principalId, role: 'verifier', assigner,
    }));
    const update = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE tasks SET'));
    expect(update?.[0]).toContain('verifier_principal_id');
    expect(update?.[0]).toContain('owner_principal_id <>');
    // Card 41e24358: a Verifier written through the roles surface records its
    // source as 'assigned' (migration 155), in the same UPDATE.
    expect(update?.[0]).toContain('verifier_source');
    expect(update?.[1]).toEqual([taskId, principalId, 'assigned']);
  });

  it('returns the stable self-review outcome when the guarded update refuses', async () => {
    const query = jest.fn(async (sql: string) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('FROM pg_attribute')) return { rows: [{ present: true }] };
      if (sql.includes('SELECT shepherd_principal_id, verifier_principal_id, verification_none FROM tasks'))
        return { rows: [{ shepherd_principal_id: null, verifier_principal_id: null, verification_none: false }] };
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
    // Card 41e24358 (Q2 (b), check F6): POST admits verifierPrincipalId alone,
    // through the create-only exception; PATCH keeps the plain refusal.
    expect(source.match(/rejectCallerWrittenTaskRoles\(req, res(, \{ create: true \})?\)/g)).toHaveLength(2);
    expect(source.match(/rejectCallerWrittenTaskRoles\(req, res, \{ create: true \}\)/g)).toHaveLength(1);
    expect(source).toContain("const CREATE_ONLY_TASK_ROLE_FIELDS: ReadonlySet<string> = new Set(['verifierPrincipalId', 'verificationNone']);");
    expect(source).toContain('CLAIMANT_VERIFIER_CONFLICT');
    expect(source).toContain('SERVICE_INVOKE_REQUIRED');
  });
});
