import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { discordThreadService } from './DiscordThreadService';

export type TaskNotificationKind = 'review-escalation' | 'blocked-human' | 'stale' | 'review';

export interface TaskNotificationRequest {
  taskId: string;
  kind: TaskNotificationKind;
  stateVersion: string;
  destination: string;
  message: string;
}

export interface TaskNotificationReceipt {
  transport: string;
  destinationId: string;
  providerMessageId: string;
  acknowledgedAt: string;
}

export interface TaskNotificationResult {
  status: 'sent' | 'deduplicated' | 'deferred' | 'failed';
  idempotencyKey: string;
  receipt?: TaskNotificationReceipt;
}

export type TaskNotificationSender = (
  request: TaskNotificationRequest,
) => Promise<TaskNotificationReceipt>;

function errorCode(error: unknown): string {
  const candidate = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
  if (/^[A-Za-z0-9_-]{1,80}$/.test(candidate)) return candidate.toLowerCase();
  const name = error instanceof Error ? error.name : 'notification_error';
  return String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 80) || 'notification_error';
}

function retryDelaySeconds(attemptCount: number): number {
  return Math.min(900, 15 * (2 ** Math.max(0, attemptCount - 1)));
}

function validateReceipt(receipt: TaskNotificationReceipt): void {
  if (!receipt?.transport || !receipt.destinationId || !receipt.providerMessageId || !receipt.acknowledgedAt) {
    throw new Error('transport_receipt_incomplete');
  }
}

export class TaskNotificationService {
  constructor(
    private readonly pool: Pool = defaultPool,
    private readonly sender: TaskNotificationSender = async (request) => {
      const result = await discordThreadService.sendSystemChannelMessage(request.destination, request.message);
      if (!result.messageId) throw new Error('discord_missing_message_receipt');
      return {
        transport: 'discord',
        destinationId: request.destination,
        providerMessageId: result.messageId,
        acknowledgedAt: new Date().toISOString(),
      };
    },
  ) {}

  buildIdempotencyKey(request: Omit<TaskNotificationRequest, 'message'>): string {
    return `notify:${request.taskId}:${request.kind}:${request.stateVersion}:${request.destination}`;
  }

  async deliver(request: TaskNotificationRequest): Promise<TaskNotificationResult> {
    if (!request.taskId || !request.kind || !request.stateVersion || !request.destination || !request.message) {
      throw new Error('Task notification request is incomplete');
    }
    const idempotencyKey = this.buildIdempotencyKey(request);
    await this.pool.query(
      `INSERT INTO task_notification_deliveries
         (task_id, kind, destination, transport, idempotency_key, payload)
       VALUES ($1,$2,$3,'discord',$4,$5::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [request.taskId, request.kind, request.destination, idempotencyKey, JSON.stringify({ message: request.message, stateVersion: request.stateVersion })],
    );

    const claimed = await this.pool.query(
      `WITH candidate AS (
         SELECT id FROM task_notification_deliveries
          WHERE idempotency_key=$1
            AND (status='pending'
              OR (status='failed' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
              OR (status='sending' AND updated_at < NOW() - INTERVAL '5 minutes'))
          FOR UPDATE SKIP LOCKED
       )
       UPDATE task_notification_deliveries d
          SET status='sending', attempt_count=d.attempt_count+1,
              updated_at=NOW(), last_error_code=NULL
         FROM candidate c WHERE d.id=c.id
       RETURNING d.id,d.status,d.attempt_count`,
      [idempotencyKey],
    );

    if (!claimed.rowCount) {
      const existing = await this.pool.query(
        'SELECT status,receipt FROM task_notification_deliveries WHERE idempotency_key=$1',
        [idempotencyKey],
      );
      if (existing.rows[0]?.status === 'sent') {
        return { status: 'deduplicated', idempotencyKey, receipt: existing.rows[0].receipt };
      }
      return { status: 'deferred', idempotencyKey };
    }

    const deliveryId = claimed.rows[0].id;
    const attemptCount = Number(claimed.rows[0].attempt_count);
    try {
      const receipt = await this.sender(request);
      validateReceipt(receipt);
      await this.pool.query(
        `UPDATE task_notification_deliveries
            SET status='sent', receipt=$2::jsonb, sent_at=NOW(), updated_at=NOW(),
                next_attempt_at=NULL, last_error_code=NULL
          WHERE id=$1 AND status='sending'`,
        [deliveryId, JSON.stringify(receipt)],
      );
      return { status: 'sent', idempotencyKey, receipt };
    } catch (error) {
      await this.pool.query(
        `UPDATE task_notification_deliveries
            SET status='failed', last_error_code=$2,
                next_attempt_at=NOW()+($3*INTERVAL '1 second'), updated_at=NOW()
          WHERE id=$1 AND status='sending'`,
        [deliveryId, errorCode(error), retryDelaySeconds(attemptCount)],
      );
      return { status: 'failed', idempotencyKey };
    }
  }

  async retryDue(limit = 20): Promise<TaskNotificationResult[]> {
    const due = await this.pool.query(
      `SELECT task_id,kind,destination,payload
         FROM task_notification_deliveries
        WHERE status IN ('pending','failed','sending')
          AND (status <> 'failed' OR next_attempt_at IS NULL OR next_attempt_at <= NOW())
          AND (status <> 'sending' OR updated_at < NOW() - INTERVAL '5 minutes')
        ORDER BY created_at ASC LIMIT $1`,
      [Math.max(1, Math.min(100, limit))],
    );
    const results: TaskNotificationResult[] = [];
    for (const row of due.rows) {
      const stateVersion = String(row.payload?.stateVersion || 'legacy');
      const message = String(row.payload?.message || '').trim();
      if (!message) continue;
      results.push(await this.deliver({
        taskId: row.task_id,
        kind: row.kind,
        destination: row.destination,
        stateVersion,
        message,
      }));
    }
    return results;
  }
}

export const taskNotificationService = new TaskNotificationService();
