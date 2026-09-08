/**
 * TS-9 retention bounds for the telemetry plane.
 *
 * The ratification sitting `7e7eeca3` ruled: identity-bound Tier 0/1 metadata
 * is retained at EVENT GRAIN for a 90-day default; aggregates beyond that
 * carry no identity finer than org/key; and **both bounds are
 * deployment-configurable and documented**. Design §6.5.2 adds a second,
 * shorter bound of its own — quarantine retention is "mandatory short".
 *
 * WHY THIS MODULE THROWS AT IMPORT. A retention bound that silently falls back
 * to a default when its configuration is malformed is the worst kind of
 * governance control: the deployment believes it set 30 days, the plane keeps
 * 90, and nothing says so until an audit. Reading is therefore done once, at
 * module load, and a present-but-invalid value throws — so a misconfigured
 * deployment REFUSES TO BOOT rather than quietly retaining more than it was
 * told to. That is the AZ-S3 keyset canary discipline applied to a number.
 *
 * An ABSENT variable is not a misconfiguration: it selects the documented
 * default, which is the ratified one.
 */

const DAY_MS = 86_400_000;

/** TS-9: identity-bound Tier 0/1 metadata at event grain. */
export const TELEMETRY_EVENT_RETENTION_DAYS_DEFAULT = 90;
/** §6.5.2: "mandatory short retention" for quarantined payloads. */
export const TELEMETRY_QUARANTINE_RETENTION_DAYS_DEFAULT = 7;

export const TELEMETRY_EVENT_RETENTION_VARIABLE = 'RELAYHALL_TELEMETRY_RETENTION_DAYS';
export const TELEMETRY_QUARANTINE_RETENTION_VARIABLE = 'RELAYHALL_TELEMETRY_QUARANTINE_RETENTION_DAYS';

/** Ten years. A bound this side of "forever" is still a bound. */
const MAX_DAYS = 3650;

export function parseRetentionDays(variable: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  // Plain digits only. `Number('9e1')` is 90 and `Number('0x5A')` is 90 too,
  // and a retention bound is not the place to discover that a deployment's
  // config templating produced exponent notation: the value a human reads in
  // the environment must be the value the plane honours, character for
  // character.
  const trimmed = raw.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_DAYS) {
    throw new Error(
      `${variable} must be a whole number of days between 1 and ${MAX_DAYS}; received ${JSON.stringify(raw)}. `
      + 'Telemetry retention refuses to fall back to its default when it has been told something it cannot honour.',
    );
  }
  return parsed;
}

const eventRetentionDays = parseRetentionDays(
  TELEMETRY_EVENT_RETENTION_VARIABLE,
  process.env[TELEMETRY_EVENT_RETENTION_VARIABLE],
  TELEMETRY_EVENT_RETENTION_DAYS_DEFAULT,
);

const quarantineRetentionDays = parseRetentionDays(
  TELEMETRY_QUARANTINE_RETENTION_VARIABLE,
  process.env[TELEMETRY_QUARANTINE_RETENTION_VARIABLE],
  TELEMETRY_QUARANTINE_RETENTION_DAYS_DEFAULT,
);

if (quarantineRetentionDays > eventRetentionDays) {
  throw new Error(
    `${TELEMETRY_QUARANTINE_RETENTION_VARIABLE} (${quarantineRetentionDays}d) must not exceed `
    + `${TELEMETRY_EVENT_RETENTION_VARIABLE} (${eventRetentionDays}d): §6.5.2 calls quarantine retention SHORT, `
    + 'and a quarantine that outlives the accepted plane is a side channel around it.',
  );
}

/** TS-9 event-grain retention, in days. */
export function telemetryEventRetentionDays(): number {
  return eventRetentionDays;
}

/** §6.5.2 quarantine retention, in days. */
export function telemetryQuarantineRetentionDays(): number {
  return quarantineRetentionDays;
}

export function telemetryEventExpiry(now: Date): Date {
  return new Date(now.getTime() + eventRetentionDays * DAY_MS);
}

export function telemetryQuarantineExpiry(now: Date): Date {
  return new Date(now.getTime() + quarantineRetentionDays * DAY_MS);
}
