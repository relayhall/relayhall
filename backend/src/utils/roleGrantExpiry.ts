/**
 * The date an assigning act sets on the grant rows its assignment writes.
 *
 * AZ-A10 clause 6 (RATIFIED 2026-10-10, E43), for a Connector or a human
 * assignee: "default `expires_at` = materialization + 3 months. The assigning
 * act may set any later date, or `unlimited` (`expires_at` NULL): execution
 * assignment and `PATCH /tasks/:id/roles` gain an optional
 * `roleGrantExpiresAt` (an ISO date or `'unlimited'`). There is no sliding.
 * Three months is the DEFAULT, not a floor: an earlier date is admitted (E43
 * Q4: "shortenable by the owner")."
 *
 * E62 answered who "the owner" is: "whoever performs the assigning act
 * (execution assignment or PATCH /tasks/:id/roles) may set an EARLIER date as
 * well as a later one or 'unlimited'". So nothing here asks WHO is writing:
 * the only gate is the assigning act's own gate (tasks:write, write on the
 * Task, and services:invoke for an execution assignment). A role check on the
 * earlier date would be the reading E62 rejected.
 *
 * The value is a date and a timezone question at once, so it uses the
 * deadline conventions exactly (card 7d38a6e0): an ISO-8601 instant with `Z`
 * or an offset, or `{ local, zone }` resolved by PostgreSQL's timezone
 * database (utils/dueAtResolver.ts — JavaScript never builds an instant from
 * a wall clock). A date with no time of day is refused: "the row expires that
 * day" names no instant until somebody chooses a zone, and choosing one for
 * the caller is the substitution the deadline contract refuses.
 *
 * What is NOT decided here: whether the instant is in the future. That needs
 * the database clock and belongs to the assignment's own transaction
 * (AccessVehicleService), where a refusal rolls the whole act back.
 */
import { normalizeTaskDueAtWrite, TaskFieldError, type DueAtResolution } from './taskWriteFields';
import type { DueAtResolver } from './dueAtResolver';

/** The request field, spelled as clause 6 spells it. */
export const ROLE_GRANT_EXPIRY_FIELD = 'roleGrantExpiresAt';

/** Clause 6's literal for `expires_at` NULL: until the task or the assignment ends. */
export const ROLE_GRANT_EXPIRY_UNLIMITED = 'unlimited';

/**
 * Clause 6's default, as PostgreSQL interval text. Added in UTC, so "three
 * months" is three calendar months whatever the session timezone is.
 */
export const ROLE_GRANT_DEFAULT_INTERVAL = '3 months';

/** One canonical spelling for every instant this feature returns or stores. */
export const ROLE_GRANT_EXPIRY_ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/**
 * A NORMALIZED request. Absence (the field omitted) is not represented: the
 * caller passes `undefined`, which means the clause-6 default.
 */
export type RoleGrantExpiryRequest =
  | { kind: 'unlimited' }
  | { kind: 'instant'; instant: string; resolution?: DueAtResolution };

/**
 * Where the NORMALIZED date rides from the route to the assignment's
 * transaction: a Symbol-keyed property of the write payload, which no JSON
 * request body can carry. The payload is body-shaped (PATCH /tasks/:id
 * spreads the request body into it), so a string key here would be a
 * request field nobody documented: any Task writer could send it, without
 * the assigning act and without its services:invoke gate, and re-date,
 * shorten or extend an assignment's rows with a value no normalizer saw
 * (review round 1, B1). Only `resolveExecutionProfileWrite` sets it, after
 * the act's gate and beside the executionProfile that performs the act.
 */
const ASSIGNING_ACT_EXPIRY = Symbol('assigningActRoleGrantExpiry');

/** Attach the assigning act's normalized date to its write payload.
 * `undefined` (the field omitted: the default) attaches nothing. */
export function carryAssigningActExpiry(payload: object, value: RoleGrantExpiryRequest | undefined): void {
  if (value === undefined) return;
  (payload as Record<PropertyKey, unknown>)[ASSIGNING_ACT_EXPIRY] = value;
}

