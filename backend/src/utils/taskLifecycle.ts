// taskLifecycle.ts — lifecycle-gate helpers for task creation/status moves.
//
// Part of the "Lifecycle gates" work (task 557acae8):
//  - autoStart must be an explicit opt-in (default FALSE) so freshly created
//    tasks are never silently picked up by the orchestration loop.
//  - Moving ideas -> todo without a definitionOfDone yields a WARNING (not a
//    block) so humans/agents are nudged to define done-ness before a task
//    becomes eligible for pickup.

/**
 * Resolve the autoStart value for task creation.
 * Missing / null / anything not explicitly true resolves to FALSE.
 * Accepts boolean true or the string 'true' (lenient for CLI/HTTP clients).
 */
export function resolveCreateAutoStart(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * True when a definitionOfDone value is meaningfully present:
 * a non-empty string or a non-empty array of non-empty strings.
 */
export function hasDefinitionOfDone(dod: unknown): boolean {
  if (typeof dod === 'string') return dod.trim().length > 0;
  if (Array.isArray(dod)) return dod.some(item => typeof item === 'string' ? item.trim().length > 0 : item != null);
  return false;
}

/**
 * Returns a warning string when a task is being moved ideas -> todo without a
 * definitionOfDone; undefined otherwise. Non-blocking by design.
 */
export function dodWarningForStatusChange(
  oldStatus: string | undefined,
  newStatus: string | undefined,
  definitionOfDone: unknown
): string | undefined {
  if (oldStatus !== 'ideas' || newStatus !== 'todo') return undefined;
  if (hasDefinitionOfDone(definitionOfDone)) return undefined;
  return 'Task moved ideas -> todo without a definitionOfDone. Add one (relayhall update <id> --definition-of-done ...) so pickup/review gates have acceptance criteria.';
}
