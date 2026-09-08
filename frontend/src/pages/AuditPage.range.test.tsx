// @vitest-environment jsdom
/**
 * THE ADVERTISED RANGE, ON A CLOCK WEST OF UTC — round-2 review, PRODUCTION
 * P1-R2 and CONTROL C4-R2.
 *
 * `AuditPage.time.test.tsx` pins Europe/Warsaw, which is EAST of UTC. Every
 * range claim it can make is therefore made in the half of the world where
 * the upper bound is comfortable: a wall time late on 31 December 9999 in
 * Warsaw is still year 9999 in UTC. West of UTC it is not — it is year 10000,
 * which `toISOString` spells `+010000-01-01T04:59:00.000Z` and which the
 * route's four-digit grammar (`backend/src/routes/audit.ts`) rejects with a
 * 400 the reader would have to interpret.
 *
 * So this file exists to measure the SAME claim in the other direction. It is
 * a second file rather than three more cases because `process.env.TZ` is read
 * once per process and vitest's `pool: 'forks'` is what makes a per-file pin
 * true.
 *
 * America/New_York, because it is west of UTC in both its offsets and its
 * pre-1883 LMT (-04:56:02) exercises a zone whose offset is not a whole
 * number of minutes — the shape that makes a component round-trip subtle.
 */
process.env.TZ = 'America/New_York';

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
 * requires exactly three, because `toISOString()` always emits three.
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
    if (url.pathname.endsWith('/principals')) return reply({ success: true, principals: [] });
    return reply({ success: true, events: [EVENT], nextCursor: null, retention: 'indefinite', purgeAvailable: false });
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const audits = () => calls.filter((c) => c.includes('/audit'));
const lastAudit = () => new URL(audits().slice(-1)[0], 'http://board.test');

async function ready() {
  render(<AuditPage />);
  await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
}

async function apply(value: string) {
  fireEvent.change(screen.getByLabelText('From'), { target: { value } });
  await userEvent.setup().click(screen.getByRole('button', { name: /Apply/ }));
}

describe('the advertised range, on a clock west of UTC', () => {
  test('the pin took: this process is behind UTC', () => {
    // Without this every assertion below measures a different zone.
    expect(new Date(2026, 0, 15, 12, 0).toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  test('the value the control USED to advertise is out of the route grammar', () => {
    // The red proof for the repair: `9999-12-31T23:59` was the shipped `max`
    // until round 2. On this clock its instant is year 10000, so the page
    // would have advertised a maximum the route answers with a 400.
    const raw = new Date(9999, 11, 31, 23, 59, 0, 0);
    expect(raw.getFullYear()).toBe(9999);
    expect(raw.toISOString()).not.toMatch(ROUTE_INSTANT);
    expect(raw.toISOString().startsWith('+010000')).toBe(true);
    expect(readInstant('9999-12-31T23:59'))
      .toEqual({ kind: 'out-of-grammar', where: 'instant' });
  });

  test('both advertised bounds convert, here as well as east of UTC', () => {
    for (const bound of [WALL_CLOCK_MIN, WALL_CLOCK_MAX]) {
      const instant = instantOf(bound);
      expect(instant, `the conversion refused ${bound}`).toBeTruthy();
      expect(instant as string, `${bound} left the route's grammar`).toMatch(ROUTE_INSTANT);
    }
  });

  test('years 0001-0099 round-trip here too, on a non-integral offset', () => {
    // New York ran on LMT -04:56:02 until 1883, so these years exercise an
    // offset that is not a whole number of minutes. The 1900 remap that
    // PRODUCTION P1-R2 named is what this catches: `new Date(1, ...)` builds
    // 1901, so the instant would land in the twentieth century.
    for (const year of [1, 99, 100, 1882, 1883, 1900, 2026, 9998]) {
      const wall = `${String(year).padStart(4, '0')}-06-15T12:34`;
      const instant = instantOf(wall) as string;
      expect(instant, `${wall} was refused`).toBeTruthy();
      expect(instant, `${wall} left the route's grammar`).toMatch(ROUTE_INSTANT);
      expect(Number(instant.slice(0, 4)), `${wall} produced an instant in another era`).toBe(year);
      const back = new Date(instant);
      expect(back.getFullYear()).toBe(year);
      expect(back.getHours()).toBe(12);
      expect(back.getMinutes()).toBe(34);
    }
  });

  test('the controls advertise what this clock can actually ask', async () => {
    await ready();
    for (const field of ['From', /^To/] as const) {
      const input = screen.getByLabelText(field);
      expect(input).toHaveAttribute('min', WALL_CLOCK_MIN);
      expect(input).toHaveAttribute('max', WALL_CLOCK_MAX);
    }
    const before = audits().length;
    await apply(WALL_CLOCK_MAX);
    await waitFor(() => expect(audits().length).toBeGreaterThan(before));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(lastAudit().searchParams.get('since')).toMatch(ROUTE_INSTANT);
  });

  test('an unaskable instant is refused by the CONTROL and by the conversion', async () => {
    // Two independent refusals, and both are wanted. The control's `max` puts
    // the value out of range, so the form does not submit and no request is
    // spent — this is what a reader who types past the maximum meets. The
    // conversion refuses it as well, in words, because a `min`/`max` is a
    // property of the control and the conversion is the page's backstop.
    await ready();
    const input = screen.getByLabelText('From') as HTMLInputElement;
    const before = audits().length;
    await apply('9999-12-31T23:59');
    expect(input.value, 'the control did not hold the typed value').toBe('9999-12-31T23:59');
    expect(input.validity.rangeOverflow,
      'the control does not consider the old advertised maximum out of range').toBe(true);
    expect(audits().length, 'an unaskable instant still reached the ledger').toBe(before);
    // The backstop, on the same value.
    expect(readInstant('9999-12-31T23:59'))
      .toEqual({ kind: 'out-of-grammar', where: 'instant' });
  });
});
