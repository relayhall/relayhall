/**
 * Assignee-filter parsing for GET /tasks/board (epic 60558599, CB-4).
 *
 * Extracted from the route so the mapping is testable without standing up
 * Express: the board is what the UI renders, so a silent mis-parse here shows
 * up as a wrong board rather than an error.
 *
 * FAIL-CLOSED RULE: every one of these params narrows the result set. Express's
 * qs parser turns `?owner[]=x`, `?owner=x&owner=y` and `?owner[k]=v` into
 * arrays or objects, and a guard that merely ignores those shapes DROPS the
 * filter — widening the response to the whole board. A filter that fails open
 * is worse than one that errors, so any non-scalar value matches nothing.
 */
export interface BoardOwnershipFilters {
  ownerPrincipalId?: string;
  ownerHandle?: string;
  unassigned?: boolean;
  /** Set when the request can only ever match nothing. */
  __empty?: true;
}

/** A param the caller supplied in a shape we refuse to interpret. */
const INVALID = Symbol('invalid-scalar');

/**
 * Reads a query param that must be a single scalar. Arrays and objects are
 * rejected rather than coerced: String(['true','true']) is 'true,true', which
 * would quietly disable the filter it was meant to set.
 */
function scalarParam(value: unknown): string | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return INVALID;
}

export function buildBoardOwnershipFilters(
  query: Record<string, unknown>,
  callerPrincipalId: string | null
): BoardOwnershipFilters {
  const filters: BoardOwnershipFilters = {};

  const mine = scalarParam(query.mine);
  const owner = scalarParam(query.owner);
  const unassigned = scalarParam(query.unassigned);

  if (mine === INVALID || owner === INVALID || unassigned === INVALID) {
    return { __empty: true };
  }

  if (mine === 'true') {
    // No principal resolved: the caller is Assignee of nothing yet.
    if (!callerPrincipalId) return { __empty: true };
    filters.ownerPrincipalId = callerPrincipalId;
  }

  const ownerHandle = typeof owner === 'string' ? owner.trim() : '';
  if (ownerHandle) filters.ownerHandle = ownerHandle;

  if (unassigned === 'true') filters.unassigned = true;

  return filters;
}
