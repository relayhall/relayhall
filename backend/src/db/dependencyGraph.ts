import type { PoolClient } from 'pg';
import type { CreationTransaction } from './creationTransaction';

/** Must be the first database operation after BEGIN/SET LOCAL, before any
 * snapshot, row lock or feed lock. All edge writers use this ordering. */
export async function lockDependencyGraph(client: PoolClient, transaction?: CreationTransaction): Promise<void> {
  if (transaction) {
    // A late lock cannot refresh a REPEATABLE READ snapshot and can invert the
    // graph/feed lock order. The outer owner must opt in before its callback.
    if (!transaction.dependencyGraphLocked) throw new Error('Dependency graph writes require a prepared creation transaction');
    return;
  }
  await client.query('LOCK TABLE task_dependencies IN SHARE ROW EXCLUSIVE MODE');
}
