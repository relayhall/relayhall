/*
 * My connections (card 653be44f; owner design record 99d6b0ad §3.1).
 *
 * The load-bearing claims, and why each is here rather than left to the eye:
 *
 *  - OWN CHAIN ONLY. The page is pinned to the routes that cannot be aimed
 *    elsewhere. The assertion is over the URLs it actually requests, so a
 *    future edit that reaches for `GET /principals` (the whole directory) or
 *    for another person's id fails here rather than in production.
 *  - RE-SHOWN, NOT RE-REVEALED. Re-opening Setup renders the server's
 *    placeholder. A credential-shaped string appearing in that pane would mean
 *    the one-time pack had been stored somewhere it must not be.
 *  - The status word a row shows is the ENUMERATED state, and a disabled
 *    Connector says "disabled" even while it holds a live credential.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { MyConnectionsPage, rowStateOf } from './MyConnectionsPage';
import {
  CONNECTION_TEMPLATES, CREDENTIAL_TOKEN_PATTERN, Connection,
  REGENERATE_ADMIN_ONLY, kindLabelForDescription, mayRegenerateCredential,
  templateForDescription,
} from '../types/connections';

const fetchMock = vi.fn();
vi.mock('../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const CONNECTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const INSTRUCTIONS = {
  boardEndpoint: 'https://board.example/api',
  bootstrapLine: 'You have a RelayHall board at https://board.example/api.',
  mcpConfig: {
    claudeCode: { mcpServers: { relayhall: { headers: { Authorization: 'Bearer <paste your connection credential here>' } } } },
    codex: '[mcp_servers.relayhall]',
    generic: { transport: 'streamable-http' },
  },
  cliEnv: ['export RELAYHALL_TOKEN=<paste your connection credential here>'],
  previewPath: '/principals/me/effective-access',
  credentialPlaceholder: '<paste your connection credential here>',
};

const CONNECTION: Connection = {
  principalId: CONNECTOR_ID,
  handle: 'connector-laptop',
  displayName: 'Laptop',
  status: 'active',
  lastSeenAt: new Date(Date.now() - 3600_000).toISOString(),
  purpose: 'Connector for service laptop',
  service: {
    id: 's1', slug: 'laptop', name: 'Laptop',
    description: CONNECTION_TEMPLATES[0].registrationText,
    status: 'draft', runtimeMode: 'direct', createdAt: null,
  },
  credentials: [{
    id: 'cred-1', keyId: 'rh_dev_public', label: 'Laptop', scopes: ['tasks:read', 'tasks:write'],
    transport: 'mcp', createdAt: null, expiresAt: null, revokedAt: null,
    lastUsedAt: new Date(Date.now() - 120_000).toISOString(), graceUntil: null,
    revealCount: 0, revealable: true, state: 'live',
  }],
  agents: [{
    id: 'agent-1', handle: 'agent-task-1', displayName: null, status: 'active',
    lastSeenAt: null, boundTaskId: '77777777-7777-4777-8777-777777777777',
    mintedUnderWarrantId: null, terminatedAt: null, credentials: [],
  }],
};

const arm = (connections: Connection[], overrides: Record<string, unknown> = {}) => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const target = String(url);
    for (const [suffix, response] of Object.entries(overrides)) {
      if (target.endsWith(suffix)) return response as Response;
    }
    if (target.endsWith('/principals/me')) {
      return { ok: true, status: 200, json: async () => ({ success: true, principal: { id: 'me', handle: 'ada', role: 'user' }, scopes: ['tasks:read', 'tasks:write'] }) };
    }
    if (target.endsWith('/principals/me/connectors')) {
      return { ok: true, status: 200, json: async () => ({ success: true, connectors: connections, instructions: INSTRUCTIONS }) };
    }
    if (target.endsWith('/warrants')) {
      return { ok: true, status: 200, json: async () => ({ success: true, warrants: [] }) };
    }
    if (target.endsWith(`/principals/${CONNECTOR_ID}/grants`)) {
      return { ok: true, status: 200, json: async () => ({ success: true, grants: [] }) };
    }
    if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ success: true }) };
    throw new Error(`unexpected fetch: ${target}`);
  });
};

const renderPage = () => render(<MemoryRouter><MyConnectionsPage /></MemoryRouter>);

beforeEach(() => {
  fetchMock.mockReset();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});
afterEach(cleanup);

describe('My connections', () => {
  it('offers the day-one flow when the person has none', async () => {
    arm([]);
    renderPage();
    await waitFor(() => expect(screen.getByText('No connections yet.')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /Connect your agent|Connect an agent/ }).length).toBeGreaterThan(0);
  });

  it('lists a connection with its name, kind label, state and last use', async () => {
    arm([CONNECTION]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    // The kind label comes back through the SAME template table the wizard
    // wrote from — not from a pattern over the description.
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('live')).toBeInTheDocument();
    expect(screen.getByText(/Last used/)).toBeInTheDocument();
  });

  it('READS ONLY ITS OWN CHAIN: every request is a route that cannot be pointed at another person', async () => {
    arm([CONNECTION]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    await waitFor(() => expect(screen.getByText('What it can do')).toBeInTheDocument());

    const urls = fetchMock.mock.calls.map(([url]: any[]) => String(url));
    // The whole-directory listing is never used here.
    expect(urls.some((u) => /\/principals$/.test(u))).toBe(false);
    // The only id in any URL is the caller's OWN Connector, which came from the
    // own-chain read itself — never an id this page chose.
    for (const url of urls) {
      const match = url.match(/\/principals\/([^/?]+)/);
      if (!match) continue;
      expect(['me', CONNECTOR_ID]).toContain(match[1]);
    }
    // This session is NOT root, so the tab never asks for the object grants it
    // would be refused: it says so instead. The lane widened no gate to reach
    // them (the arm that would is a bounded question, not a change it made).
    expect(urls.some((u) => u.endsWith('/grants'))).toBe(false);
    expect(screen.getByText('Standing object grants on a connection are an administrator view in this release.')).toBeInTheDocument();
  });

  it('RE-SHOWS the instructions around the placeholder — never a credential', async () => {
    arm([CONNECTION]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Setup/ }));
    await waitFor(() => {
      expect(screen.getByText('Paste this into your agent and let it configure itself.')).toBeInTheDocument();
    });
    expect(screen.getByText(/The credential is not: it was displayed once/)).toBeInTheDocument();
    const shown = document.body.textContent || '';
    expect(shown).toContain('<paste your connection credential here>');
    expect(shown).not.toMatch(CREDENTIAL_TOKEN_PATTERN);
    // The control can FIRE: the same pattern matches a real-shaped token, and
    // the public key id this page DOES show is not one.
    expect(CREDENTIAL_TOKEN_PATTERN.test('rh_dev_ab12cd34ef56.SECRETVALUE0000000000')).toBe(true);
    // ...and the public key id, which names a credential without being one,
    // is not matched by it either.
    expect(CREDENTIAL_TOKEN_PATTERN.test('rh_dev_public')).toBe(false);
    // And the one-time warning of step 3 is NOT shown here: it would be false.
    expect(screen.queryByText(/shown once and is never stored on the board/)).not.toBeInTheDocument();
  });

  it('the Advanced tab shows the credential authority, its transport pin and the agents beneath', async () => {
    arm([CONNECTION]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    await waitFor(() => expect(screen.getByText('What it can do')).toBeInTheDocument());
    expect(screen.getByText(/refused on every REST route/)).toBeInTheDocument();
    expect(screen.getByText('Agents minted beneath it')).toBeInTheDocument();
    expect(screen.getByText('agent-task-1')).toBeInTheDocument();
    expect(screen.getByText(/bound to task 77777777/)).toBeInTheDocument();
    // §7.3 is stated where a person would otherwise expect an editable field.
    expect(screen.getByText(/regeneration copies the scope set/)).toBeInTheDocument();
  });

  it('disabling revokes the credential through the self-service route, with a reason', async () => {
    arm([CONNECTION]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Disable/ })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: /Disable/ }));
    const call = fetchMock.mock.calls.find(([url]: any[]) => String(url).endsWith('/credentials/cred-1/revoke'))!;
    expect(call).toBeDefined();
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.reason).toBe('disabled by its owner from My connections');
    await waitFor(() => expect(screen.getByText(/can no longer reach the board/)).toBeInTheDocument());
  });

  it('regeneration is offered but refused to a non-root session, with the reason said plainly', async () => {
    arm([CONNECTION]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Regenerate credential/ })).toBeInTheDocument());
    // Bound to the SHARED predicate and its reason string, not to a literal:
    // the control, the wizard's recovery sentence and this assertion now read
    // from one place, which is what stops them drifting apart again (P3-R2).
    const MEMBER_SCOPES = ['tasks:read', 'tasks:write'];
    expect(mayRegenerateCredential(MEMBER_SCOPES)).toBe(false);
    const button = screen.getByRole('button', { name: /Regenerate credential/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', REGENERATE_ADMIN_ONLY);
    expect(screen.getByText(new RegExp(REGENERATE_ADMIN_ONLY))).toBeInTheDocument();
    expect(screen.getByText(/connecting a new agent and disabling this one/)).toBeInTheDocument();
    // And it is never attempted: a disabled control must not fire the call.
    expect(fetchMock.mock.calls.some(([url]: any[]) => String(url).includes('/rotate'))).toBe(false);
  });

  it('says nothing about connections when the substrate is unmigrated, and offers no create', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/principals/me')) {
        return { ok: true, status: 200, json: async () => ({ success: true, principal: { id: 'me' }, scopes: [] }) };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/identity substrate/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
  });
});

describe('rowStateOf', () => {
  const base = { ...CONNECTION };

  it('reports the live credential of an active Connector', () => {
    expect(rowStateOf(base)).toBe('live');
  });

  it('a DISABLED Connector reads as disabled even while it holds a live credential', () => {
    // The kill switch refuses every credential the principal holds, so the
    // credential's own word would be true but misleading.
    expect(rowStateOf({ ...base, status: 'disabled' })).toBe('disabled');
  });

  it('a Connector with no credential is "none", not "expired"', () => {
    expect(rowStateOf({ ...base, credentials: [] })).toBe('none');
  });

  it('a revoked credential is what the row says when nothing is live', () => {
    expect(rowStateOf({
      ...base,
      credentials: [{ ...base.credentials[0], state: 'revoked' }],
    })).toBe('revoked');
  });
});

describe('the kind label', () => {
  it('a description that CONTAINS a registration text is still not a match — exact, not substring', async () => {
    // The gap this closes was found by the author's own mutation drill:
    // changing `registrationText === description` to `description.includes(...)`
    // left every test green, because the only negative fixture did not contain
    // a registration text either. A control that cannot tell the two
    // implementations apart is not a control for the claim being made.
    const embedded = `Migrated 2026-01-01. ${CONNECTION_TEMPLATES[0].registrationText} Do not edit.`;
    expect(embedded).toContain(CONNECTION_TEMPLATES[0].registrationText);
    expect(templateForDescription(embedded)).toBeNull();
    expect(kindLabelForDescription(embedded)).toBe('Connector');
    // ...and the exact text still matches, so the control is not vacuous the
    // other way either.
    expect(templateForDescription(CONNECTION_TEMPLATES[0].registrationText)?.key)
      .toBe(CONNECTION_TEMPLATES[0].key);

    arm([{ ...CONNECTION, service: { ...CONNECTION.service, description: embedded } }]);
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Laptop' })).toBeInTheDocument());
    const row = screen.getByRole('heading', { level: 2, name: 'Laptop' }).closest('li')!;
    expect(within(row).getByText('Connector')).toBeInTheDocument();
  });

  it('falls back to the ratified object word for a row this table does not know', async () => {
    arm([{ ...CONNECTION, service: { ...CONNECTION.service, description: 'hand-registered by an operator' } }]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    const row = screen.getByRole('heading', { level: 2, name: 'Laptop' }).closest('li')!;
    expect(within(row).getByText('Connector')).toBeInTheDocument();
  });
});
