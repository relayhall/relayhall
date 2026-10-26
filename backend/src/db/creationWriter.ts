import type { CreationTransaction } from './creationTransaction';
import type { FeedActorRef } from '../services/FeedEventService';

/**
 * Who writes a created object (card 5854f0d6, round 2; Notifications and
 * Timeline design section 4.3): the creation transaction that composes it,
 * which carries its actor, or outside one the acting principal itself. A
 * create takes this as a REQUIRED argument, so no caller can create a Report
 * or a Phase without naming who wrote it; a write with no principal passes
 * `{}` and is unattributed on purpose. Type-only imports: this module loads
 * nothing at runtime, so it adds no edge to the import graph.
 */
export type CreationWriter = CreationTransaction | FeedActorRef;

/** The composing transaction, when `writer` is one. */
export function creationTransactionOf(writer: CreationWriter): CreationTransaction | undefined {
  return writer !== null && typeof writer === 'object' && 'client' in writer && 'afterCommit' in writer
    ? writer as CreationTransaction : undefined;
}

/** The feed actor columns a creation records: the transaction's actor, or the writer itself. */
export function creationFeedActor(writer: CreationWriter): { actorPrincipalId: string | null; actorHandle: string | null } {
  const actor: FeedActorRef = creationTransactionOf(writer)?.actor ?? writer as FeedActorRef;
  return { actorPrincipalId: actor.principalId ?? null, actorHandle: actor.handle ?? null };
}
