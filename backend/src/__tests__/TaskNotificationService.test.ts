import { TaskNotificationService } from '../services/TaskNotificationService';

function fakePool() {
  const row: any = { status: 'missing', attempt_count: 0, receipt: null };
  return {
    row,
    query: jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes('INSERT INTO task_notification_deliveries')) {
        if (row.status === 'missing') row.status = 'pending';
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('WITH candidate AS')) {
        if (['pending', 'failed'].includes(row.status)) {
          row.status = 'sending';
          row.attempt_count += 1;
          return { rowCount: 1, rows: [{ id: 'delivery-1', status: 'sending', attempt_count: row.attempt_count }] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT status,receipt')) {
        return { rowCount: 1, rows: [{ status: row.status, receipt: row.receipt }] };
      }
      if (sql.includes("SET status='sent'")) {
        row.status = 'sent';
        row.receipt = JSON.parse(params[1]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SET status='failed'")) {
        row.status = 'failed';
        row.last_error_code = params[1];
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('FROM task_notification_deliveries') && sql.includes('ORDER BY created_at')) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
}

const request = {
  taskId: '11111111-1111-4111-8111-111111111111',
  kind: 'review-escalation' as const,
  stateVersion: 'attempt-3',
  destination: 'discord-thread-1',
  message: 'Review retries exhausted',
};

describe('TaskNotificationService', () => {
  test('failed delivery remains retryable and dedup completes only after a receipt', async () => {
    const pool = fakePool();
    const sender = jest.fn()
      .mockRejectedValueOnce(new Error('Discord token secret must not leak'))
      .mockResolvedValueOnce({
        transport: 'discord',
        destinationId: request.destination,
        providerMessageId: 'message-123',
        acknowledgedAt: '2026-07-16T07:00:00.000Z',
      });
    const service = new TaskNotificationService(pool as any, sender);

    const failed = await service.deliver(request);
    expect(failed.status).toBe('failed');
    expect(pool.row.status).toBe('failed');
    expect(pool.row.last_error_code).not.toContain('secret');

    const sent = await service.deliver(request);
    expect(sent.status).toBe('sent');
    expect(pool.row.status).toBe('sent');
    expect(pool.row.receipt.providerMessageId).toBe('message-123');

    const duplicate = await service.deliver(request);
    expect(duplicate.status).toBe('deduplicated');
    expect(sender).toHaveBeenCalledTimes(2);
  });

  test('rejects transport success without a durable provider receipt', async () => {
    const pool = fakePool();
    const service = new TaskNotificationService(pool as any, jest.fn(async () => ({
      transport: 'discord',
      destinationId: request.destination,
      providerMessageId: '',
      acknowledgedAt: '2026-07-16T07:00:00.000Z',
    })));

    const result = await service.deliver(request);
    expect(result.status).toBe('failed');
    expect(pool.row.status).toBe('failed');
  });
});