/**
 * The date the assigning act set, or `undefined` for the clause-6 default.
 * Reads ONLY the out-of-band key: a caller-supplied body field of any name
 * is never the date.
 */
export function assigningActExpiry(payload: unknown): RoleGrantExpiryRequest | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  return (payload as Record<PropertyKey, unknown>)[ASSIGNING_ACT_EXPIRY] as RoleGrantExpiryRequest | undefined;
}

const ROLE_GRANT_EXPIRY_REFUSAL = 'roleGrantExpiresAt must be an ISO-8601 date-time naming an instant '
  + '(for example 2026-11-10T17:00:00Z), or { local, zone } naming a local wall clock and the IANA '
  + 'timezone to read it in (for example { "local": "2026-11-10T19:00:00", "zone": "Europe/Warsaw" }), '
  + "or 'unlimited'. A date with no time of day names no instant and is refused. Omit the field for the "
  + 'default, three months after the assignment (AZ-A10 clause 6)';

/** The deadline refusal classes, renamed for this field. */
const REFUSAL_CODES: Readonly<Record<string, string>> = {
  INVALID_DUE_AT: 'INVALID_ROLE_GRANT_EXPIRY',
  INVALID_DUE_AT_PRECISION: 'INVALID_ROLE_GRANT_EXPIRY_PRECISION',
  INVALID_DUE_AT_RANGE: 'INVALID_ROLE_GRANT_EXPIRY_RANGE',
  INVALID_DUE_AT_ZONE: 'INVALID_ROLE_GRANT_EXPIRY_ZONE',
  INVALID_DUE_AT_LOCAL_TIME: 'INVALID_ROLE_GRANT_EXPIRY_LOCAL_TIME',
};

function refuse(code: string, message: string): TaskFieldError {
  return new TaskFieldError(code, ROLE_GRANT_EXPIRY_FIELD, message);
}

/**
 * Normalize `roleGrantExpiresAt` for a write. `undefined` stays `undefined`
 * (the default); `'unlimited'` is the clause-6 literal; anything else must be
 * an instant the deadline normalizer can prove. `null` is refused rather than
 * read as either of the two other meanings it could have.
 */
export async function normalizeRoleGrantExpiresAtWrite(
  value: unknown,
  resolver: DueAtResolver,
): Promise<RoleGrantExpiryRequest | undefined> {
  if (value === undefined) return undefined;
  if (value === ROLE_GRANT_EXPIRY_UNLIMITED) return { kind: 'unlimited' };
  if (value === null || !(typeof value === 'string' || (typeof value === 'object' && !Array.isArray(value)))) {
    throw refuse('INVALID_ROLE_GRANT_EXPIRY', ROLE_GRANT_EXPIRY_REFUSAL);
  }
  let normalized;
  try {
    normalized = await normalizeTaskDueAtWrite(value, resolver);
  } catch (error) {
    if (!(error instanceof TaskFieldError)) throw error;
    const code = REFUSAL_CODES[error.code] ?? 'INVALID_ROLE_GRANT_EXPIRY';
    throw refuse(code, code === 'INVALID_ROLE_GRANT_EXPIRY'
      ? ROLE_GRANT_EXPIRY_REFUSAL
      : error.message.replace(/\bdueAt\b/g, ROLE_GRANT_EXPIRY_FIELD));
  }
  if (typeof normalized.value !== 'string') {
    // Unreachable: only `null` normalizes to a non-string, and it was refused
    // above. Kept so a future change to the deadline normalizer cannot turn
    // an instant into "no date" without a refusal.
    throw refuse('INVALID_ROLE_GRANT_EXPIRY', ROLE_GRANT_EXPIRY_REFUSAL);
  }
  return {
    kind: 'instant',
    instant: normalized.value,
    ...(normalized.resolution ? { resolution: normalized.resolution } : {}),
  };
}
