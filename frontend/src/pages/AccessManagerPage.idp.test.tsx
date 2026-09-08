// @vitest-environment jsdom
/**
 * AccessManagerPage — the Identity-provider surface (RH-P5.SSO.W2, owner D5).
 *
 * What these pin:
 *  - the section is ROOT-ONLY, matching the backend: the whole
 *    /identity-providers family sits behind the root sentinel in the scope map
 *    and mints no scope family of its own (A23.6). A surface that rendered for
 *    a non-root Account would promise an authority the routes refuse;
 *  - the two ratified declarations are VISIBLE, and the absent
 *    subject-immutable guarantee is loud rather than merely unmarked — an
 *    operator reading this table is deciding what the deployment trusts;
 *  - discovery health is reported honestly: a cache that has never been warmed
 *    is not the same claim as a provider that is down, and the surface must not
 *    conflate them.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
const routes = new Map<string, unknown>();
vi.mock('../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, options?: RequestInit) => {
    fetchCalls.push({ url, options });
    for (const [prefix, body] of routes) {
      if (url.includes(prefix)) return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

import { AccessManagerPage } from './AccessManagerPage';

const IMMUTABLE = {
  id: '11111111-0000-4000-8000-000000000001',
  name: 'Estate SSO',
  issuer: 'https://idp.example.test/application/o/relayhall',
  status: 'active',
  provisioningMode: 'invited',
  clientAuthMethod: 'client_secret_basic',
  hasClientSecret: true,
  subjectImmutable: true,
};

const RISKY = {
  ...IMMUTABLE,
  id: '22222222-0000-4000-8000-000000000002',
  name: 'Lab SSO',
  subjectImmutable: false,
  allowPrivateIssuerAddress: true,
};

function seed(providers: unknown[]) {
  routes.clear();
  fetchCalls.length = 0;
  // Ordered longest-prefix-first is not needed here: only one identity route
  // is seeded per test, and the detail route is added where a test needs it.
  routes.set('/identity-providers', { identityProviders: providers });
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

const renderPage = () => render(
  <MemoryRouter><AccessManagerPage /></MemoryRouter>,
);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the Identity-provider surface is root-only, like the routes', () => {
  test('root sees it', async () => {
    asRoot();
    seed([IMMUTABLE]);
    renderPage();
    expect(await screen.findByRole('heading', { name: /Identity providers/i })).toBeInTheDocument();
    expect(await screen.findByText('Estate SSO')).toBeInTheDocument();
  });

  test('a non-root Account does not, and the page still renders', async () => {
    asNonRoot();
    seed([IMMUTABLE]);
    renderPage();
    // The control: the Access manager itself admits every authenticated
    // Account, so the absence below is this section's root gate and not a
    // page that failed to mount.
    expect(await screen.findByRole('heading', { name: 'Access manager' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Identity providers/i })).not.toBeInTheDocument();
    expect(fetchCalls.some((call) => call.url.includes('/identity-providers'))).toBe(false);
  });
});

describe('the ratified declarations are visible', () => {
  test('an immutable-subject provider says so', async () => {
    asRoot();
    seed([IMMUTABLE]);
    renderPage();
    expect(await screen.findByText('subjects immutable')).toBeInTheDocument();
  });

  test('a provider without the guarantee is loud, not merely unmarked', async () => {
    asRoot();
    seed([RISKY]);
    renderPage();
    expect(await screen.findByText(/subjects NOT declared immutable/i)).toBeInTheDocument();
    expect(await screen.findByText(/private issuer address permitted/i)).toBeInTheDocument();
  });

  test('a provider that has not been granted the private-address exception carries no such badge', async () => {
    // The negative control for the badge above: it tracks the field, and is
    // not simply always rendered.
    asRoot();
    seed([IMMUTABLE]);
    renderPage();
    await screen.findByText('Estate SSO');
    expect(screen.queryByText(/private issuer address permitted/i)).not.toBeInTheDocument();
  });
});

describe('discovery health is reported honestly', () => {
  test('says it has not been checked rather than implying a state', async () => {
    asRoot();
    seed([IMMUTABLE]);
    renderPage();
    expect(await screen.findByText(/not checked this session/i)).toBeInTheDocument();
  });

  test('a warmed cache reports when, and a cold one says cold rather than down', async () => {
    asRoot();
    seed([IMMUTABLE]);
    // The detail route answers with metadata warmed and JWKS still cold: the
    // two are separate facts and the surface must not merge them.
    routes.set(`/identity-providers/${IMMUTABLE.id}`, {
      identityProvider: IMMUTABLE,
      health: { metadataFetchedAt: Date.UTC(2026, 7, 30, 12, 0, 0), jwksFetchedAt: null },
    });
    renderPage();
    await screen.findByText('Estate SSO');
    await userEvent.click(screen.getByRole('button', { name: /Check connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/jwks never — cache cold/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/^metadata /i)).toBeInTheDocument();
    expect(fetchCalls.some((call) => call.url.includes('/test-connection'))).toBe(true);
  });
});

describe('the W4 directory-provisioning facts are visible (A24 binding, SSO-R8 heartbeat)', () => {
  test('an Identity provider with a SCIM client and a heartbeat interval says both', async () => {
    asRoot();
    seed([{ ...IMMUTABLE, provisioningMode: 'directory', scimClientPrincipalId: 'p-scim-account', scimHeartbeatIntervalHours: 6 }]);
    renderPage();
    expect(await screen.findByText('SCIM client bound')).toBeInTheDocument();
    expect(screen.getByText(/directory push expected every 6 h/i)).toBeInTheDocument();
    expect(screen.getByText(/active · directory/i)).toBeInTheDocument();
  });

  test('CONTROL: without them neither badge is rendered, and the row still is', async () => {
    asRoot();
    seed([IMMUTABLE]);
    renderPage();
    await screen.findByText('Estate SSO');
    expect(screen.queryByText('SCIM client bound')).not.toBeInTheDocument();
    expect(screen.queryByText(/directory push expected/i)).not.toBeInTheDocument();
  });
});
