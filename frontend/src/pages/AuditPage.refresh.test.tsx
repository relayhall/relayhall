// @vitest-environment jsdom
/**
 * WHAT HAPPENS TO A REQUEST THAT IS NO LONGER THE QUESTION.
 *
 * Round-3 review, PRODUCTION P3-R3. The page tracked requests with a monotonic
 * counter, and a counter can only IGNORE a late answer — it cannot stop the
 * request that produced it. Two Refresh clicks issue byte-identical `/audit`
 * URLs; the second made the first stale, so a SUCCESSFUL first answer was
 * discarded, and because the second request was still running the page sat at
 * "Reading the audit log…" with neither rows nor an error, for as long as that
 * transport took — which for a transport that never settles is forever.
 *
 * THE TRANSPORT HERE IS DEFERRED AND IT HONOURS `AbortSignal`. A double that
 * resolved an aborted request anyway would let this page pass a test a browser
 * would fail: a real aborted `fetch` rejects, and the difference is the whole
 * mechanism under test. One case below deliberately turns that off, to measure
 * the other half of the claim — that even a transport which ignores the abort
 * cannot write to a page that has moved on.
 */
process.env.TZ = 'UTC';

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AuditPage } from './AuditPage';

const authenticatedFetch = vi.fn();
vi.mock('../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const event = (action: string) => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-${action.padEnd(12, '0').slice(0, 12)}`,
  occurredAt: '2026-09-04T09:15:00.000Z',
  action, outcome: 'success',
  actorPrincipalId: null, actorHandle: 'owner', authMethod: 'session',
  credentialId: null, resourceType: 'principal', resourceId: null, metadata: {},
});

const page = (action: string) => ({
  success: true, events: [event(action)], nextCursor: null,
  retention: 'indefinite', purgeAvailable: false,
});

type Pending = {
  url: string;
  signal: AbortSignal | undefined;
  /** Answer this request successfully, whatever has happened to it since. */
  settle: (body: unknown) => void;
  aborted: () => boolean;
};

let audits: Pending[] = [];
/** A real aborted fetch rejects. One case below asks what happens if it does not. */
let honourAbort = true;

