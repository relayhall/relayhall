// @vitest-environment jsdom
/**
 * AccessManagerPage — RH-P3.AZ-S4 (card aa48fb12; design 4d961e37
 * A17.9/§9.5, T7/T8; review 1897c959 B3/B4). What these pin:
 *  - the self-scope arm (§6.1/AZ-16): a NON-ROOT Account reaches its own
 *    approvals/warrants/reveals (the backend conceals foreign subjects),
 *    while the genuinely root-only surfaces — the cross-principal what-if
 *    inventory and the §10 remediation queue — stay hidden;
 *  - a revealed one-time secret STAYS VISIBLE after the counter refresh
 *    until the user dismisses it (B4);
 *  - the five card surfaces render for root: approvals queue, warrant
 *    registry, granted-access inventory, credential reveals, remediation;
 *  - the approval deep link (?approval=…) expands and marks the linked
 *    item — while DECIDING still routes through the step-up dialog (T8:
 *    the link carries no authority; the act does);
 *  - approving opens the step-up dialog BEFORE any decide call leaves the
 *    page (T7 board-only + §7.6), and no /approve request fires without a
 *    minted token;
 *  - a suspended warrant renders its loud suspension flag (AZ-31a).
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

const APPROVAL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function seedRoutes() {
  routes.clear();
  routes.set('/approvals', {
    success: true,
    approvals: [{
      id: APPROVAL_ID, status: 'pending',
      requesterPrincipalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      requesterHandle: 'conn-alpha', targetTaskId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      targetTaskTitle: 'Fix the flux', requestedScopes: ['tasks:read', 'tasks:write'],
      requestedRules: [], approvedScopes: null, lapseReason: null, denialReason: null,
      requestedAt: new Date().toISOString(), pendingExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      collectExpiresAt: null,
    }],
  });
  routes.set('/warrants', {
    success: true,
    warrants: [{
      id: 'abababab-abab-4aba-8aba-abababababab', name: 'Suspended standing warrant', description: '',
      holderPrincipalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'suspended',
      ceilingProfileName: 'Reporter', ceilingProfileVersionNumber: 1, ceilingRules: null,
      ceilingScopes: ['tasks:read'], expiresAt: null, transportPin: 'any',
      maxConcurrent: 2, maxTotal: null, mintedTotal: 1, liveMinted: 0,
      suspendedReason: 'the creating principal is disabled',
      anchors: [{ anchorType: 'task', anchorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
    }],
  });
  routes.set('/access-profiles', { success: true, profiles: [] });
  routes.set('/principals/remediation-queue', { success: true, queue: [] });
  routes.set('/groups/directory-sync', { success: true, providers: [] });
}

function renderPage(entry = '/settings/access-manager') {
  render(<MemoryRouter initialEntries={[entry]}><AccessManagerPage /></MemoryRouter>);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); fetchCalls.length = 0; });

describe('AccessManagerPage', () => {
  test('a non-root Account reaches its self-scoped queues; root-only panels stay hidden (§6.1/AZ-16, B3)', async () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user' }, scopes: ['tasks:read'], loading: false });
    usePrincipals.mockReturnValue({ principals: [] });
    seedRoutes();
    renderPage();
    expect(await screen.findByRole('heading', { name: /Pending approvals/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Warrant registry/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Credential reveals/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Granted-access inventory/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Remediation queues/ })).not.toBeInTheDocument();
    expect(fetchCalls.some((call) => call.url.includes('/remediation-queue') || call.url.includes('what-if'))).toBe(false);
    // The self-scoped queue content renders (the backend already filtered it).
    expect(await screen.findByText('conn-alpha')).toBeInTheDocument();
  });

  test('renders the five card surfaces for a root session', async () => {
    useMyPrincipal.mockReturnValue({ me: { role: 'orchestrator' }, scopes: ['root'], loading: false });
    usePrincipals.mockReturnValue({ principals: [] });
    seedRoutes();
    renderPage();
    expect(await screen.findByRole('heading', { name: /Pending approvals/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Warrant registry/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Granted-access inventory/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Credential reveals/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Remediation queues/ })).toBeInTheDocument();
    expect(await screen.findByText('conn-alpha')).toBeInTheDocument();
  });

  test('the deep link expands and marks the linked approval — no authority, only focus (T8)', async () => {
    useMyPrincipal.mockReturnValue({ me: { role: 'orchestrator' }, scopes: ['root'], loading: false });
    usePrincipals.mockReturnValue({ principals: [] });
    seedRoutes();
    renderPage(`/settings/access-manager?approval=${APPROVAL_ID}`);
    const item = (await screen.findByText('conn-alpha')).closest('li');
    expect(item).toHaveClass('axm-item--linked');
    // Expanded via the deep link: the requested-scope editor is visible…
    expect(await screen.findByText('tasks:write')).toBeInTheDocument();
    // …and no decision has fired.
    expect(fetchCalls.some((call) => call.url.includes('/approve') || call.url.includes('/deny'))).toBe(false);
  });

  test('approving demands step-up FIRST: the dialog opens and no /approve call leaves without it (T7/§7.6)', async () => {
    useMyPrincipal.mockReturnValue({ me: { role: 'orchestrator' }, scopes: ['root'], loading: false });
    usePrincipals.mockReturnValue({ principals: [] });
    seedRoutes();
    renderPage(`/settings/access-manager?approval=${APPROVAL_ID}`);
    await screen.findByText('conn-alpha');
    const approve = await screen.findByRole('button', { name: /^Approve$/ });
    await userEvent.click(approve);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(fetchCalls.some((call) => call.url.includes('/approve'))).toBe(false);
    // Completing the dialog mints the token, then the decide fires with it.
    routes.set('/auth/step-up', { success: true, stepUpToken: 'rhsu_test_token' });
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(fetchCalls.some((call) => call.url.includes(`/approvals/${APPROVAL_ID}/approve`))).toBe(true);
    });
    const decide = fetchCalls.find((call) => call.url.includes('/approve'));
    expect(String(decide!.options?.body)).toContain('rhsu_test_token');
  });

  test('a revealed one-time secret stays visible after the counter refresh until dismissed (B4)', async () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'orchestrator' }, scopes: ['root'], loading: false });
    usePrincipals.mockReturnValue({
      principals: [{ id: 'c1', handle: 'conn-alpha', displayName: null, kind: 'service', status: 'active' }],
    });
    seedRoutes();
    routes.set('/principals/c1/credentials', {
      success: true,
      credentials: [{ id: 'cred-1', keyId: 'KEYID123', label: 'qa', scopes: ['tasks:read'], revealCount: 0, revealable: true, transport: 'any', revokedAt: null, graceUntil: null, expiresAt: null }],
    });
    routes.set('/credentials/cred-1/reveal', { success: true, token: 'rh_dev_secret_once' });
    routes.set('/auth/step-up', { success: true, stepUpToken: 'rhsu_reveal_token' });
    renderPage();
    await screen.findByRole('heading', { name: /Credential reveals/ });
    await userEvent.selectOptions(screen.getByLabelText('Identity whose credentials to list'), 'c1');
    await userEvent.click(await screen.findByRole('button', { name: /Reveal/ }));
    await userEvent.type(await screen.findByLabelText('Password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // The one-time value renders AND the counter refresh has happened.
    expect(await screen.findByText('rh_dev_secret_once')).toBeInTheDocument();
    const listCalls = fetchCalls.filter((call) => call.url.includes('/principals/c1/credentials'));
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('rh_dev_secret_once')).not.toBeInTheDocument();
  });

  test('the GUI session mint renders the COMPLETE one-time pack until dismissed (§7.4/§8.5, review a0411f86 B1)', async () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'orchestrator' }, scopes: ['root'], loading: false });
    usePrincipals.mockReturnValue({ principals: [] });
    seedRoutes();
    routes.set('/auth/step-up', { success: true, stepUpToken: 'rhsu_mint_token' });
    routes.set('/delegation/agent-mints', {
      success: true, path: 'session',
      approval: { status: 'collected' },
      pack: {
        principalId: 'aaaa1111-2222-4333-8444-555555555555', handle: 'agent-pack1', secretOnce: 'rh_dev_pack_secret',
        boundTaskId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scopes: ['tasks:read'], expiresAt: '2026-08-24T00:00:00Z', transport: 'any',
        onboarding: {
          bootstrapLine: 'You have a RelayHall board at https://board/api. Authenticate with your credential and fetch everything else from it.',
          cliEnv: ['export RELAYHALL_API_URL=https://board/api', 'export RELAYHALL_TOKEN=rh_dev_pack_secret'],
          mcpConfig: {
            claudeCode: { mcpServers: { relayhall: { command: 'python3' } } },
            codex: '[mcp_servers.relayhall]\ncommand = "python3"',
            generic: { transport: 'stdio', command: 'python3' },
          },
          authoritySummary: { scopes: ['tasks:read'], rules: [], boundTaskId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
          previewPath: '/principals/me/effective-access',
          brief: 'THE COMPILED BRIEF BODY',
        },
      },
    });
    renderPage();
    await screen.findByRole('heading', { name: /Mint an agent/ });
    await userEvent.click(screen.getByRole('button', { name: 'New agent' }));
    await userEvent.type(screen.getByLabelText('Task id'), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    await userEvent.click(screen.getByRole('button', { name: 'Mint agent' }));
    await userEvent.type(await screen.findByLabelText('Password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // EVERY §7.4 pack field is reachable before dismissal.
    const pack = await screen.findByRole('status', { name: 'One-time agent onboarding pack' });
    expect(pack).toHaveTextContent('rh_dev_pack_secret');
    expect(pack).toHaveTextContent('You have a RelayHall board at https://board/api');
    expect(pack).toHaveTextContent('export RELAYHALL_TOKEN=rh_dev_pack_secret');
    expect(pack).toHaveTextContent('mcpServers');
    expect(pack).toHaveTextContent('mcp_servers.relayhall');
    expect(pack).toHaveTextContent('"transport": "stdio"');
    expect(pack).toHaveTextContent('tasks:read');
    expect(pack).toHaveTextContent('/principals/me/effective-access');
    expect(pack).toHaveTextContent('THE COMPILED BRIEF BODY');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('rh_dev_pack_secret')).not.toBeInTheDocument();
    expect(screen.queryByText('THE COMPILED BRIEF BODY')).not.toBeInTheDocument();
  });

  test('a suspended warrant renders its loud suspension flag (AZ-31a)', async () => {
    useMyPrincipal.mockReturnValue({ me: { role: 'orchestrator' }, scopes: ['root'], loading: false });
    usePrincipals.mockReturnValue({ principals: [] });
    seedRoutes();
    renderPage();
    expect(await screen.findByText(/the creating principal is disabled/)).toBeInTheDocument();
    expect(screen.getByText('Suspended standing warrant')).toBeInTheDocument();
  });
});
