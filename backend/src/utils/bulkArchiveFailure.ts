import { ForbiddenFault, NotFoundFault, ConflictFault } from './httpErrors';
import { LifecyclePolicyDeniedError } from '../services/LifecyclePolicyService';
import { AssignmentAccessError } from '../services/AccessVehicleService';
/** Fixed safe diagnostics; this does not change archive authority. */
export function bulkArchiveFailure(error: unknown): { code: string; error: string } {
  try {
    if (error instanceof NotFoundFault) return { code: 'NOT_FOUND', error: 'Task not found' };
    if (error instanceof ConflictFault && error.code === 'NOT_COMPLETED') return { code: 'NOT_COMPLETED', error: 'Task is no longer Completed' };
    if (error instanceof ForbiddenFault) return { code: 'FORBIDDEN', error: 'Lifecycle authority does not permit archival' };
    if (error instanceof LifecyclePolicyDeniedError) return { code: 'LIFECYCLE_POLICY_DENIED', error: 'Lifecycle policy denied archival' };
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    if (error instanceof AssignmentAccessError && code?.value === 'ASSIGNMENT_REFERENCE_BUSY') return { code: 'ASSIGNMENT_REFERENCE_BUSY', error: 'Assignment references are busy; retry' };
    if (code?.value === 'PZ001') return { code: 'TASK_REVIEW_EVIDENCE_BUSY', error: 'Review evidence is busy; retry' };
  } catch { /* Unknown inspection failure uses the same safe envelope. */ }
  return { code: 'ERROR', error: 'The Task could not be archived' };
}
