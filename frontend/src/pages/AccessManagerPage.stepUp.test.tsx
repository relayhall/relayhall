// @vitest-environment jsdom
/**
 * AccessManagerPage — the Identity provider's step-up settings (card
 * 7a99d63e, design SU-31 (a), check blocker B-1).
 *
 * Shipping the step-up mechanism changes nothing until root WRITES the
 * provider's step-up policy, so the owner needs a way to write it from her
 * own session. What these pin:
 *  - the section exists for root only, inside the root-only Identity provider
 *    panel (the routes behind it are root-gated);
 *  - the two fields round-trip through `PATCH /identity-providers/:id
 *    {stepUpPolicy}`: what the row holds is what the form shows, and what the
 *    form says is exactly what is sent;
 *  - "Use the default request" sends `stepUpPolicy: null`;
 *  - the SERVER decides: a value it refuses is sent anyway (the form's own
 *    check covers only text that is not a whole number) and its named refusal
 *    is shown as is;
 *  - the section is axe-clean and works from the keyboard.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import axe from 'axe-core';
import { afterEach, describe, expect, test, vi } from 'vitest';

const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
let providers: Array<Record<string, unknown>> = [];
let patchReply: { status: number; body: unknown } | null = null;
vi.mock('../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, options?: RequestInit) => {
    fetchCalls.push({ url, options });
    if (options?.method === 'PATCH' && url.includes('/identity-providers/')) {
      if (patchReply) {
        const reply = patchReply;
        return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
      }
      const sent = JSON.parse(String(options.body));
      providers = providers.map((row) => ({ ...row, stepUpPolicy: sent.stepUpPolicy }));
      return { ok: true, status: 200, json: async () => ({ identityProvider: providers[0] }) };
    }
    if (url.endsWith('/identity-providers')) {
      return { ok: true, status: 200, json: async () => ({ identityProviders: providers }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

import { AccessManagerPage } from './AccessManagerPage';

const PROVIDER = {
  id: '11111111-0000-4000-8000-000000000001',
  name: 'Estate SSO',
  issuer: 'https://idp.example.test/application/o/relayhall',
  status: 'active',
  provisioningMode: 'invited',
  clientAuthMethod: 'client_secret_basic',
  hasClientSecret: true,
  subjectImmutable: true,
};

function seed(policy: unknown) {
  fetchCalls.length = 0;
  patchReply = null;
  providers = [{ ...PROVIDER, stepUpPolicy: policy }];
  usePrincipals.mockReturnValue({ principals: [] });
}

function asRoot() {
  useMyPrincipal.mockReturnValue({
    me: { id: 'p-root', handle: 'owner', kind: 'human', role: 'orchestrator' },
    scopes: ['root'],
    loading: false,
  });
}

function asNonRoot() {
  useMyPrincipal.mockReturnValue({
    me: { id: 'p-user', handle: 'casey', kind: 'human', role: 'user' },
    scopes: ['tasks:read'],
    loading: false,
  });
}

const renderPage = () => render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);

function patches(): Array<Record<string, unknown>> {
  return fetchCalls
    .filter((call) => call.options?.method === 'PATCH')
    .map((call) => JSON.parse(String(call.options?.body)));
}

async function openStepUp() {
  await userEvent.click(await screen.findByRole('button', { name: 'Step-up for Estate SSO' }));
  return screen.findByRole('heading', { name: 'How a step-up asks Estate SSO' });
}

function stepUpRow(): HTMLElement {
  const heading = screen.getByRole('heading', { name: 'How a step-up asks Estate SSO' });
  return heading.closest('[role="row"]') as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('root only', () => {
  test('root sees the Step-up control; a non-root Account sees no Identity provider surface at all', async () => {
    asRoot();
    seed(null);
    renderPage();
    expect(await screen.findByRole('button', { name: 'Step-up for Estate SSO' })).toBeInTheDocument();
    cleanup();
    asNonRoot();
    seed(null);
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Access manager' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Step-up for/ })).not.toBeInTheDocument();
    expect(fetchCalls.some((call) => call.url.includes('/identity-providers'))).toBe(false);
  });
});

describe('the fields round-trip through the PATCH', () => {
  test('no policy shows the default request, and saving the owner\'s settings sends exactly them', async () => {
    asRoot();
    seed(null);
    renderPage();
    await openStepUp();
    const row = stepUpRow();
    const promptLogin = within(row).getByRole('checkbox', { name: 'Ask with prompt=login' });
    const maxAge = within(row).getByLabelText(/Maximum sign-in age \(seconds\)/);
    expect(promptLogin).toBeChecked();
    expect(maxAge).toHaveValue('0');
    expect(within(row).getByRole('button', { name: 'Use the default request' })).toBeDisabled();

    await userEvent.click(promptLogin);
    await userEvent.clear(maxAge);
    await userEvent.type(maxAge, '30');
    await userEvent.click(within(row).getByRole('button', { name: 'Save step-up settings' }));

    await waitFor(() => expect(patches()).toEqual([{ stepUpPolicy: { prompt_login: false, max_age: 30 } }]));
    expect(fetchCalls.find((call) => call.options?.method === 'PATCH')?.url).toMatch(/\/identity-providers\/11111111-0000-4000-8000-000000000001$/);
    expect(await screen.findByText('step-up asks max_age=30')).toBeInTheDocument();
  });

  test('a stored policy is what the form shows; an empty age sends max_age null', async () => {
    asRoot();
    seed({ prompt_login: false, max_age: 30 });
    renderPage();
    expect(await screen.findByText('step-up asks max_age=30')).toBeInTheDocument();
    await openStepUp();
    const row = stepUpRow();
    expect(within(row).getByRole('checkbox', { name: 'Ask with prompt=login' })).not.toBeChecked();
    const maxAge = within(row).getByLabelText(/Maximum sign-in age/);
    expect(maxAge).toHaveValue('30');
    await userEvent.click(within(row).getByRole('checkbox', { name: 'Ask with prompt=login' }));
    await userEvent.clear(maxAge);
    await userEvent.click(within(row).getByRole('button', { name: 'Save step-up settings' }));
    await waitFor(() => expect(patches()).toEqual([{ stepUpPolicy: { prompt_login: true, max_age: null } }]));
  });

  test('Use the default request sends stepUpPolicy null', async () => {
    asRoot();
    seed({ prompt_login: false, max_age: 30 });
    renderPage();
    await openStepUp();
    await userEvent.click(within(stepUpRow()).getByRole('button', { name: 'Use the default request' }));
    await waitFor(() => expect(patches()).toEqual([{ stepUpPolicy: null }]));
    await waitFor(() => expect(screen.queryByText(/^step-up asks /)).not.toBeInTheDocument());
  });
});

describe('the server decides, and its refusal is shown by name', () => {
  test('an age the server refuses is still sent, and PROVIDER_STEP_UP_MAX_AGE_INVALID is shown', async () => {
    asRoot();
    seed(null);
    renderPage();
    await openStepUp();
    const row = stepUpRow();
    patchReply = {
      status: 400,
      body: { error: 'Identity provider refused', code: 'PROVIDER_STEP_UP_MAX_AGE_INVALID', message: 'stepUpPolicy.max_age must be null (not sent), 0, or a whole number of seconds from 10 to 300' },
    };
    const maxAge = within(row).getByLabelText(/Maximum sign-in age/);
    await userEvent.clear(maxAge);
    await userEvent.type(maxAge, '5');
    await userEvent.click(within(row).getByRole('button', { name: 'Save step-up settings' }));
    const alert = await within(row).findByRole('alert');
    expect(alert).toHaveTextContent('PROVIDER_STEP_UP_MAX_AGE_INVALID');
    expect(alert).toHaveTextContent('from 10 to 300');
    expect(patches()).toEqual([{ stepUpPolicy: { prompt_login: true, max_age: 5 } }]);
  });

  test('text that is not a whole number is not sent at all', async () => {
    asRoot();
    seed(null);
    renderPage();
    await openStepUp();
    const row = stepUpRow();
    const maxAge = within(row).getByLabelText(/Maximum sign-in age/);
    await userEvent.clear(maxAge);
    await userEvent.type(maxAge, 'thirty');
    await userEvent.click(within(row).getByRole('button', { name: 'Save step-up settings' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('whole number of seconds');
    expect(patches()).toEqual([]);
  });
});

describe('reachable', () => {
  test('the open section is axe-clean', async () => {
    asRoot();
    seed({ prompt_login: false, max_age: 30 });
    renderPage();
    await openStepUp();
    // The colour-contrast rule needs a layout engine jsdom does not have; the
    // pairing matrix owns that, per Theme, in scripts/check-design-contrast.py.
    const results = await axe.run(stepUpRow(), {
      rules: { 'color-contrast': { enabled: false } },
      resultTypes: ['violations'],
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('the keyboard alone opens it, changes both fields and saves', async () => {
    asRoot();
    seed(null);
    renderPage();
    const open = await screen.findByRole('button', { name: 'Step-up for Estate SSO' });
    open.focus();
    await userEvent.keyboard('{Enter}');
    const row = within(await screen.findByRole('heading', { name: 'How a step-up asks Estate SSO' }).then((heading) => heading.closest('[role="row"]') as HTMLElement));
    const promptLogin = row.getByRole('checkbox', { name: 'Ask with prompt=login' });
    promptLogin.focus();
    await userEvent.keyboard(' ');
    expect(promptLogin).not.toBeChecked();
    await userEvent.tab();
    expect(row.getByLabelText(/Maximum sign-in age/)).toHaveFocus();
    await userEvent.keyboard('{Backspace}30{Enter}');
    await waitFor(() => expect(patches()).toEqual([{ stepUpPolicy: { prompt_login: false, max_age: 30 } }]));
  });
});
