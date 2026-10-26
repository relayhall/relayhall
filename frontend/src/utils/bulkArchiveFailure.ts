const MESSAGES: Record<string, string> = {
  FORBIDDEN: 'Lifecycle authority does not permit archival',
  LIFECYCLE_POLICY_DENIED: 'Lifecycle policy denied archival',
  ASSIGNMENT_REFERENCE_BUSY: 'Assignment references are busy',
  TASK_REVIEW_EVIDENCE_BUSY: 'Review evidence is busy',
  NOT_FOUND: 'Task not found', NOT_COMPLETED: 'Task is no longer completed',
  ERROR: 'Archive failed', BULK_ARCHIVE_FAILED: 'Bulk archive failed',
  REQUEST_FAILED: 'Request failed',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function bulkArchiveReason(code: unknown): { code: string; message: string } {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(MESSAGES, code)
    ? { code, message: MESSAGES[code] } : { code: 'ERROR', message: MESSAGES.ERROR };
}
export function bulkArchiveReference(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}
export function describeBulkArchiveFailures(failures: Array<{ code?: unknown; errorId?: unknown }>): string {
  const counts = new Map<string, number>();
  for (const failure of failures) {
    const { code } = bulkArchiveReason(failure.code);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const groups = [...counts];
  return groups.slice(0, 3).map(([code, count]) => `${bulkArchiveReason(code).message}: ${count}`).join('; ')
    + (groups.length > 3 ? `; ${groups.slice(3).reduce((n, [, count]) => n + count, 0)} other failures` : '');
}
export type BulkArchiveOutcome = { id: string; archived: boolean; confirmed: boolean; code: string; references: string[] };
export function bulkArchiveOutcome(id: string, result: { archived?: unknown; code?: unknown; errorId?: unknown }, extraReferences: unknown[] = []): BulkArchiveOutcome {
  const archived = result.archived === true;
  return { id, archived, confirmed: typeof result.archived === 'boolean', code: archived ? (result.code === 'ALREADY_ARCHIVED' ? 'ALREADY_ARCHIVED' : 'ARCHIVED') : bulkArchiveReason(result.code).code,
    references: [...new Set([result.errorId, ...extraReferences].map(bulkArchiveReference).filter((ref): ref is string => ref !== null))] };
}
export function copyBulkArchiveOutcomes(outcomes: BulkArchiveOutcome[]): string {
  return outcomes.map(row => `${row.id}\t${bulkArchiveOutcomeLabel(row)}\t${row.code}\t${row.references.join(', ')}`).join('\n');
}
export function bulkArchiveOutcomeLabel(row: BulkArchiveOutcome): string {
  return !row.confirmed ? 'Outcome not confirmed' : row.archived ? (row.code === 'ALREADY_ARCHIVED' ? 'Already archived' : 'Archived') : 'Not archived';
}
