/** Shared notes validation and server-resolved due dates (cards 9c3a1aa4,
 * 7d38a6e0). Calendar fields are validated before PostgreSQL conversion. Each
 * result must reproduce the submitted wall clock at microsecond precision.
 * Zoned writes echo PostgreSQL’s deterministic policy and actual offset. */
import { Response } from 'express';
import { sendApiError } from './apiErrors';
import type { DueAtCandidate, DueAtResolver } from './dueAtResolver';

export class TaskFieldError extends Error {
  constructor(
    public readonly code: string,
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaskFieldError';
  }
}

export function normalizeTaskNotesWrite(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new TaskFieldError(
      'INVALID_TASK_NOTES',
      'notes',
      'notes must be a string, or null to clear it',
    );
  }
  return value;
}

/* ────────────────────────────── dueAt ────────────────────────────── */

const ISO_8601_INSTANT = new RegExp(
  '^(\\d{4})-(\\d{2})-(\\d{2})[Tt](\\d{2}):(\\d{2})'
  + '(?::(\\d{2})(?:\\.(\\d+))?)?'
  + '(?:[Zz]|([+-])(\\d{2}):(\\d{2}))$',
);

const LOCAL_WALL_CLOCK = new RegExp(
  '^(\\d{4})-(\\d{2})-(\\d{2})[Tt](\\d{2}):(\\d{2})'
  + '(?::(\\d{2})(?:\\.(\\d+))?)?$',
);

const IANA_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+.-]+){0,2}$/;
const IANA_ZONE_MAX_LENGTH = 64;

const DUE_AT_REFUSAL = 'dueAt must be an ISO-8601 date-time naming an instant '
  + '(for example 2026-09-07T17:00:00Z), or { local, zone } naming a local wall '
  + 'clock and the IANA timezone to read it in (for example '
  + '{ "local": "2026-09-07T19:00:00", "zone": "Europe/Warsaw" }), or null to clear it';

export const DUE_AT_FRACTIONAL_DIGITS = 6;

export const DUE_AT_MIN_INSTANT = '0001-01-01T00:00:00.000000Z';
export const DUE_AT_MAX_INSTANT = '9999-12-31T23:59:59.999999Z';

const DUE_AT_PRECISION_REFUSAL = 'dueAt is stored to microsecond precision, so at '
  + `most ${DUE_AT_FRACTIONAL_DIGITS} fractional-second digits are accepted; a finer value names `
  + 'an instant the column cannot hold and is refused rather than rounded';

const DUE_AT_RANGE_REFUSAL = 'dueAt names an instant outside the range this API stores, '
  + `${DUE_AT_MIN_INSTANT} to ${DUE_AT_MAX_INSTANT}. A value whose timezone offset carries it `
  + 'past either end is refused rather than stored as a year the column cannot spell';

const DUE_AT_ZONE_REFUSAL = 'dueAt.zone must be an IANA timezone name this server knows '
  + '(for example Europe/Warsaw). It is the name a browser reports as '
  + 'Intl.DateTimeFormat().resolvedOptions().timeZone';

const DUE_AT_UNPROVED_REFUSAL = 'dueAt could not be converted to an instant that reads back as '
  + 'the value sent. Nothing was stored: this API refuses a conversion it cannot prove rather '
  + 'than storing an instant that was not named';

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

interface WallClockParts {
  readonly canonicalLocal: string;
  readonly sqlLocal: string;
  readonly offsetInterval: string | null;
}

const pad2 = (value: string | number): string => String(value).padStart(2, '0');

