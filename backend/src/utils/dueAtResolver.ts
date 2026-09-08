import type { Pool } from 'pg';

/** PostgreSQL owns timezone resolution and microsecond formatting. The request
 * supplies a wall time and a bound zone/offset parameter; JavaScript never
 * constructs an instant from that wall time. */
const UTC_ISO_MASK = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const LOCAL_ISO_MASK = `'YYYY-MM-DD"T"HH24:MI:SS.US'`;
const IN_RANGE_SQL = (expr: string) => `(${expr} >= '0001-01-01 00:00:00+00'::timestamptz`
  + ` AND ${expr} < '10000-01-01 00:00:00+00'::timestamptz)`;

export interface DueAtCandidate {
  readonly instantIso: string;
  readonly backLocal: string;
  readonly offsetSeconds: number;
  readonly inRange: boolean;
}
export interface DueAtZonedLookup {
  readonly zoneKnown: boolean;
  readonly zoneName: string | null;
  readonly candidates: readonly DueAtCandidate[];
}
export interface DueAtResolver {
  zoned(local: string, zone: string): Promise<DueAtZonedLookup>;
  fixedOffset(local: string, offset: string): Promise<DueAtCandidate | null>;
}

/** Use PostgreSQL's native deterministic AT TIME ZONE policy. At a backward
 * transition PostgreSQL chooses the offset in force after the transition.
 * The API reports this policy and the actual offset on every zoned write.
 * A forward-gap normalization is refused by comparing back_local with the
 * submitted wall clock. No sampling algorithm claims to enumerate folds. */
export const DUE_AT_ZONED_SQL = `
WITH i AS (
  SELECT $1::timestamp AS wall,
         (SELECT n.name FROM pg_timezone_names n WHERE n.name = $2::text) AS zone
), c AS (SELECT wall, zone, wall AT TIME ZONE zone AS t FROM i)
SELECT zone IS NOT NULL AS zone_known, zone AS zone_name,
  to_char(t AT TIME ZONE 'UTC', ${UTC_ISO_MASK}) AS instant_iso,
  to_char(t AT TIME ZONE zone, ${LOCAL_ISO_MASK}) AS back_local,
  EXTRACT(EPOCH FROM ((t AT TIME ZONE zone) - (t AT TIME ZONE 'UTC')))::bigint AS offset_seconds,
  ${IN_RANGE_SQL('t')} AS in_range
FROM c
`;

/** An interval accepts the validator's full offset domain, including 23:59;
 * PostgreSQL's timestamptz text parser has a narrower offset limit. */
export const DUE_AT_FIXED_OFFSET_SQL = `
WITH c AS (SELECT $1::timestamp AT TIME ZONE $2::interval AS t)
SELECT
  to_char(t AT TIME ZONE 'UTC', ${UTC_ISO_MASK}) AS instant_iso,
  to_char(t AT TIME ZONE $2::interval, ${LOCAL_ISO_MASK}) AS back_local,
  EXTRACT(EPOCH FROM $2::interval)::bigint AS offset_seconds,
  ${IN_RANGE_SQL('t')} AS in_range
FROM c
`;

function readCandidate(row: Record<string, unknown>): DueAtCandidate | null {
  if (typeof row.instant_iso !== 'string' || typeof row.back_local !== 'string') return null;
  const offsetSeconds = Number(row.offset_seconds);
  if (!Number.isSafeInteger(offsetSeconds)) throw new Error('dueAtResolver returned a non-integral offset');
  return { instantIso: row.instant_iso, backLocal: row.back_local,
    offsetSeconds, inRange: row.in_range === true };
}

export function createPgDueAtResolver(pool: Pool): DueAtResolver {
  return {
    async zoned(local, zone) {
      const { rows } = await pool.query(DUE_AT_ZONED_SQL, [local, zone]);
      if (rows.length !== 1) throw new Error('dueAtResolver returned no unique zoned result');
      const candidate = readCandidate(rows[0]);
      return { zoneKnown: rows[0].zone_known === true,
        zoneName: typeof rows[0].zone_name === 'string' ? rows[0].zone_name : null,
        candidates: candidate ? [candidate] : [] };
    },
    async fixedOffset(local, offset) {
      const { rows } = await pool.query(DUE_AT_FIXED_OFFSET_SQL, [local, offset]);
      if (rows.length !== 1) throw new Error('dueAtResolver returned no unique fixed-offset result');
      return readCandidate(rows[0]);
    },
  };
}
