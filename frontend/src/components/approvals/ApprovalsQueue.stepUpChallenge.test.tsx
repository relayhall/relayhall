// @vitest-environment jsdom
/**
 * The approval decision answers the step-up challenge — card 7a99d63e
 * (design SU-14, SU-33).
 *
 * A step-up token lives about five minutes and is burned on use, so a
 * decision can arrive with a token that no longer counts. The board then
 * answers `403 STEP_UP_REQUIRED` with `stepUp: { action, targetId, ... }`.
 * What these pin, through the real Access manager page and the real dialog:
 *  - the dialog reopens for exactly that approval, and the decision is sent
 *    ONE more time with the new token;
 *  - a second challenge, a cancelled dialog, a plain 403 and a 401 each end
 *    the flow with an error and no further decision request.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();
vi.mock('../../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

const MINT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
type Reply = { status: number; body: unknown };
const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
let decideReplies: Reply[] = [];
let mintedTokens = 0;
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, options?: RequestInit) => {
    fetchCalls.push({ url, options });
    const reply = (value: Reply) => ({ ok: value.status < 400, status: value.status, json: async () => value.body });
    if (url.endsWith(`/approvals/${MINT_ID}/approve`)) {
      return reply(decideReplies.shift() ?? { status: 200, body: { success: true } });
    }
    if (url.endsWith('/auth/step-up/methods')) return reply({ status: 200, body: { success: true, methods: ['password'], preferred: 'password' } });
    if (url.endsWith('/auth/step-up')) {
      mintedTokens += 1;
      return reply({ status: 200, body: { success: true, stepUpToken: `rhsu_token_${mintedTokens}` } });
    }
    if (/\/approvals(\?|$)/.test(url)) return reply({ status: 200, body: { success: true, approvals: [MINT] } });
    if (url.includes('/warrants')) return reply({ status: 200, body: { success: true, warrants: [] } });
    if (url.includes('/access-profiles')) return reply({ status: 200, body: { success: true, profiles: [] } });
    if (url.includes('/principals/remediation-queue')) return reply({ status: 200, body: { success: true, queue: [] } });
    if (url.includes('/groups/directory-sync')) return reply({ status: 200, body: { success: true, providers: [] } });
    return reply({ status: 200, body: { success: true } });
  }),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

import { AccessManagerPage } from '../../pages/AccessManagerPage';

const MINT = {
  id: MINT_ID, kind: 'agent-mint', status: 'pending',
  requesterPrincipalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  requesterHandle: 'conn-beta', targetTaskId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  targetTaskTitle: 'Fix the flux', requestedScopes: ['tasks:read'],
  requestedRules: [], approvedScopes: null, lapseReason: null, denialReason: null,
  requestedAt: '2026-10-09T10:00:00.000Z', pendingExpiresAt: '2026-10-16T10:00:00.000Z', collectExpiresAt: null,
};

const CHALLENGE: Reply = {
  status: 403,
  body: {
    error: 'Refused', code: 'STEP_UP_REQUIRED', message: 'This act requires a live single-use step-up token',
    stepUp: { error: 'insufficient_user_authentication', action: 'approval.decide', targetId: MINT_ID, max_age: 0 },
  },
};

function decisions(): Array<Record<string, unknown>> {
  return fetchCalls
    .filter((call) => call.url.endsWith(`/approvals/${MINT_ID}/approve`))
    .map((call) => JSON.parse(String(call.options?.body)));
}

async function approveWithPassword() {
  render(<MemoryRouter initialEntries={[`/settings/access-manager?approval=${MINT_ID}`]}><AccessManagerPage /></MemoryRouter>);
  await screen.findByText('conn-beta');
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await userEvent.type(await screen.findByLabelText('Password'), 'hunter2');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

beforeEach(() => {
  useMyPrincipal.mockReturnValue({ me: { id: 'p-root', role: 'orchestrator', handle: 'root' }, scopes: ['root'], loading: false });
  usePrincipals.mockReturnValue({ principals: [] });
  decideReplies = [];
  mintedTokens = 0;
  fetchCalls.length = 0;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('a decision that meets the step-up challenge', () => {
  test('reopens the dialog for exactly that approval and sends the decision once more with the new token', async () => {
    decideReplies = [CHALLENGE, { status: 200, body: { success: true } }];
    await approveWithPassword();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Your confirmation was no longer valid when the decision arrived.');
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(decisions()).toHaveLength(2));
    expect(decisions().map((body) => body.stepUpToken)).toEqual(['rhsu_token_1', 'rhsu_token_2']);
    const minted = fetchCalls.filter((call) => call.url.endsWith('/auth/step-up'));
    expect(minted.map((call) => JSON.parse(String(call.options?.body)))).toEqual([
      { password: 'hunter2', action: 'approval.decide', targetId: MINT_ID },
      { password: 'hunter2', action: 'approval.decide', targetId: MINT_ID },
    ]);
    expect(await screen.findByText(/^Approved\./)).toBeInTheDocument();
  });

  test('a second challenge is shown as an error, never retried again', async () => {
    decideReplies = [CHALLENGE, CHALLENGE];
    await approveWithPassword();
    await screen.findByRole('dialog');
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/requires a live single-use step-up token/)).toBeInTheDocument();
    expect(decisions()).toHaveLength(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('cancelling the reopened dialog sends nothing more', async () => {
    decideReplies = [CHALLENGE];
    await approveWithPassword();
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(/requires a live single-use step-up token/)).toBeInTheDocument();
    expect(decisions()).toHaveLength(1);
  });

  test.each([
    ['a plain 403', { status: 403, body: { error: 'Refused', code: 'SESSION_ONLY', message: 'Approvals are a login-session act' } }],
    ['a 401', { status: 401, body: { error: 'Unauthorized', code: 'STEP_UP_REQUIRED', message: 'Approvals are a login-session act', stepUp: CHALLENGE.body && (CHALLENGE.body as { stepUp: unknown }).stepUp } }],
  ])('%s does not reopen the dialog', async (_label, reply) => {
    decideReplies = [reply as Reply];
    await approveWithPassword();
    // The exact refusal text: the Access manager also mounts the Group roles
    // panel (LENSES-c c1-A), whose intro mentions login-session acts.
    expect(await screen.findByText('Approvals are a login-session act')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(decisions()).toHaveLength(1);
  });
});
