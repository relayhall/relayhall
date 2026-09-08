/**
 * One deployment, one date format.
 *
 * Card 96984e2c found three renderings of the same instant in one build, one of
 * them ambiguous: `9/5/2026, 2:40:36 AM` reads as 9 May to a European operator
 * and means 5 September. The cause was not a bug in any single call. It was
 * that `toLocaleString()` with no locale follows the VIEWER's browser, so the
 * same build renders differently for different readers, and nothing anywhere
 * said the product has a house format.
 *
 * A list of the sites that were wrong cannot hold that, because the next one
 * is always outside the list. This file states the property instead:
 *
 *   every date the product renders comes from utils/dateFormat.ts
 *
 * and names the only exceptions, each with the lane that owns the file.
 *
 * To repair a failure, do not add an entry: route the call through a formatter.
 * Add an entry only when another lane owns the file, and name that lane.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'vitest';

import {
  formatDate,
  formatDateTime,
  formatDateTimeFull,
  formatDateTimeLong,
  formatDayLabel,
  formatTime,
} from './utils/dateFormat';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const UTIL = path.join('utils', 'dateFormat.ts');

/**
 * file -> why it is not routed yet. Concurrent-lane files only.
 *
 * These are NOT permanently exempt. Each is a file another lane is writing in
 * during the beta freeze window, where an edit from here would be refused at
 * integration. Every one is recorded in the candidate's READY report so the
 * remainder is visible rather than forgotten.
 */
const CONCURRENT_LANE_FILES: Record<string, string> = {
  'pages/AccessManagerPage.tsx':
    'FIX-B owns the Access manager password control; 4 sites, all bare toLocaleString()',
  'pages/MyConnectionsPage.tsx':
    'FIX-B owns the connection surfaces; 1 site, bare toLocaleString()',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `toLocaleString`, `toLocaleDateString` and `toLocaleTimeString`. Anchored on
 * a preceding `.` so an unrelated identifier that merely ends in those letters
 * is not a match, and deliberately NOT anchored on the argument list: a
 * hardcoded `'en-GB'` is the same defect as no locale at all, because it is a
 * second implementation of the house format that can drift from the first.
 * That is exactly what ProjectDetailModal shipped -- 'en-US' on one line and
 * 'en-GB' a few hundred lines below, in the same component.
 */
const LOCALE_CALL = /\.toLocale(String|DateString|TimeString)\s*\(/;

const sources = walk(SRC);
const offenders: { where: string; line: string }[] = [];
for (const file of sources) {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  if (rel === UTIL.split(path.sep).join('/')) continue;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (LOCALE_CALL.test(line)) offenders.push({ where: `${rel}:${i + 1}`, line: line.trim() });
  });
}

describe('every date the product renders comes from utils/dateFormat.ts', () => {
  test('the scan is not vacuous', () => {
    expect(sources.length).toBeGreaterThan(100);
    // The util itself must contain the calls, or the detector is looking at
    // the wrong thing entirely.
    const util = fs.readFileSync(path.join(SRC, UTIL), 'utf8');
    expect(util.split('\n').filter((l) => LOCALE_CALL.test(l)).length).toBeGreaterThanOrEqual(4);
  });

  test('the detector fires on the shapes it exists for', () => {
    expect(LOCALE_CALL.test('  return date.toLocaleString();')).toBe(true);
    expect(LOCALE_CALL.test("  return d.toLocaleDateString('en-GB', { day: 'numeric' });")).toBe(true);
    expect(LOCALE_CALL.test('  return d.toLocaleTimeString();')).toBe(true);
    expect(LOCALE_CALL.test('  const toLocaleStringish = 1;')).toBe(false);
    expect(LOCALE_CALL.test('  return formatDateTime(value);')).toBe(false);
  });

  test('no surface formats its own dates', () => {
    const unexpected = offenders
      .filter((o) => !(o.where.split(':')[0] in CONCURRENT_LANE_FILES))
      .map((o) => `${o.where}  ${o.line}`);
    expect(unexpected).toEqual([]);
  });

  test('no concurrent-lane exemption is stale', () => {
    const live = new Set(offenders.map((o) => o.where.split(':')[0]));
    const stale = Object.keys(CONCURRENT_LANE_FILES).filter((f) => !live.has(f));
    expect(stale).toEqual([]);
  });

  test('every exported formatter has a consumer', () => {
    // utils/dateFormat.ts shipped a `formatDateTimeLong` that nothing imported
    // and that rendered identically to `formatDateTime` -- a dead export is
    // how a second house format gets born.
    const util = fs.readFileSync(path.join(SRC, UTIL), 'utf8');
    const exported = [...util.matchAll(/export function (\w+)/g)].map((m) => m[1]);
    expect(exported.length).toBeGreaterThanOrEqual(6);
    const consumers = sources
      .filter((f) => path.relative(SRC, f).split(path.sep).join('/') !== UTIL.split(path.sep).join('/'))
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    const unused = exported.filter((name) => !new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(consumers));
    expect(unused).toEqual([]);
  });
});

describe('the house format is European and unambiguous', () => {
  // Midday UTC, so no timezone this test can plausibly run in moves the day.
  // 5 September: the day and the month differ, which is the whole point --
  // `05/09` and `09/05` are different strings only when D !== M.
  const instant = '2026-09-05T12:00:00.000Z';

  test('formatDateTime is day-first, 24-hour', () => {
    expect(formatDateTime(instant)).toMatch(/^05\/09\/2026, \d{2}:\d{2}$/);
  });

  test('formatDate names the month, so it cannot be misread', () => {
    expect(formatDate(instant)).toMatch(/^5 Sept? 2026$/);
  });

  test('formatTime is 24-hour and carries no AM/PM', () => {
    expect(formatTime(instant)).toMatch(/^\d{2}:\d{2}$/);
    expect(formatTime(instant)).not.toMatch(/[ap]m/i);
  });

  test('the long shapes spell the month and keep the 24-hour clock', () => {
    // en-GB joins a long date to a time with " at ", so the separator is
    // asserted as a property rather than as a literal string: what matters is
    // that the month is spelled, the day leads, and the clock is 24-hour.
    for (const rendered of [formatDateTimeLong(instant), formatDateTimeFull(instant)]) {
      expect(rendered).toContain('5 September 2026');
      expect(rendered).toMatch(/\b\d{2}:\d{2}\b/);
      expect(rendered).not.toMatch(/[ap]m/i);
    }
    expect(formatDateTimeFull(instant)).toContain('Saturday');
    expect(formatDayLabel(instant)).toMatch(/^Sat, 5 Sept? 2026$/);
  });

  test('an unparsable value returns the fallback, never "Invalid Date"', () => {
    for (const fn of [formatDateTime, formatDate, formatTime, formatDateTimeLong,
      formatDateTimeFull, formatDayLabel]) {
      expect(fn('not a date', 'unknown')).toBe('unknown');
      expect(fn('')).toBe('');
    }
  });

  test('a Date, a string and a number of the same instant agree', () => {
    const d = new Date(instant);
    expect(formatDateTime(d)).toBe(formatDateTime(instant));
    expect(formatDateTime(d.getTime())).toBe(formatDateTime(instant));
  });
});
