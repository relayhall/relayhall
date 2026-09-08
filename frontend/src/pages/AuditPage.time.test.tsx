// @vitest-environment jsdom
/**
 * WHAT THE TIME FILTER ASKS FOR — round-1 review, PRODUCTION P1.
 *
 * This file PINS A TIMEZONE, which is why it is a file of its own rather than
 * three cases in `AuditPage.test.tsx`: a suite that silently changes the
 * process clock for every other test in it is a trap for the next reader, and
 * vitest's `pool: 'forks'` gives each file its own process, so the pin stops
 * at this file's edge.
 *
 * Europe/Warsaw, because it has both transitions inside 2026:
 *   29 March    02:00 -> 03:00   the hour 02:00-02:59 DOES NOT EXIST
 *   25 October  03:00 -> 02:00   the hour 02:00-02:59 HAPPENS TWICE
 *
 * `<input type="datetime-local">` accepts a value in both — it knows nothing
 * about any clock — so both reach the page and both need an answer. The
 * defect was that `new Date(local)` gave one silently: `2026-03-29T02:30`
 * came back as 03:30 and the ledger was filtered for an hour the reader had
 * not asked about.
 */
process.env.TZ = 'Europe/Warsaw';

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  AuditPage, readInstant, WALL_CLOCK_MIN, WALL_CLOCK_MAX,
} from './AuditPage';

/**
 * The instant grammar this page must stay INSIDE, written out here rather than
 * imported from `backend/src/routes/audit.ts`: an oracle that imports the
 * thing it measures agrees with it by construction, and this one has to be an
 * outside anchor.
 *
 * IT IS A SUBSET OF THE ROUTE'S, NOT A COPY (round-3 review OBSERVATION
 * O3-R3). `audit.ts:31` admits an absent fraction or one to three digits; this
 * requires exactly three, because `toISOString()` — the only producer on this
 * path — always emits three. A subset is the correct anchor for what this page
 * EMITS, but the comment here used to claim fidelity it did not have, and a
 * comment that overclaims is a claim that overclaims.
 */
const ROUTE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The instant a readable value converts to. `readInstant` returns an outcome
 * rather than throwing (round-3 review PRODUCTION P1-R3), so a test that wants
 * the instant has to say what it expects to have happened; this fails loudly
 * and names the outcome instead of quietly reading `undefined`.
 */
const instantOf = (local: string): string | null => {
  const outcome = readInstant(local);
  if (outcome.kind !== 'ok') {
    throw new Error(`readInstant(${local}) answered ${outcome.kind}, not ok`);
  }
  return outcome.instant;
};

const authenticatedFetch = vi.fn();
vi.mock('../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const EVENT = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  occurredAt: '2026-09-04T09:15:00.000Z',
  action: 'credential.mint', outcome: 'success',
  actorPrincipalId: null, actorHandle: 'owner', authMethod: 'session',
  credentialId: null, resourceType: 'principal', resourceId: null, metadata: {},
};

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
  authenticatedFetch.mockImplementation((raw: string) => {
    calls.push(raw);
    const url = new URL(raw, 'http://board.test');
    const reply = (body: unknown) => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(body),
    });
    if (url.pathname.endsWith('/principals/me')) return reply({ success: true, principal: null, scopes: ['root'] });
    if (url.pathname.endsWith('/principals')) return reply({ success: true, principals: [] });
    return reply({ success: true, events: [EVENT], nextCursor: null, retention: 'indefinite', purgeAvailable: false });
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** The audit request the page most recently made. */
const lastAudit = () => new URL(
  calls.filter((c) => c.includes('/audit')).slice(-1)[0], 'http://board.test');
const auditCount = () => calls.filter((c) => c.includes('/audit')).length;

async function ready() {
  render(<AuditPage />);
  await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
}

async function apply(field: 'From' | 'To', value: string) {
  const input = field === 'From' ? screen.getByLabelText('From') : screen.getByLabelText(/^To/);
  fireEvent.change(input, { target: { value } });
  await userEvent.setup().click(screen.getByRole('button', { name: /Apply/ }));
}