beforeEach(() => {
  audits = [];
  honourAbort = true;
  vi.clearAllMocks();
  authenticatedFetch.mockImplementation((raw: string, init?: RequestInit) => {
    const url = new URL(raw, 'http://board.test');
    const now = (body: unknown) => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(body),
    });
    if (url.pathname.endsWith('/principals/me')) {
      return now({ success: true, principal: null, scopes: ['root'] });
    }
    if (url.pathname.endsWith('/principals')) return now({ success: true, principals: [] });

    let settle!: (body: unknown) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise((resolve, reject) => {
      settle = (body) => resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      fail = reject;
    });
    const signal = init?.signal ?? undefined;
    signal?.addEventListener('abort', () => {
      if (honourAbort) fail(new DOMException('The operation was aborted.', 'AbortError'));
    });
    audits.push({ url: raw, signal, settle, aborted: () => signal?.aborted === true });
    return promise;
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const reading = () => screen.queryByText(/Reading the audit log/);
/**
 * The header's count of what has been read. This is the observable that catches
 * a write the page should have refused: while a fresh read is in flight the
 * ROW LIST is replaced by the spinner, so rows written underneath it are
 * invisible — and an assertion that cannot see the defect is not an assertion.
 * The count sits in the header and is rendered from the same state the rows
 * come from, so it reports a write whether or not the list is on screen.
 */
const ledgerCount = () => screen.queryByText(/^\d+\+? events?$/);
const refreshButton = () => screen.getByRole('button', { name: /Refresh the audit log/ });

/** Render, and wait for the first audit read to be in flight but unanswered. */
async function pending() {
  render(<AuditPage />);
  await waitFor(() => expect(audits.length).toBe(1));
  await waitFor(() => expect(reading()).toBeInTheDocument());
}

async function answer(request: Pending, body: unknown) {
  await act(async () => {
    request.settle(body);
    await Promise.resolve();
  });
}

describe('a duplicate question is not a new question', () => {
  test('two identical Refreshes leave ONE request and no stranded spinner', async () => {
    // THE DEFECT, exactly as round 3 reproduced it. Two Refreshes while a
    // fresh read is in flight used to make two requests; whichever answered
    // first was discarded as stale, and the page waited on the other one.
    await pending();
    const first = audits[0];
    const user = userEvent.setup();
    await user.click(refreshButton());
    await user.click(refreshButton());

    expect(audits.length,
      'an identical question started another request').toBe(1);
    expect(first.aborted(),
      'the request that answers this exact question was cancelled').toBe(false);
    expect(audits[0].url, 'the adopted request is not the one that was in flight')
      .toBe(first.url);

    await answer(first, page('credential.mint'));

    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    expect(reading(),
      'the page is still reading after its question was answered').not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('adoption lasts only while the request is in flight', async () => {
    // A NEGATIVE CONTROL on the repair: this is not a cache. Once the answer
    // is on screen, Refresh means refresh.
    await pending();
    await answer(audits[0], page('credential.mint'));
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());

    await userEvent.setup().click(refreshButton());
    await waitFor(() => expect(audits.length).toBe(2));
    expect(audits[1].url).toBe(audits[0].url);
  });

  test('a DIFFERENT question is never adopted', async () => {
    // The other negative control: the adoption is keyed on the call made, so
    // two questions that differ must still be two requests. Without this, the
    // repair could be satisfied by never making a second request at all.
    await pending();
    fireEvent.change(screen.getByLabelText('Action starts with'),
      { target: { value: 'credential' } });
    await userEvent.setup().click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => expect(audits.length).toBe(2));
    expect(audits[1].url).not.toBe(audits[0].url);
    expect(new URL(audits[1].url, 'http://board.test').searchParams.get('actionPrefix'))
      .toBe('credential');
  });
});

describe('a superseded request is cancelled, not merely ignored', () => {
  test('a newer question aborts the older transport', async () => {
    await pending();
    const older = audits[0];
    expect(older.signal, 'the request carries no abort signal at all').toBeDefined();
    expect(older.aborted()).toBe(false);

    fireEvent.change(screen.getByLabelText('Action starts with'),
      { target: { value: 'credential' } });
    await userEvent.setup().click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => expect(audits.length).toBe(2));
    expect(older.aborted(),
      'the superseded request was left running and merely ignored').toBe(true);
    expect(audits[1].aborted(), 'the current question was cancelled too').toBe(false);
  });

  test('a stubborn transport that answers after cancellation cannot write', async () => {
    // The half a counter DID get right, kept: a late answer must not reach the
    // page. Here the transport ignores its abort and succeeds anyway — which a
    // browser would not do, and which is precisely why the page must not rely
    // on the transport to enforce this.
    honourAbort = false;
    await pending();
    const older = audits[0];

    fireEvent.change(screen.getByLabelText('Action starts with'),
      { target: { value: 'credential' } });
    await userEvent.setup().click(screen.getByRole('button', { name: /Apply/ }));
    await waitFor(() => expect(audits.length).toBe(2));

    // MEASURED WHILE IT MATTERS. The cancelled answer arrives FIRST and is
    // checked before the current one lands: if the assertion waited until
    // both had settled, the current answer would have overwritten the stale
    // rows and the test would pass without the page having refused anything.
    await answer(older, page('stale.answer'));
    expect(ledgerCount(),
      'a cancelled request wrote its answer into the page').not.toBeInTheDocument();
    expect(reading(),
      'a cancelled request ended the spinner of the question still running').toBeInTheDocument();

    await answer(audits[1], page('credential.mint'));
    await waitFor(() => expect(screen.getByText('credential.mint')).toBeInTheDocument());
    expect(screen.queryByText('stale.answer')).not.toBeInTheDocument();
    expect(ledgerCount()).toHaveTextContent('1 event');
    expect(reading()).not.toBeInTheDocument();
  });

  test('an unaskable new question cancels the read in flight', async () => {
    // Round-2 review PRODUCTION P3-R2, kept under the new mechanism: asking a
    // question that cannot be SENT still invalidates the answer being waited
    // for. The counter did this by advancing before the query was built; the
    // controller does it by aborting on every path except adoption.
    honourAbort = false;
    await pending();
    const older = audits[0];

    fireEvent.change(screen.getByLabelText('Action starts with'),
      { target: { value: 'NOT A PREFIX' } });
    await userEvent.setup().click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(audits.length, 'an unaskable question spent a request').toBe(1);
    expect(older.aborted(),
      'the read in flight was left running under the new error').toBe(true);

    await answer(older, page('stale.answer'));
    expect(screen.queryByText('stale.answer'),
      'the cancelled read put its rows back under the error').not.toBeInTheDocument();
    expect(ledgerCount(),
      'the cancelled read put a count back under the error').not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
