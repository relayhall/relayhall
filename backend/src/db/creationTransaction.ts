import type { Pool, PoolClient } from 'pg';
import type { TaskActor } from '../services/TaskHistoryService';
import { logCaughtFailure } from '../utils/secretSafeLog';

/** An explicitly supplied transaction lets canonical creation operations compose.
 * It carries the caller and owns post-commit effects; it never changes authority. */
export interface CreationTransaction {
  readonly client: PoolClient;
  /** Server-selected creation channel; ordinary callers omit the context. */
  readonly source?: 'ordinary' | 'blueprint';
  readonly actor: TaskActor;
  afterCommit(effect: () => void | Promise<void>): void;
}
export async function runCreationTransaction<T>(pool: Pool, actor: TaskActor,
  operation: (transaction: CreationTransaction) => Promise<T>, source: 'ordinary' | 'blueprint' = 'ordinary'): Promise<T> {
  if (!actor.principalId || !actor.authorization?.authenticated
    || actor.authorization.principalId !== actor.principalId) throw new Error('A resolved creation actor is required');
  const client = await pool.connect(); const effects: Array<() => void | Promise<void>> = [];
  const transaction: CreationTransaction = { client, actor, source, afterCommit: effect => effects.push(effect) };
  let value: T;
  try {
    // One database snapshot for whole-plan grant reads and canonical writes.
    // Concurrent authority/row mutations may cause a serialization refusal;
    // the caller retries with the same idempotency key.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    value = await operation(transaction);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
    throw error;
  }
  client.release();
  // A post-commit notifier cannot turn a committed instantiation into a
  // failure that invites duplicate work. Its canonical service logs failures.
  for (const effect of effects) { try { await effect(); } catch (error) { logCaughtFailure('[Creation transaction] post-commit delivery failed', error); } }
  return value;
}