describe('the wall clock the reader is on', () => {
  test('the pin took: this process is on a clock with both transitions', () => {
    // If this fails, every assertion below is measuring a different timezone
    // and the file proves nothing. Check it out loud rather than assuming it.
    expect(new Date(2026, 2, 29, 2, 30).getHours(), 'the March gap is not present').toBe(3);
    expect(new Date(2026, 9, 25, 2, 30).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  test('an hour the clock SKIPS is refused in words, and spends no request', async () => {
    await ready();
    const before = auditCount();
    await apply('From', '2026-03-29T02:30');
    await waitFor(() => expect(screen.getByRole('alert'))
      .toHaveTextContent(/does not exist in Europe\/Warsaw/));
    // The defect was not an error message. It was a SILENT answer to a
    // different question: the value used to leave as 01:30Z, whose local
    // reading is 03:30, an hour the reader never typed.
    expect(auditCount(), 'a time that does not exist still reached the ledger').toBe(before);
  });

  test('the DST gap is stated as a fact and NOT explained as daylight saving', () => {
    // Round-3 review PRODUCTION P1-R3. This one really IS a daylight-saving
    // transition — Warsaw, 29 March 2026, 02:00 -> 03:00 — and the page still
    // does not say so, because the measurement cannot tell this apart from
    // Samoa's 2011 dateline move (`AuditPage.zone.test.tsx`, the same
    // assertions on the same outcome). Saying only what was measured is the
    // whole repair: the moment the sentence names a cause, some value gets
    // the wrong one.
    const outcome = readInstant('2026-03-29T02:30');
    expect(outcome).toEqual({
      kind: 'nonexistent-local-time',
      local: '2026-03-29T02:30',
      zone: 'Europe/Warsaw',
    });
    // AN OUTSIDE ANCHOR ON THE WIDTH. This gap is one hour: the readings on
    // either side of it convert normally. The Apia gap in the sibling file is
    // twenty-four hours wide, which no daylight-saving transition has ever
    // been — so a page that gave these two the same sentence would have been
    // wrong about one of them if it named a cause.
    expect(readInstant('2026-03-29T01:30').kind).toBe('ok');
    expect(readInstant('2026-03-29T03:30').kind).toBe('ok');
  });

  test('the refusal the reader SEES names the zone and no mechanism', async () => {
    await ready();
    await apply('From', '2026-03-29T02:30');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Europe/Warsaw');
    expect(alert.textContent ?? '',
      'the page named a cause it did not measure').not.toMatch(/daylight|saving|DST/i);
  });

  test('an hour the clock repeats is accepted, as its FIRST occurrence', async () => {
    // Both readings round-trip, so there is nothing to refuse; what matters is
    // that the page says which one it takes and takes that one. 00:30Z is the
    // +02:00 reading — before the clocks go back.
    await ready();
    await apply('From', '2026-10-25T02:30');
    await waitFor(() => expect(lastAudit().searchParams.get('since')).toBe('2026-10-25T00:30:00.000Z'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('an ordinary time is unchanged by any of this', async () => {
    await ready();
    await apply('From', '2026-09-01T12:00');
    // Warsaw is +02:00 in September.
    await waitFor(() => expect(lastAudit().searchParams.get('since')).toBe('2026-09-01T10:00:00.000Z'));
  });

  test('the conversion REFUSES what it cannot read, rather than throwing', () => {
    // The second half of P1: year 10000 was accepted by the control and then
    // raised a RangeError out of `toISOString()`. It is asserted on the
    // function rather than through the page, because the shipped control now
    // forbids the value (min/max, asserted below) and driving it through a
    // jsdom input would measure jsdom's datetime-local behaviour instead.
    expect(readInstant('10000-01-01T00:00'))
      .toEqual({ kind: 'out-of-grammar', where: 'wall-clock-text' });
    expect(readInstant('2026-13-01T00:00').kind).not.toBe('ok');
    expect(readInstant('not a time'))
      .toEqual({ kind: 'out-of-grammar', where: 'wall-clock-text' });
    // And it still answers the ordinary cases.
    expect(readInstant('')).toEqual({ kind: 'ok', instant: null });
    expect(instantOf('2026-09-01T12:00')).toBe('2026-09-01T10:00:00.000Z');
    expect(instantOf('2026-09-01T12:00:30')).toBe('2026-09-01T10:00:30.000Z');
  });

  test('every bound the two controls declare is one the conversion accepts', async () => {
    // Round-2 review CONTROL C4-R2: this test used to read the two attributes
    // and stop, so it stayed green while the conversion refused the very
    // minimum the attribute advertised (PRODUCTION P1-R2). The declared bounds
    // are now taken OFF THE RENDERED CONTROLS and pushed through the
    // conversion, so the sentence in this test's name is measured rather than
    // asserted.
    //
    // THE NAME USED TO SAY "the same range", AND THAT WAS FALSE (round-3
    // review CONTROL C4-R3): the conversion accepts values the controls put
    // out of range — `0001-01-01T12:00` in Pacific/Kiritimati converts while
    // the control reports underflow — because the controls step a day in from
    // the edge and the conversion does not. Only the direction that protects
    // the reader is claimed here: everything the FORM offers, the conversion
    // takes. The other direction is unreachable through the form and is not
    // asserted, because it is not true.
    await ready();
    const bounds = new Set<string>();
    for (const field of ['From', /^To/] as const) {
      const input = screen.getByLabelText(field);
      const min = input.getAttribute('min');
      const max = input.getAttribute('max');
      expect(min, 'a control with no declared minimum').toBeTruthy();
      expect(max, 'a control with no declared maximum').toBeTruthy();
      bounds.add(min as string);
      bounds.add(max as string);
    }
    // Both controls declare the same two values, and those are the exported
    // ones — so a control can neither drift from the other nor from the
    // constant the conversion's own comment claims it honours.
    expect([...bounds].sort()).toEqual([WALL_CLOCK_MIN, WALL_CLOCK_MAX].sort());

    for (const declared of bounds) {
      const instant = instantOf(declared);
      expect(instant, `the conversion refused the advertised bound ${declared}`).toBeTruthy();
      // Not merely "it did not throw": the instant has to be one the ROUTE
      // can read. `9999-12-31T23:59` in a zone west of UTC converts to year
      // 10000, which `toISOString` spells `+010000-...` and the route rejects.
      expect(instant as string,
        `the advertised bound ${declared} converts outside the route's grammar`)
        .toMatch(ROUTE_INSTANT);
    }
  });

  test('the advertised bounds go through the PAGE, not only the function', async () => {
    // The conversion is reachable from this file; the reader is not. Both
    // declared bounds are typed into the real control and applied, and the
    // request that leaves has to carry them.
    await ready();
    for (const bound of [WALL_CLOCK_MIN, WALL_CLOCK_MAX]) {
      const before = auditCount();
      await apply('From', bound);
      await waitFor(() => expect(auditCount(), `${bound} spent no request`).toBeGreaterThan(before));
      expect(screen.queryByRole('alert'), `${bound} was refused`).not.toBeInTheDocument();
      expect(lastAudit().searchParams.get('since')).toBe(instantOf(bound));
    }
  });

  test('every year the control admits round-trips, including 0001-0099', () => {
    // Round-2 review PRODUCTION P1-R2. `new Date(year, ...)` maps 0-99 to
    // 1900-1999, so the advertised minimum built 1901, failed its own
    // round-trip and was reported to the reader as a skipped daylight-saving
    // hour. The years below straddle that discontinuity on both sides.
    for (const year of [1, 99, 100, 1899, 1900, 1901, 2026, 9998]) {
      const wall = `${String(year).padStart(4, '0')}-06-15T12:34`;
      const instant = instantOf(wall);
      expect(instant, `${wall} was refused`).toBeTruthy();
      expect(instant as string, `${wall} left the route's grammar`).toMatch(ROUTE_INSTANT);
      // THE OUTSIDE ANCHOR, and the one the 1900 offset cannot satisfy: the
      // instant belongs to the year that was asked for. A wall time is at
      // most one day from its instant in any zone, so the UTC year can differ
      // by one at a boundary and by nothing at all in mid-June.
      expect(Number((instant as string).slice(0, 4)),
        `${wall} produced an instant in another era`).toBe(year);
      // And the reading is exact, not merely in the right year: the instant
      // spells the same wall time back on this process's clock.
      const back = new Date(instant as string);
      expect(back.getFullYear()).toBe(year);
      expect(back.getMonth()).toBe(5);
      expect(back.getDate()).toBe(15);
      expect(back.getHours()).toBe(12);
      expect(back.getMinutes()).toBe(34);
    }
  });

  test('a wall time whose INSTANT the route cannot spell is refused in words', async () => {
    // The other half of the range contract, and the reason the advertised
    // bounds step a day in from the edges. Warsaw ran on +01:24 in year 0, so
    // the wall time `0000-01-01T00:00` is an instant BEFORE year 0; there is
    // nothing wrong with the reading, but `toISOString` spells it
    // `-000001-12-31T22:36:00.000Z` and the route's four-digit grammar
    // rejects it. The page owes the reader that sentence, not a 400.
    expect(readInstant('0000-01-01T00:00'))
      .toEqual({ kind: 'out-of-grammar', where: 'instant' });
    // And the refusal is NOT the nonexistent-wall-time one: a wrong reason is
    // how P1-R2 presented itself to the reader, and the outcome type is what
    // now keeps the two apart at the type level rather than by string.
    expect(readInstant('0000-01-01T00:00').kind).not.toBe('nonexistent-local-time');
    // The page-level half of this is in `AuditPage.range.test.tsx`, on a
    // clock WEST of UTC: an `<input type="datetime-local">` will not hold
    // year 0000 (jsdom sanitises it away, as a browser does), so the value
    // that reaches a reader on this clock cannot be driven through the
    // control. West of UTC the out-of-range value is `9999-12-31T23:59`,
    // which the control does hold.
  });

  test('the page says out loud which reading it takes', async () => {
    await ready();
    expect(screen.getByText(/passes through twice is read as its first occurrence/)).toBeInTheDocument();
  });
});
