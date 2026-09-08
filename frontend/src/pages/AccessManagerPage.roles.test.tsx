// @vitest-environment jsdom
/**
 * THE ROLE CONTROL on the Access manager (owner ruling `60307311` §1.2).
 *
 * What is load-bearing here is what the control OFFERS, because everything it
 * offers the route must then accept:
 *  - it appears for an administrator — including the `operator` role the
 *    page's own root gate excludes, which is the whole reason the ruling names
 *    operators;
 *  - it does not appear for an ordinary Account;
 *  - the role list is narrowed by the viewer's own role, so an operator is
 *    never offered a choice `canAssignRole` would refuse;
 *  - the target list excludes the caller's own row and the two identities the
 *    route refuses by name, so those refusals are unreachable rather than
 *    merely explained;
 *  - the act goes to the route, as a POST carrying only the role;
 *  - a server refusal is surfaced VERBATIM rather than reinterpreted.
 */
import '@testing-library/jest-dom/vitest';
import axe from 'axe-core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
const responses = { role: null as null | { ok: boolean; status: number; body: unknown } };
vi.mock('../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, options?: RequestInit) => {
    fetchCalls.push({ url, options });
    if (url.includes('/role')) {
      const scripted = responses.role ?? {
        ok: true, status: 200,
        body: {
          success: true,
          principal: { id: 'p-tessa', handle: 'tessa', role: 'editor' },
          previousRole: 'viewer',
          effectiveFrom: 'next-request',
          note: 'tessa carries the role editor from their next request; no re-login is required.',
        },
      };
      return { ok: scripted.ok, status: scripted.status, json: async () => scripted.body };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

import { AccessManagerPage } from './AccessManagerPage';

const ME_ADMIN = { id: 'p-ada', handle: 'ada', role: 'admin' };
const ME_OPERATOR = { id: 'p-olive', handle: 'olive', role: 'operator' };
const ME_USER = { id: 'p-ulrich', handle: 'ulrich', role: 'user' };

const DIRECTORY = [
  { id: 'p-ada', handle: 'ada', displayName: 'Ada', kind: 'human', status: 'active', role: 'admin' },
  { id: 'p-tessa', handle: 'tessa', displayName: 'Tessa', kind: 'human', status: 'active', role: 'viewer' },
  { id: 'p-system', handle: 'system', displayName: 'internal', kind: 'service', status: 'active', role: null },
  { id: 'p-owner', handle: 'dashboard_user', displayName: 'Owner', kind: 'human', status: 'active', role: 'orchestrator' },
];

function renderAs(me: unknown, scopes: string[] | null) {
  useMyPrincipal.mockReturnValue({ me, scopes, loading: false });
  usePrincipals.mockReturnValue({ principals: DIRECTORY, reload: vi.fn() });
  render(<MemoryRouter initialEntries={['/settings/access-manager']}><AccessManagerPage /></MemoryRouter>);
}

const rolesSection = () => screen.getByRole('heading', { name: /^Roles$/ }).closest('section')!;

afterEach(() => { cleanup(); vi.clearAllMocks(); fetchCalls.length = 0; responses.role = null; });

describe('who is offered the control', () => {
  test('an admin session', async () => {
    renderAs(ME_ADMIN, ['root']);
    expect(await screen.findByRole('heading', { name: /^Roles$/ })).toBeInTheDocument();
  });

  test('an OPERATOR session — the role the page own root gate excludes', async () => {
    renderAs(ME_OPERATOR, ['principals:admin', 'tasks:write']);
    expect(await screen.findByRole('heading', { name: /^Roles$/ })).toBeInTheDocument();
    // ...and the root-only panels beside it stay hidden, so this is not the
    // root gate wearing a new name.
    expect(screen.queryByRole('heading', { name: /Granted-access inventory/ })).not.toBeInTheDocument();
  });

  test('never an ordinary Account', async () => {
    renderAs(ME_USER, ['tasks:read']);
    await screen.findByRole('heading', { name: /Pending approvals/ });
    expect(screen.queryByRole('heading', { name: /^Roles$/ })).not.toBeInTheDocument();
  });
});

describe('what the control offers', () => {
  test('an admin is offered every assignable role', async () => {
    renderAs(ME_ADMIN, ['root']);
    await screen.findByRole('heading', { name: /^Roles$/ });
    const options = within(rolesSection()).getByLabelText(/New role/).querySelectorAll('option');
    const values = Array.from(options).map((option) => option.getAttribute('value')).filter(Boolean);
    expect(values).toContain('admin');
    expect(values).toContain('orchestrator');
    expect(values).toContain('viewer');
  });

  test('an operator is NOT offered the two roles that derive root', async () => {
    renderAs(ME_OPERATOR, ['principals:admin']);
    await screen.findByRole('heading', { name: /^Roles$/ });
    const options = within(rolesSection()).getByLabelText(/New role/).querySelectorAll('option');
    const values = Array.from(options).map((option) => option.getAttribute('value')).filter(Boolean);
    expect(values).not.toContain('admin');
    expect(values).not.toContain('orchestrator');
    // The control for the pair: it is a NARROWING, not an empty list.
    expect(values).toContain('editor');
    expect(values).toContain('viewer');
  });

  test('the target list leaves out the caller, `system` and the break-glass identity', async () => {
    renderAs(ME_ADMIN, ['root']);
    await screen.findByRole('heading', { name: /^Roles$/ });
    const options = within(rolesSection()).getByLabelText('Account').querySelectorAll('option');
    const values = Array.from(options).map((option) => option.getAttribute('value')).filter(Boolean);
    expect(values).toEqual(['p-tessa']);
  });
});

describe('the control is reachable', () => {
  test('axe finds no structural violation in the Roles section', async () => {
    // The colour-contrast rule needs a layout engine jsdom does not have; the
    // pairing matrix owns that, per Theme, in scripts/check-design-contrast.py.
    renderAs(ME_ADMIN, ['root']);
    await screen.findByRole('heading', { name: /^Roles$/ });
    const results = await axe.run(rolesSection(), {
      rules: { 'color-contrast': { enabled: false } },
      resultTypes: ['violations'],
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('both controls are labelled, and the section is named by its heading', async () => {
    renderAs(ME_ADMIN, ['root']);
    await screen.findByRole('heading', { name: /^Roles$/ });
    const section = rolesSection();
    expect(within(section).getByLabelText('Account')).toBeInTheDocument();
    expect(within(section).getByLabelText(/New role/)).toBeInTheDocument();
    expect(section.getAttribute('aria-labelledby')).toBe('axm-roles-heading');
  });
});

describe('what the control does', () => {
  test('POSTs the role to the act and reports what the server said', async () => {
    renderAs(ME_ADMIN, ['root']);
    await screen.findByRole('heading', { name: /^Roles$/ });
    const section = rolesSection();
    await userEvent.selectOptions(within(section).getByLabelText('Account'), 'p-tessa');
    await userEvent.selectOptions(within(section).getByLabelText(/New role/), 'editor');
    await userEvent.click(within(section).getByRole('button', { name: 'Change role' }));

    await waitFor(() => expect(fetchCalls.some((call) => call.url.endsWith('/principals/p-tessa/role'))).toBe(true));
    const call = fetchCalls.find((entry) => entry.url.endsWith('/principals/p-tessa/role'))!;
    expect(call.options?.method).toBe('POST');
    expect(JSON.parse(String(call.options?.body))).toEqual({ role: 'editor' });
    // The server's own sentence about when it takes effect, not a local guess.
    expect(await screen.findByText(/no re-login is required/)).toBeInTheDocument();
  });

  test('a server refusal is surfaced verbatim', async () => {
    responses.role = {
      ok: false, status: 403,
      body: {
        error: 'Forbidden', code: 'ROLE_ABOVE_YOUR_AUTHORITY',
        message: "Cannot assign role 'admin' — it is above your own authority ('operator').",
      },
    };
    renderAs(ME_ADMIN, ['root']);
    await screen.findByRole('heading', { name: /^Roles$/ });
    const section = rolesSection();
    await userEvent.selectOptions(within(section).getByLabelText('Account'), 'p-tessa');
    await userEvent.selectOptions(within(section).getByLabelText(/New role/), 'editor');
    await userEvent.click(within(section).getByRole('button', { name: 'Change role' }));
    expect(await screen.findByText(/above your own authority/)).toBeInTheDocument();
  });

  test('the act cannot fire before both fields are chosen', async () => {
    renderAs(ME_ADMIN, ['root']);
    await screen.findByRole('heading', { name: /^Roles$/ });
    const section = rolesSection();
    expect(within(section).getByRole('button', { name: 'Change role' })).toBeDisabled();
    await userEvent.selectOptions(within(section).getByLabelText('Account'), 'p-tessa');
    expect(within(section).getByRole('button', { name: 'Change role' })).toBeDisabled();
    expect(fetchCalls.some((call) => call.url.includes('/role'))).toBe(false);
  });
});
