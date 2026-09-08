import { Pool } from 'pg';
import {
  compileTaskOperatingContract,
  maskUnambiguousSecrets,
  TASK_ELEMENT_INPUT_SCHEMA,
  TASK_STREAM_ENTRY_LIMIT,
  TaskElementError,
  TaskElementService,
} from '../services/TaskElementService';
import { migrationCompatibilityPrefix } from '../db/migrate';

describe('Task element operating contract', () => {
  const service = new TaskElementService({} as Pool);
  const actor = { principalId: '11111111-1111-4111-8111-111111111111', handle: 'worker' };

  test('is compiled from the same constants used by validation', () => {
    expect(TASK_ELEMENT_INPUT_SCHEMA.stream.entryLimitCharacters).toBe(TASK_STREAM_ENTRY_LIMIT);
    expect(compileTaskOperatingContract()).toContain(`${TASK_STREAM_ENTRY_LIMIT} characters`);
    expect(compileTaskOperatingContract()).toContain('stable `id`');
    expect(compileTaskOperatingContract()).toContain('commit together or not at all');
  });

  test('masks only unambiguous secret shapes and preserves hashes', () => {
    const sha = 'a'.repeat(64);
    const result = maskUnambiguousSecrets([
      'sk-abcdefghijklmnop',
      'ghp_abcdefghijklmnop',
      'eyJabc.def.ghi',
      sha,
    ].join('\n'));
    expect(result.masked).toBe(3);
    expect(result.content).toContain('sk-[MASKED]');
    expect(result.content).toContain('ghp_[MASKED]');
    expect(result.content).toContain('[MASKED JWT]');
    expect(result.content).toContain(sha);
  });

  test('dry-run validates append without touching storage', async () => {
    await expect(service.append('task', { content: 'ready', dryRun: true }, actor))
      .resolves.toMatchObject({ valid: true, dryRun: true });
    await expect(service.append('task', { content: '', dryRun: true }, actor))
      .rejects.toMatchObject({ code: 'INVALID_STREAM_CONTENT', field: 'content' });
  });

  test('finish keeps Reports-first even in dry-run', async () => {
    await expect(service.finish('task', {
      handover: 'done',
      report: { title: 'Evidence', content: 'Verified evidence' },
      dryRun: true,
    }, actor)).resolves.toMatchObject({ valid: true, targetStatus: 'review' });
    await expect(service.finish('task', { handover: 'done', dryRun: true }, actor))
      .rejects.toMatchObject({ code: 'REPORT_REQUIRED' });
  });

  test('typed References validate base and inert plugin kinds', async () => {
    await expect(service.createReference('task', {
      kind: 'repository', targetUri: 'https://example.test/repo', label: 'Repo', dryRun: true,
    }, actor)).resolves.toMatchObject({ valid: true, kind: 'repository' });
    await expect(service.createReference('task', {
      kind: 'plugin:demo:artifact', targetUri: 'urn:demo:1', label: 'Artifact', dryRun: true,
    }, actor)).resolves.toMatchObject({ valid: true, kind: 'plugin:demo:artifact' });
    await expect(service.createReference('task', {
      kind: 'free-form', targetUri: 'urn:bad', label: 'Bad', dryRun: true,
    }, actor)).rejects.toMatchObject({ code: 'INVALID_REFERENCE_KIND' });
  });

  test('redaction is root-only even in dry-run', async () => {
    await expect(service.redact(
      'task', '22222222-2222-4222-8222-222222222222',
      { mode: 'tombstone', reason: 'owner-order', dryRun: true }, actor,
    )).rejects.toBeInstanceOf(TaskElementError);
  });

  test('legacy replay shims preserve immutable migration files', () => {
    expect(migrationCompatibilityPrefix('066_explicit_review_workflow.sql')).toContain('DROP CONSTRAINT');
    expect(migrationCompatibilityPrefix('068_kebab_case_subtask_states.sql')).toContain('DROP CONSTRAINT');
    const taskElementPrefix = migrationCompatibilityPrefix('086_task_element_substrate.sql');
    expect(taskElementPrefix).toContain('CREATE TABLE IF NOT EXISTS task_execution_leases');
    expect(taskElementPrefix).toContain('uq_task_execution_leases_active_task');
    expect(taskElementPrefix).toContain('uq_task_execution_leases_active_resource');
    expect(migrationCompatibilityPrefix('087_audit_events.sql')).toBe('');
  });
});
