// @vitest-environment jsdom
/**
 * A CIVIL TIME THAT DOES NOT EXIST, FOR A REASON THAT IS NOT DAYLIGHT SAVING.
 *
 * Round-3 review, PRODUCTION P1-R3. The page used to answer every refused wall
 * time with one sentence: "the hour it names is skipped by a daylight-saving
 * change". Samoa moved across the international date line at the end of 2011
 * and 30 December 2011 did not happen there at all — the whole day, not an
 * hour, and not a daylight-saving transition. A reader who typed
 * `2011-12-30T12:00` on a Pacific/Apia clock met a confident wrong reason.
 *
 * This file pins that zone, for the reason `AuditPage.time.test.tsx` pins
 * Europe/Warsaw: `process.env.TZ` is process-wide, and vitest's `pool:
 * 'forks'` is what keeps the pin inside one file.
 *
 * THE TWO FILES ASSERT THE SAME OUTCOME ON PURPOSE. Warsaw's gap is one hour
 * and is daylight saving; this one is twenty-four hours and is a dateline
 * move. The page gives them the same sentence because it measured the same
 * thing — that the clock never reaches the value — and it stops there. Any
 * sentence that told them apart would be a claim neither this file nor its
 * sibling can support.
 */
process.env.TZ = 'Pacific/Apia';

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AuditPage, readInstant } from './AuditPage';

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

const auditCount = () => calls.filter((c) => c.includes('/audit')).length;

async function ready() {
  render(<AuditPage />);
  await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
}

async function apply(value: string) {
  fireEvent.change(screen.getByLabelText('From'), { target: { value } });
  await userEvent.setup().click(screen.getByRole('button', { name: /Apply/ }));
}

describe('a wall time removed by something that is not daylight saving', () => {
  test('the pin took: this process is on the clock that lost a whole day', () => {
    // If this fails, every assertion below is measuring another timezone.
    // Anchored on the runtime's own tz data rather than on the page: 30
    // December 2011 is absent, and the days on either side of it are present.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Pacific/Apia');
    expect(new Date(2011, 11, 30, 12, 0).getDate(),
      'this runtime still has 30 December 2011 in Apia').not.toBe(30);
    expect(new Date(2011, 11, 29, 12, 0).getDate()).toBe(29);
    expect(new Date(2011, 11, 31, 12, 0).getDate()).toBe(31);
  });

  test('the gap is a WHOLE DAY, which no daylight-saving change has ever been', () => {
    // The outside anchor for the sentence this page must not write. A
    // daylight-saving transition moves a clock by an hour or two; every hour
    // of 30 December 2011 is missing in Apia. Measured here, not asserted, so
    // that the claim "the cause is open-ended" rests on something.
    for (const hour of ['00:00', '06:30', '12:00', '18:45', '23:59']) {
      expect(readInstant(`2011-12-30T${hour}`).kind,
        `2011-12-30T${hour} was expected to be missing from this clock`)
        .toBe('nonexistent-local-time');
    }
    expect(readInstant('2011-12-29T23:59').kind).toBe('ok');
    expect(readInstant('2011-12-31T00:00').kind).toBe('ok');
  });

  test('the conversion says what it measured and names the zone', () => {
    expect(readInstant('2011-12-30T12:00')).toEqual({
      kind: 'nonexistent-local-time',
      local: '2011-12-30T12:00',
      zone: 'Pacific/Apia',
    });
  });

  test('the sentence the READER meets carries no cause at all', async () => {
    await ready();
    const before = auditCount();
    await apply('2011-12-30T12:00');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/does not exist in Pacific\/Apia/);
    expect(alert).toHaveTextContent('2011-12-30T12:00');
    // THE DEFECT, stated as an assertion. Any of these words is the page
    // explaining a mechanism it did not establish.
    expect(alert.textContent ?? '',
      'the page explained a cause it never measured')
      .not.toMatch(/daylight|saving|DST|summer time/i);
    expect(auditCount(),
      'a time that does not exist still reached the ledger').toBe(before);
  });

  test('ordinary times on this clock are untouched by any of it', async () => {
    // Apia is +13:00 in September. A file that pins a strange zone has to show
    // the strange zone still works, or it is only proving that everything
    // fails here.
    expect(readInstant('2026-09-01T12:00')).toEqual({
      kind: 'ok', instant: '2026-08-31T23:00:00.000Z',
    });
  });
});
