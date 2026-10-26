// @vitest-environment jsdom
/**
 * T1, the dashboard's decision notice (card b1e3b16d, lane L1; design B.3).
 *
 * The acceptance in one line: hidden at 0, shown at N, and an error state that
 * NEVER shows 0 — under a mocked 403 and a mocked 500 as well as a dropped
 * connection and a body without the list. "Hidden at 0" is only evidence if it
 * is told apart from "hidden while loading", so the zero case also asserts the
 * shared read actually settled on an empty list.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const useMyPrincipal = vi.fn();
vi.mock('../../hooks/usePrincipals', () => ({ useMyPrincipal: () => useMyPrincipal() }));

import { DecisionNotice, summarizeDecisions, waitedFor } from './DecisionNotice';
import { pendingApprovals } from './approvals';

const HOUR = 60 * 60 * 1000;
const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function approval(id: string, requestedAgoMs: number, expiresInMs: number) {
  return {
    id, status: 'pending', requesterPrincipalId: `p-${id}`, requesterHandle: `conn-${id}`,
    targetTaskId: `t-${id}`, targetTaskTitle: `Task ${id}`, requestedScopes: ['tasks:read'], requestedRules: [],
    approvedScopes: null, lapseReason: null, denialReason: null,
    requestedAt: new Date(Date.now() - requestedAgoMs).toISOString(),
    pendingExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    collectExpiresAt: null,
  };
}

const renderNotice = () => render(<MemoryRouter><DecisionNotice /></MemoryRouter>);

beforeEach(() => {
  fetchMock.mockReset();
  useMyPrincipal.mockReturnValue({ me: { id: 'p1', handle: 'river' }, scopes: ['tasks:read'], loading: false });
});
afterEach(() => { cleanup(); });

describe('the decision notice', () => {
  test('shows N, by kind, with the oldest wait and what lapses within a day, and leads to the hub tab (E84)', async () => {
    fetchMock.mockResolvedValue(respond(200, { success: true, approvals: [
      approval('a', 5 * HOUR, 30 * HOUR),
      approval('b', 2 * HOUR, 3 * HOUR),
    ] }));
    renderNotice();
    expect(await screen.findByText('2 decisions need you')).toBeInTheDocument();
    expect(screen.getByText('Agent mint: 2')).toBeInTheDocument();
    expect(screen.getByText('Oldest waiting 5 h')).toBeInTheDocument();
    expect(screen.getByText('1 lapses within 24 h')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review decisions' })).toHaveAttribute('href', '/action-center?tab=approvals');
    // The hub view: the pending items this session can see, skill versions it may publish included.
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/approvals\?view=hub&status=pending$/);
  });

  test('counts only what THIS session may decide, skill versions it may publish included (card b1e3b16d)', async () => {
    fetchMock.mockResolvedValue(respond(200, { success: true, approvals: [
      { ...approval('a', 5 * HOUR, 30 * HOUR), decidable: true },
      { ...approval('b', 2 * HOUR, 3 * HOUR), kind: 'grant', decidable: false },
      { ...approval('c', HOUR, 0), kind: 'skill-publish', pendingExpiresAt: null, decidable: true },
    ] }));
    renderNotice();
    expect(await screen.findByText('2 decisions need you')).toBeInTheDocument();
    expect(screen.getByText('Agent mint: 1')).toBeInTheDocument();
    expect(screen.getByText('Skill publish: 1')).toBeInTheDocument();
    expect(screen.queryByText(/Grant request/)).not.toBeInTheDocument();
    // the grant (3 h to lapse) is someone else's: nothing "lapses within 24 h" for this session
    expect(screen.queryByText(/lapses? within/)).not.toBeInTheDocument();
  });

  test('says "1 decision needs you" for one', async () => {
    fetchMock.mockResolvedValue(respond(200, { success: true, approvals: [approval('a', HOUR, 48 * HOUR)] }));
    renderNotice();
    expect(await screen.findByText('1 decision needs you')).toBeInTheDocument();
    expect(screen.queryByText(/lapses within/)).not.toBeInTheDocument();
  });

  test('is hidden at zero — and zero is a READ, not a read still in flight', async () => {
    fetchMock.mockResolvedValue(respond(200, { success: true, approvals: [] }));
    const { container } = renderNotice();
    await waitFor(() => expect(pendingApprovals.getSnapshot()).toEqual({ status: 'ready', value: [] }));
    expect(container).toBeEmptyDOMElement();
  });

  test('renders nothing while the read is in flight', async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    const { container } = renderNotice();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(pendingApprovals.getSnapshot().status).toBe('loading');
    expect(container).toBeEmptyDOMElement();
  });

  test.each([
    ['a 403 refusal', () => respond(403, { error: 'Forbidden', code: 'SESSION_ONLY' })],
    ['a 500 failure', () => respond(500, { error: 'Internal Server Error', code: 'APPROVAL_LIST_FAILED' })],
    ['a 200 without the list', () => respond(200, { success: true })],
  ])('%s is an error state that never says 0', async (_label, answer) => {
    fetchMock.mockResolvedValue(answer());
    const { container } = renderNotice();
    expect(await screen.findByText(/Couldn.t check pending decisions/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b0\b/);
    expect(screen.queryByText(/decisions? needs? you/)).not.toBeInTheDocument();
  });

  test('a dropped connection is an error state too, and Retry reads again', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderNotice();
    expect(await screen.findByText(/Couldn.t check pending decisions/)).toBeInTheDocument();
    fetchMock.mockResolvedValue(respond(200, { success: true, approvals: [approval('a', HOUR, 48 * HOUR)] }));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('1 decision needs you')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('asks nothing for an identity with no resolved principal', async () => {
    useMyPrincipal.mockReturnValue({ me: null, scopes: null, loading: false });
    const { container } = renderNotice();
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  test('a list at the server ceiling is a floor, said as 500+', async () => {
    fetchMock.mockResolvedValue(respond(200, { success: true, approvals:
      Array.from({ length: 500 }, (_, i) => approval(`x${i}`, HOUR, 48 * HOUR)) }));
    renderNotice();
    expect(await screen.findByText('500+ decisions need you')).toBeInTheDocument();
  });
});

describe('the summary arithmetic', () => {
  const now = Date.parse('2026-10-10T12:00:00.000Z');
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const item = (requested: number, expires: number, kind?: string) => ({
    ...approval('s', 0, 0), kind, requestedAt: at(requested), pendingExpiresAt: at(expires),
  }) as Parameters<typeof summarizeDecisions>[0][number];

  test('counts each kind, finds the oldest and counts only FUTURE expiries inside a day', () => {
    const summary = summarizeDecisions([
      item(-3 * HOUR, 23 * HOUR),
      item(-30 * HOUR, 25 * HOUR),
      item(-1 * HOUR, -1 * HOUR),
      item(-2 * HOUR, 24 * HOUR, 'grant'),
    ], now);
    expect(summary.count).toBe(4);
    expect(summary.byKind).toEqual([{ kind: 'agent-mint', count: 3 }, { kind: 'grant', count: 1 }]);
    expect(summary.oldestRequestedAt).toBe(at(-30 * HOUR));
    // 23 h and exactly 24 h are inside; 25 h is not; an already-passed expiry is not "lapsing".
    expect(summary.lapsingWithinDay).toBe(2);
  });

  test('says how long the oldest has waited in the unit a reader would use', () => {
    expect(waitedFor(at(-10 * 60 * 1000), now)).toBe('under an hour');
    expect(waitedFor(at(-5 * HOUR), now)).toBe('5 h');
    expect(waitedFor(at(-50 * HOUR), now)).toBe('2 d');
  });
});
