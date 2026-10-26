import { toolByName } from '../mcp/registry';

describe('dedicated Task archive MCP surface', () => {
  test('publishes single and completed-only bulk archive tools beside existing move and restore', () => {
    expect(toolByName('relayhall_task_archive')).toBeDefined();
    expect(toolByName('relayhall_task_archive_bulk')).toBeDefined();
    expect(toolByName('relayhall_task_move')).toBeDefined();
    expect(toolByName('relayhall_task_restore')).toBeDefined();
  });

  test('rejects malformed archive arguments before dispatch', async () => {
    const single = toolByName('relayhall_task_archive')!;
    const bulk = toolByName('relayhall_task_archive_bulk')!;
    const ctx = {} as Parameters<typeof single.handler>[1];
    const id = '11111111-1111-4111-8111-111111111111';
    await expect(single.handler({ task: 'short', idempotencyKey: 'archive-fixture-token-1' }, ctx))
      .rejects.toThrow('complete Task UUID');
    await expect(single.handler({ task: id, idempotencyKey: 'short' }, ctx))
      .rejects.toThrow('16–128');
    await expect(single.handler({ task: id, reason: '  ', idempotencyKey: 'archive-fixture-token-2' }, ctx))
      .rejects.toThrow('non-empty string');
    await expect(bulk.handler({ taskIds: [] }, ctx)).rejects.toThrow('1–200');
    await expect(bulk.handler({ taskIds: Array(201).fill(id) }, ctx)).rejects.toThrow('1–200');
    await expect(bulk.handler({ taskIds: [id, 'short'] }, ctx)).rejects.toThrow('taskIds[1]');
  });
});
