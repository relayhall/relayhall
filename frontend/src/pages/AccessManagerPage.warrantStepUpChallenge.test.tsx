// @vitest-environment jsdom
/**
 * The warrant acts answer the step-up challenge - card 72b8fb97 (design
 * SU-33).
 *
 * Creating a warrant carries a single-use token bound to (warrant.create,
 * holder); a widening edit one bound to (warrant.edit, id). If the token no
 * longer counts when the act arrives, the board answers `403
 * STEP_UP_REQUIRED` with the SU-14 `stepUp` object. These pin, through the
 * REAL page and the real dialog: it opens again for exactly that binding, and
 * the act is sent ONE more time with the same body and the new token; a
 * cancelled second dialog sends nothing more.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { STEP_UP_RETRY_DESCRIPTION } from '../components/access/useStepUpRetry';

const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

const HOLDER = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
const PHASE = '87654321-4321-4cba-8fed-cba987654321';
const PROFILE = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
const WARRANT = {
  id: '55555555-0000-4000-8000-000000000005', name: 'Main phase 10', description: '',
  holderPrincipalId: HOLDER, status: 'active', ceilingProfileName: 'Reporter',
  ceilingProfileVersionNumber: 1, ceilingProfileId: PROFILE, ceilingProfileVersionId: 'vvvvvvvv-0001-4000-8000-000000000001',
  ceilingRules: null, ceilingScopes: ['tasks:read'], expiresAt: null, transportPin: 'any',
  maxConcurrent: 3, maxTotal: 60, mintedTotal: 0, liveMinted: 0, suspendedReason: null,
  anchors: [{ anchorType: 'phase', anchorId: PHASE }],
};

type Reply = { status: number; body: unknown };
const challenge = (action: string, targetId: string): Reply => ({
  status: 403,
  body: {
    error: 'Refused', code: 'STEP_UP_REQUIRED', message: 'This act requires a live single-use step-up token',
    stepUp: { error: 'insufficient_user_authentication', action, targetId, max_age: 0, methods: ['password'] },
  },
});
const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
let actReplies: Reply[] = [];
let warrants: unknown[] = [];
let minted = 0;
vi.mock('../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, options?: RequestInit) => {
    fetchCalls.push({ url, options });
    const reply = (value: Reply) => ({ ok: value.status < 400, status: value.status, json: async () => value.body });
    if (url.endsWith('/auth/step-up/methods')) return reply({ status: 200, body: { success: true, methods: ['password'], preferred: 'password' } });
    if (url.endsWith('/auth/step-up')) {
      minted += 1;
      return reply({ status: 200, body: { success: true, stepUpToken: `rhsu_token_${minted}` } });
    }
    if (options?.method === 'POST' && url.endsWith('/warrants')) {
      return reply(actReplies.shift() ?? { status: 201, body: { success: true, warrant: {} } });
    }
    if (options?.method === 'PATCH' && url.endsWith(`/warrants/${WARRANT.id}`)) {
      return reply(actReplies.shift() ?? { status: 200, body: { success: true, edit: { direction: 'widening', narrowedAgents: [], revokedAgents: [] } } });
    }
    if (url.endsWith('/warrants')) return reply({ status: 200, body: { success: true, warrants } });
    if (url.endsWith(`/warrants/${WARRANT.id}`)) return reply({ status: 200, body: { success: true, mintedIdentities: [] } });
    if (url.endsWith('/access-profiles')) return reply({ status: 200, body: { success: true, profiles: [{ id: PROFILE, name: 'Reporter', publishedVersionNumber: 3 }] } });
    return reply({ status: 200, body: { success: true } });
  }),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

import { AccessManagerPage } from './AccessManagerPage';

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  fetchCalls.length = 0;
  actReplies = [];
  warrants = [];
  minted = 0;
  useMyPrincipal.mockReturnValue({ me: { id: 'p-root', role: 'admin' }, scopes: ['root'], loading: false });
  usePrincipals.mockReturnValue({
    principals: [{ id: HOLDER, handle: 'connector-main', displayName: 'Main connector', kind: 'service', status: 'active' }],
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const acts = (method: string) => fetchCalls
  .filter((call) => call.options?.method === method && /\/warrants(\/[0-9a-f-]+)?$/.test(call.url))
  .map((call) => ({ url: call.url, body: JSON.parse(String(call.options?.body)) }));
const proofs = () => fetchCalls
  .filter((call) => call.url.endsWith('/auth/step-up'))
  .map((call) => JSON.parse(String(call.options?.body)));

async function confirmInDialog() {
  const dialog = within(await screen.findByRole('dialog'));
  await userEvent.type(await dialog.findByLabelText('Password'), 'hunter2');
  await userEvent.click(dialog.getByRole('button', { name: 'Continue' }));
}

async function createWithProfile() {
  render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'New warrant' }));
  const form = within(screen.getByRole('form', { name: 'Create a warrant' }));
  fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Main phase 10' } });
  await userEvent.selectOptions(form.getByLabelText('Holder (connector or service account)'), HOLDER);
  await userEvent.selectOptions(form.getByLabelText('Anchor'), 'phase');
  fireEvent.change(form.getByLabelText('Anchor id'), { target: { value: PHASE } });
  fireEvent.change(form.getByLabelText(/^Expiry/), { target: { value: '2026-11-09T12:00' } });
  await form.findByRole('option', { name: /Reporter/ });
  await userEvent.selectOptions(form.getByLabelText(/^Ceiling profile/), PROFILE);
  await userEvent.click(form.getByRole('button', { name: 'Create warrant' }));
  await confirmInDialog();
}

async function widenEdit() {
  warrants = [WARRANT];
  render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const form = within(screen.getByRole('form', { name: 'Edit a warrant' }));
  fireEvent.change(form.getByLabelText(/^Max concurrent/), { target: { value: '4' } });
  await userEvent.selectOptions(form.getByLabelText('Lifetime for this edit'), 'keep');
  await userEvent.click(form.getByRole('button', { name: 'Save warrant edit' }));
  await confirmInDialog();
}

describe('warrant create', () => {
  test('STEP_UP_REQUIRED reopens the dialog for (warrant.create, holder) and the create is sent once more: same body, new token', async () => {
    actReplies = [challenge('warrant.create', HOLDER)];
    await createWithProfile();
    expect(await screen.findByText(STEP_UP_RETRY_DESCRIPTION)).toBeInTheDocument();
    expect(acts('POST')).toHaveLength(1);
    await confirmInDialog();
    await waitFor(() => expect(acts('POST')).toHaveLength(2));
    const [first, second] = acts('POST');
    expect(first.body).toMatchObject({ stepUpToken: 'rhsu_token_1', holderPrincipalId: HOLDER, ceilingProfileId: PROFILE });
    expect(second.body).toEqual({ ...first.body, stepUpToken: 'rhsu_token_2' });
    expect(proofs()[1]).toMatchObject({ action: 'warrant.create', targetId: HOLDER });
    // The form closed on success: nothing is left refused.
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Create a warrant' })).not.toBeInTheDocument());
  });

  test('cancelling the second dialog sends nothing more and shows the refusal in the form', async () => {
    actReplies = [challenge('warrant.create', HOLDER)];
    await createWithProfile();
    await screen.findByText(STEP_UP_RETRY_DESCRIPTION);
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(/STEP_UP_REQUIRED/)).toBeInTheDocument();
    expect(acts('POST')).toHaveLength(1);
  });
});

describe('warrant edit', () => {
  test('STEP_UP_REQUIRED reopens the dialog for (warrant.edit, id) and the edit is sent once more: same body, new token', async () => {
    actReplies = [challenge('warrant.edit', WARRANT.id)];
    await widenEdit();
    expect(await screen.findByText(STEP_UP_RETRY_DESCRIPTION)).toBeInTheDocument();
    expect(acts('PATCH')).toHaveLength(1);
    await confirmInDialog();
    expect(await screen.findByText(/Warrant edit applied \(widening\)/)).toBeInTheDocument();
    const [first, second] = acts('PATCH');
    expect(acts('PATCH')).toHaveLength(2);
    expect(first.body).toMatchObject({ maxConcurrent: 4, stepUpToken: 'rhsu_token_1', lifetime: { choice: 'keep' } });
    expect(second.body).toEqual({ ...first.body, stepUpToken: 'rhsu_token_2' });
    expect(proofs()[1]).toMatchObject({ action: 'warrant.edit', targetId: WARRANT.id });
  });
});
