import { AssignmentAccessError } from '../services/AccessVehicleService';
import type { Pool, PoolClient } from 'pg';
import type { TaskActor } from '../services/TaskHistoryService';
import { lockDependencyGraph } from './dependencyGraph';
import { logCaughtFailure } from '../utils/secretSafeLog';

/** An explicitly supplied transaction lets canonical creation operations compose.
 * It carries the caller and owns post-commit effects; it never changes authority. */
export interface CreationTransaction {
  readonly client: PoolClient;
  /** Established before the first snapshot or object/feed lock. */
  readonly dependencyGraphLocked?: true;
  /** Server-selected creation channel; ordinary callers omit the context. */
  readonly source?: 'ordinary' | 'blueprint';
  readonly actor: TaskActor;
  afterCommit(effect: () => void | Promise<void>): void;
}
export async function runCreationTransaction<T>(pool: Pool, actor: TaskActor,
  operation: (transaction: CreationTransaction) => Promise<T>, source: 'ordinary' | 'blueprint' = 'ordinary',
  options: { dependencyGraphWrite?: boolean; isolation?: 'repeatable-read' | 'read-committed' } = {}): Promise<T> {
  if (!actor.principalId || !actor.authorization?.authenticated
    || actor.authorization.principalId !== actor.principalId) throw new Error('A resolved creation actor is required');
  const client = await pool.connect(); const effects: Array<() => void | Promise<void>> = [];
  const transaction: CreationTransaction = { client, actor, source, afterCommit: effect => effects.push(effect) };
  let value: T;
  try {
    // Whole-plan callers retain their original repeatable-read snapshot.
    // Standalone Report creation explicitly uses current reads under ordered
    // principal row locks, then revalidates its authenticated chain/credential.
    // This avoids treating asynchronous last-seen telemetry as a policy change.
    await client.query(options.isolation === 'read-committed'
      ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    if (options.dependencyGraphWrite) {
      await lockDependencyGraph(client);
      Object.defineProperty(transaction, 'dependencyGraphLocked', { value: true });
    }
    value = await operation(transaction);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
    // SERIALIZABLE may discover the conflict at COMMIT, after reference SQL.
    // Preserve whole-owner rollback/effect suppression and the public retry code.
    if ((error as {code?: string})?.code === '40001') throw new AssignmentAccessError(409, 'ASSIGNMENT_REFERENCE_BUSY', 'Assignment reference lifecycle busy; roll back and retry the transaction');
    throw error;
  }
  client.release();
  // A post-commit notifier cannot turn a committed instantiation into a
  // failure that invites duplicate work. Its canonical service logs failures.
  for (const effect of effects) { try { await effect(); } catch (error) { logCaughtFailure('[Creation transaction] post-commit delivery failed', error); } }
  return value;
}
