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
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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

  test('the Group roles sub-panel: read-only for a principals:read session, absent without it, with appoint for root (LENSES-c c1-A)', async () => {
    usePrincipals.mockReturnValue({ principals: [] });
    seedRoutes();
    useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user' }, scopes: ['tasks:read'], loading: false });
    renderPage();
    expect(await screen.findByRole('heading', { name: /Pending approvals/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Group roles/ })).not.toBeInTheDocument();
    cleanup();
    useMyPrincipal.mockReturnValue({ me: { id: 'p2', role: 'editor' }, scopes: ['tasks:read', 'principals:read'], loading: false });
    renderPage();
    expect(await screen.findByRole('heading', { name: /Group roles/ })).toBeInTheDocument();
    expect(screen.getByText(/Only a root login session appoints or removes a role/)).toBeInTheDocument();
    cleanup();
    useMyPrincipal.mockReturnValue({ me: { role: 'orchestrator' }, scopes: ['root'], loading: false });
    renderPage();
    expect(await screen.findByRole('heading', { name: /Group roles/ })).toBeInTheDocument();
    expect(screen.getByText(/Appointing and removing are root login-session acts/)).toBeInTheDocument();
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

  test('a request with no object rule says what "none" grants and which switch withholds it (c334177b)', async () => {
    useMyPrincipal.mockReturnValue({ me: { role: 'orchestrator' }, scopes: ['root'], loading: false });
    usePrincipals.mockReturnValue({ principals: [] });
    seedRoutes();
    renderPage(`/settings/access-manager?approval=${APPROVAL_ID}`);
    await screen.findByText('conn-alpha');
    const none = await screen.findByText(/^None\. With tasks:write the agent can claim, move, report on and finish its bound task/);
    expect(none).toHaveTextContent('that task only, and never beyond what the requesting connector may do there');
    expect(none).toHaveTextContent('Untick tasks:write to withhold it.');
    // The retired claim that a rule-less agent "works purely through its role" is gone.
    expect(screen.queryByText(/works purely through its bound-task role/)).not.toBeInTheDocument();
  });

  test('unticking every requested rule says the agent is approved with none, and what that still grants (c334177b)', async () => {
    useMyPrincipal.mockReturnValue({ me: { role: 'orchestrator' }, scopes: ['root'], loading: false });
    usePrincipals.mockReturnValue({ principals: [] });
    seedRoutes();
    const approvals = (routes.get('/approvals') as { approvals: Array<Record<string, unknown>> }).approvals;
    approvals[0].requestedRules = [{
      resourceType: 'task', selectorForm: 'exact', selectorIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'], verbs: ['read', 'write'],
    }];
    renderPage(`/settings/access-manager?approval=${APPROVAL_ID}`);
    await screen.findByText('conn-alpha');
    const rule = await screen.findByRole('checkbox', { name: /read\/write on 1 exact task/ });
    expect(screen.queryByText(/^Every rule unticked/)).not.toBeInTheDocument();
    await userEvent.click(rule);
    expect(await screen.findByText(/^Every rule unticked: approved with none, the agent can still claim, move, report on and/))
      .toHaveTextContent('Untick tasks:write to withhold that too.');
    expect(screen.getByRole('button', { name: 'Approve narrowed' })).toBeInTheDocument();
    // Ticked again, the note goes: it describes the edit, not the request.
    await userEvent.click(rule);
    expect(screen.queryByText(/^Every rule unticked/)).not.toBeInTheDocument();
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

  test('an Identity-provider-only owner approves through single sign-on: no password, and the collected token reaches /approve (a3e76724)', async () => {
    useMyPrincipal.mockReturnValue({ me: { role: 'orchestrator' }, scopes: ['root'], loading: false });
    usePrincipals.mockReturnValue({ principals: [] });
    seedRoutes();
    const REQUEST = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
    // Insertion order matters to this double (first prefix wins): the two
    // longer step-up paths go in before the start route they extend.
    routes.set('/auth/step-up/methods', { success: true, methods: ['sso'], preferred: 'sso' });
    routes.set('/auth/step-up/collect', { success: true, method: 'sso', stepUpToken: 'rhsu_sso_token', action: 'approval.decide', targetId: APPROVAL_ID });
    routes.set('/auth/step-up', { success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize', requestId: REQUEST });
    const popup = { location: { href: '' }, close: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => popup as unknown as Window);
    try {
      renderPage(`/settings/access-manager?approval=${APPROVAL_ID}`);
      await screen.findByText('conn-alpha');
      await userEvent.click(await screen.findByRole('button', { name: /^Approve$/ }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      await userEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
      await waitFor(() => expect(popup.location.href).toBe('https://idp.example.test/authorize'));
      const start = fetchCalls.find((call) => call.url.endsWith('/auth/step-up'));
      expect(JSON.parse(String(start!.options?.body))).toEqual({ method: 'sso', action: 'approval.decide', targetId: APPROVAL_ID });
      // Nothing is decided until the Identity provider window lands.
      expect(fetchCalls.some((call) => call.url.includes('/approve'))).toBe(false);
      act(() => {
        window.dispatchEvent(new MessageEvent('message', {
          origin: window.location.origin,
          data: { type: 'relayhall:step-up', outcome: 'complete', requestId: REQUEST, code: null },
        }));
      });
      await waitFor(() => {
        expect(fetchCalls.some((call) => call.url.includes(`/approvals/${APPROVAL_ID}/approve`))).toBe(true);
      });
      const decide = fetchCalls.find((call) => call.url.includes('/approve'));
      expect(String(decide!.options?.body)).toContain('rhsu_sso_token');
    } finally {
      openSpy.mockRestore();
    }
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
