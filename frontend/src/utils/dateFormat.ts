/**
 * The one place a date becomes text.
 *
 * Card 96984e2c: three renderings of the same instant shipped in one
 * deployment, and one of them was ambiguous -- `9/5/2026, 2:40:36 AM` reads as
 * 9 May to a European operator and means 5 September. The cause was not a bug
 * in any of them; it was that each surface formatted its own way, and a bare
 * `toLocaleString()` follows whatever locale the VIEWER's browser reports, so
 * one build renders differently for different readers.
 *
 * So: every date the product shows comes from a function here, and
 * src/dateFormatSurface.test.ts holds that as a property rather than a habit.
 */
export const EUROPEAN_DATE_LOCALE = 'en-GB';

type DateInput = string | number | Date;

function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `05/09/2026, 14:33` — when a reader needs the instant. */
export function formatDateTime(value: DateInput, fallback = ''): string {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleString(EUROPEAN_DATE_LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * `07/09/2026, 15:00 UTC` — the same moment, said the same way to everyone.
 *
 * Card 7d38a6e0, round-2 review. Every other formatter here renders in the
 * READER's zone, which is right for reading and useless for disambiguating:
 * on the hour a zone repeats, two different instants render identically, and
 * a person editing a deadline across that hour has no way to see which one
 * they are looking at. This says the instant itself. It is the description
 * beside the deadline control, not a replacement for the local rendering
 * beside it — a reader still wants their own clock; they just also need to be
 * able to tell two moments apart when their own clock cannot.
 */
export function formatInstantUtc(value: DateInput, fallback = ''): string {
  const date = toDate(value);
  if (!date) return fallback;
  const text = date.toLocaleString(EUROPEAN_DATE_LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `${text} UTC`;
}

/**
 * `2026-09-07T19:00:00` — an instant rendered into the MACHINE format an
 * `<input type="datetime-local">` reads, in the reader's own zone.
 *
 * Card 7d38a6e0. This is a RENDERING and runs in the same direction as every
 * other function here: an instant goes in, characters a reader (or, in this
 * one case, a native form control) can look at come out. It asks `Date` for
 * the local components of a moment, exactly as `formatDateTime` above asks
 * `toLocaleString` for them, and it computes nothing — no offset, no epoch
 * arithmetic, no timezone decision.
 *
 * What it deliberately does NOT do is the other direction. Turning a wall
 * clock back into an instant is the conversion that got this card rejected
 * three times, and it no longer happens in the browser at all: the form sends
 * the wall clock and the zone NAME, and the server resolves them against a
 * real timezone database. See `components/tasks/taskFieldEditors`.
 *
 * It is hand-built rather than routed through `toLocaleString` because this is
 * the element's own machine format — `YYYY-MM-DDTHH:mm:ss`, always, in every
 * locale — and not a rendering for a reader. A locale-aware formatter here
 * would break the control outright. The year is padded to four digits so a
 * deadline in year 1 renders as `0001-…` rather than as `1-…`, which the
 * element would not read back.
 */
export function formatInstantForDateTimeLocal(value: DateInput, fallback = ''): string {
  const date = toDate(value);
  if (!date) return fallback;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `5 Sept 2026` — when the time of day carries no meaning. */
export function formatDate(value: DateInput, fallback = ''): string {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleDateString(EUROPEAN_DATE_LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** `5 September 2026, 14:33` — a heading that names one moment in full. */
export function formatDateTimeLong(value: DateInput, fallback = ''): string {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleString(EUROPEAN_DATE_LOCALE, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** `Friday 5 September 2026, 14:33` — the same, where the weekday helps. */
export function formatDateTimeFull(value: DateInput, fallback = ''): string {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleString(EUROPEAN_DATE_LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** `14:33` — a time already inside a dated context. */
export function formatTime(value: DateInput, fallback = ''): string {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleTimeString(EUROPEAN_DATE_LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** `Fri 5 Sept 2026` — a day separator in a list of events. */
export function formatDayLabel(value: DateInput, fallback = ''): string {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleDateString(EUROPEAN_DATE_LOCALE, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * `Due in 2 d` / `Overdue by 3 h` — a deadline said relative to now.
 *
 * Card 7d38a6e0. A deadline is read as a DISTANCE ("is this urgent?") far more
 * often than as an instant, and a board card has room for the distance only.
 * The absolute instant is never lost: every surface that renders this also
 * carries the exact date, through `formatDateTime` above.
 *
 * It lives here, beside the absolute formatters, because this file's whole
 * point is that there is one place a date becomes text. It builds its words
 * from plain arithmetic rather than `Intl.RelativeTimeFormat` for the same
 * reason the formatters above pin `en-GB`: a viewer's browser locale must not
 * decide what one deployment says.
 *
 * Units step at the boundary a reader would step at — minutes below an hour,
 * hours below a day, days above it — and always truncate, so "in 1 d" is
 * never shown for something 47 hours away.
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatRelativeDue(value: DateInput, now: DateInput = Date.now(), fallback = ''): string {
  const date = toDate(value);
  const from = toDate(now);
  if (!date || !from) return fallback;
  const delta = date.getTime() - from.getTime();
  const magnitude = Math.abs(delta);
  // Round-1 review F5: inside a minute either way there is no distance left to
  // report, and "Due in under a minute" for a deadline that has just passed
  // said the wrong thing about which side of it the reader is on.
  if (magnitude < MINUTE_MS) return 'Due now';
  let amount: string;
  if (magnitude < HOUR_MS) amount = `${Math.floor(magnitude / MINUTE_MS)} min`;
  else if (magnitude < DAY_MS) amount = `${Math.floor(magnitude / HOUR_MS)} h`;
  else amount = `${Math.floor(magnitude / DAY_MS)} d`;
  return delta < 0 ? `Overdue by ${amount}` : `Due in ${amount}`;
}

/**
 * The same instant, as a STATE rather than as text.
 *
 * Not a formatter — it renders nothing. It is here so that the chip on a board
 * card and the field on a Task's page cannot disagree about when a deadline
 * becomes urgent, which is exactly the kind of drift this file exists to stop.
 *
 * `soon` is inside two days: long enough that a person still has a working day
 * to act, short enough that it is not permanently lit on every dated Task.
 */
export type DueTone = 'none' | 'later' | 'soon' | 'overdue';

export const DUE_SOON_MS = 2 * DAY_MS;

export function dueTone(value: DateInput | null | undefined, now: DateInput = Date.now()): DueTone {
  if (value === null || value === undefined || value === '') return 'none';
  const date = toDate(value);
  const from = toDate(now);
  if (!date || !from) return 'none';
  const delta = date.getTime() - from.getTime();
  if (delta < 0) return 'overdue';
  return delta <= DUE_SOON_MS ? 'soon' : 'later';
}