function readWallClock(match: RegExpExecArray, hasOffset: boolean): WallClockParts {
  const fraction = match[7];
  if (fraction !== undefined && fraction.length > DUE_AT_FRACTIONAL_DIGITS) {
    // Measured BEFORE anything else is decided, and answered with its own
    // code, because "this is not an instant" and "this is an instant finer
    // than the column keeps" are different things to tell a caller — and the
    // second must never be answered by quietly storing a third instant.
    throw new TaskFieldError('INVALID_DUE_AT_PRECISION', 'dueAt', DUE_AT_PRECISION_REFUSAL);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const calendarIsReal = month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth(year, month)
    // Hour 24 is a legal ISO-8601 spelling of midnight ending the day, and
    // most parsers read it as the NEXT day. Rather than pick which of the two
    // the caller meant, refuse it and let them write the day they mean.
    && hour <= 23 && minute <= 59
    // Leap seconds are refused for the same reason: :60 becomes the next
    // minute, so accepting it would store an instant nobody named.
    && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59;
  if (!calendarIsReal) {
    throw new TaskFieldError('INVALID_DUE_AT', 'dueAt', DUE_AT_REFUSAL);
  }
  // Year 0000 is a legal four-digit spelling and not a year this API stores;
  // PostgreSQL has no year zero at all. Refused with the range code so a
  // caller is told which of the two things is wrong.
  if (year < 1) {
    throw new TaskFieldError('INVALID_DUE_AT_RANGE', 'dueAt', DUE_AT_RANGE_REFUSAL);
  }
  const micros = (fraction ?? '').padEnd(DUE_AT_FRACTIONAL_DIGITS, '0');
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const time = `${match[4]}:${match[5]}:${match[6] === undefined ? '00' : match[6]}.${micros}`;
  return {
    canonicalLocal: `${date}T${time}`,
    sqlLocal: `${date} ${time}`,
    offsetInterval: hasOffset
      ? `${match[8] ?? '+'}${pad2(match[9] ?? '00')}:${pad2(match[10] ?? '00')}:00`
      : null,
  };
}

const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function formatOffsetLabel(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const magnitude = Math.abs(seconds);
  const hours = Math.floor(magnitude / 3600);
  const minutes = Math.floor((magnitude % 3600) / 60);
  const rest = magnitude % 60;
  const base = `${sign}${pad2(hours)}:${pad2(minutes)}`;
  return rest === 0 ? base : `${base}:${pad2(rest)}`;
}

export interface DueAtResolution {
  readonly zone: string;
  readonly local: string;
  readonly instant: string;
  readonly offset: string;
  readonly offsetSeconds: number;

  readonly chosen: 'postgresql';
}

export interface NormalizedDueAt {
  readonly value: string | null | undefined;
  readonly resolution?: DueAtResolution;
}

function isProved(candidate: DueAtCandidate, parts: WallClockParts): boolean {
  return candidate.backLocal === parts.canonicalLocal;
}

function assertCanonical(instant: string): string {
  if (!CANONICAL_INSTANT.test(instant)) {
    // Not reachable from any caller input: the range check has already run and
    // the mask is fixed. It is here because the alternative to noticing is
    // storing a string the read path cannot round-trip.
    throw new TaskFieldError('INVALID_DUE_AT', 'dueAt', DUE_AT_UNPROVED_REFUSAL);
  }
  return instant;
}

async function normalizeDueAtInstantString(
  value: string,
  resolver: DueAtResolver,
): Promise<NormalizedDueAt> {
  const match = ISO_8601_INSTANT.exec(value);
  if (!match) {
    throw new TaskFieldError('INVALID_DUE_AT', 'dueAt', DUE_AT_REFUSAL);
  }
  const parts = readWallClock(match, true);
  const offsetInterval = parts.offsetInterval as string;
  const candidate = await resolver.fixedOffset(
    parts.sqlLocal,
    offsetInterval,
  );
  if (!candidate) {
    throw new TaskFieldError('INVALID_DUE_AT', 'dueAt', DUE_AT_UNPROVED_REFUSAL);
  }
  // Range BEFORE the round trip: a value carried past year 9999 by its own
  // offset still renders back as the clock it came from, so the round trip
  // cannot notice it. Round 3's `9999-12-31T23:59:59-00:01` lands here.
  if (!candidate.inRange) {
    throw new TaskFieldError('INVALID_DUE_AT_RANGE', 'dueAt', DUE_AT_RANGE_REFUSAL);
  }
  if (!isProved(candidate, parts)) {
    throw new TaskFieldError('INVALID_DUE_AT', 'dueAt', DUE_AT_UNPROVED_REFUSAL);
  }
  return { value: assertCanonical(candidate.instantIso) };
}

async function normalizeDueAtZonedObject(
  value: Record<string, unknown>,
  resolver: DueAtResolver,
): Promise<NormalizedDueAt> {
  const keys = Object.keys(value);
  const known = keys.every((key) => key === 'local' || key === 'zone');
  if (!known || typeof value.local !== 'string' || typeof value.zone !== 'string') {
    throw new TaskFieldError('INVALID_DUE_AT', 'dueAt', DUE_AT_REFUSAL);
  }
  const zone = value.zone;
  if (zone.length > IANA_ZONE_MAX_LENGTH || !IANA_ZONE_SHAPE.test(zone)) {
    throw new TaskFieldError('INVALID_DUE_AT_ZONE', 'dueAt', DUE_AT_ZONE_REFUSAL);
  }
  const match = LOCAL_WALL_CLOCK.exec(value.local);
  if (!match) {
    throw new TaskFieldError('INVALID_DUE_AT', 'dueAt', DUE_AT_REFUSAL);
  }
  const parts = readWallClock(match, false);
  const lookup = await resolver.zoned(parts.sqlLocal, zone);
  if (!lookup.zoneKnown || !lookup.zoneName) {
    throw new TaskFieldError('INVALID_DUE_AT_ZONE', 'dueAt', DUE_AT_ZONE_REFUSAL);
  }
  const proved = lookup.candidates.filter((candidate) => isProved(candidate, parts));
  if (proved.length === 0) {
    // The wall clock names no instant in that zone. It is the person's own
    // clock reading, so the refusal says which zone made it impossible rather
    // than leaving them to guess — the zone name comes from the database's
    // closed set, not from the body.
    throw new TaskFieldError(
      'INVALID_DUE_AT_LOCAL_TIME',
      'dueAt',
      `dueAt names a local time that does not exist in ${lookup.zoneName}: the clocks move `
      + 'across it, so no instant reads back as that clock. Pick a time before or after the change',
    );
  }
  const chosen = proved[0];
  if (!chosen.inRange) {
    throw new TaskFieldError('INVALID_DUE_AT_RANGE', 'dueAt', DUE_AT_RANGE_REFUSAL);
  }
  return {
    value: assertCanonical(chosen.instantIso),
    resolution: {
      zone: lookup.zoneName,
      local: parts.canonicalLocal,
      instant: chosen.instantIso,
      offset: formatOffsetLabel(chosen.offsetSeconds),
      offsetSeconds: chosen.offsetSeconds,
      chosen: 'postgresql',
    },
  };
}

export async function normalizeTaskDueAtWrite(
  value: unknown,
  resolver: DueAtResolver,
): Promise<NormalizedDueAt> {
  if (value === undefined) return { value: undefined };
  if (value === null) return { value: null };
  if (typeof value === 'string') return normalizeDueAtInstantString(value, resolver);
  if (typeof value === 'object' && !Array.isArray(value)) {
    return normalizeDueAtZonedObject(value as Record<string, unknown>, resolver);
  }
  throw new TaskFieldError('INVALID_DUE_AT', 'dueAt', DUE_AT_REFUSAL);
}

export function sendTaskFieldRefusal(res: Response, err: unknown): boolean {
  if (!(err instanceof TaskFieldError)) return false;
  sendApiError(res, 400, err.code, err.message, undefined, { field: err.field });
  return true;
}
