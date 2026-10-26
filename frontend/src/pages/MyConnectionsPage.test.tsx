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
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
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
vi.mock('../components/access/StepUpDialog', () => ({
  StepUpDialog: ({ action, targetId, onToken, onCancel }: {
    action: string; targetId: string; onToken: (token: string) => void; onCancel: () => void;
  }) => <div role="dialog" aria-label="Confirm edit">
    <span>{action}:{targetId}</span>
    <button onClick={() => onToken('single-use')}>Confirm edit</button>
    <button onClick={onCancel}>Cancel edit</button>
  </div>,
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

const multiLive = (mcpScopes = ['tasks:read']): Connection => ({
  ...CONNECTION,
  credentials: [
    { ...CONNECTION.credentials[0], id: 'api-credential', keyId: 'api-public',
      label: 'Laptop API', transport: 'api', scopes: ['services:read'] },
    { ...CONNECTION.credentials[0], id: 'mcp-credential', keyId: 'mcp-public',
      label: 'Laptop MCP', transport: 'mcp', scopes: mcpScopes },
  ],
});
const ownerMe = { ok: true, status: 200, json: async () => ({ success: true,
  principal: { id: 'me', handle: 'ada', role: 'user' },
  scopes: ['tasks:read', 'tasks:write', 'services:read'],
  delegableScopes: ['tasks:read', 'tasks:write', 'services:read'] }) };

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
      return { ok: true, status: 200, json: async () => ({ success: true, connectors: connections, instructions: INSTRUCTIONS,
        mayLoosenCredentialTransport: false }) };
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
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
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
    expect(screen.getByText(/Connection last seen/)).toBeInTheDocument();
  });

  it('READS ONLY ITS OWN CHAIN: every request is a route that cannot be pointed at another person', async () => {
    arm([CONNECTION]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    await waitFor(() => expect(screen.getByText('Scopes on this credential')).toBeInTheDocument());

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
    expect(screen.getByText('Direct object grants are an administrator view in this release.')).toBeInTheDocument();
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

  it('a harness-made connection re-shows its install line, and never a token block (E462 S1)', async () => {
    // CONNECTION was made from the Claude Code template, a harness template.
    arm([CONNECTION]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Setup/ }));
    const line = await screen.findByTestId('install-line');
    expect(line.textContent).toBe('relayhall connector install --harness claude-code --board https://board.example');
    // The token was shown once at creation; this page has no copy of it.
    expect(screen.queryByTestId('installer-token')).not.toBeInTheDocument();
    expect(screen.getByText(/The token was shown once, when the connection was made/)).toBeInTheDocument();
  });

  it('CONTROL: a connection made from an ordinary template shows no install line', async () => {
    const generic = CONNECTION_TEMPLATES.find((template) => template.key === 'generic-mcp')!;
    arm([{ ...CONNECTION, service: { ...CONNECTION.service, description: generic.registrationText } }]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Setup/ }));
    await waitFor(() => {
      expect(screen.getByText('Paste this into your agent and let it configure itself.')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('install-line')).not.toBeInTheDocument();
  });

  it('the Advanced tab shows the credential authority, its transport pin and the agents beneath', async () => {
    arm([CONNECTION]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    await waitFor(() => expect(screen.getByText('Scopes on this credential')).toBeInTheDocument());
    expect(screen.getByText(/refused on every REST route/)).toBeInTheDocument();
    expect(screen.getByText('Agents minted beneath it')).toBeInTheDocument();
    expect(screen.getByText('agent-task-1')).toBeInTheDocument();
    expect(screen.getByText(/bound to task 77777777/)).toBeInTheDocument();
    // §7.3 is stated where a person would otherwise expect an editable field.
    expect(screen.getByText(/Edit this credential in place/)).toBeInTheDocument();
  });

  it('revoking asks first, then revokes the credential through the self-service route, with a reason', async () => {
    arm([CONNECTION]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke this credential' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Revoke this credential' }));
    expect(fetchMock.mock.calls.some(([url]: any[]) => String(url).endsWith('/revoke'))).toBe(false);
    await userEvent.click(await screen.findByRole('button', { name: 'Yes, revoke this credential' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]: any[]) => String(url).endsWith('/credentials/cred-1/revoke'))).toBe(true));
    const call = fetchMock.mock.calls.find(([url]: any[]) => String(url).endsWith('/credentials/cred-1/revoke'))!;
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.reason).toBe('revoked by its owner from My connections');
    await waitFor(() => expect(screen.getByText(/Calls using that credential are refused; other credentials on the connection are unchanged/)).toBeInTheDocument());
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
    expect(screen.getByText(/connecting a new agent and revoking this credential/)).toBeInTheDocument();
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

describe('Advanced chain disclosure and credential context', () => {
  const response = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status, json: async () => data,
  } as Response);
  const root = response({ success: true, principal: { id: 'me', handle: 'ada', role: 'admin' }, scopes: ['root', 'tasks:read'] });

  it('does not call loading, inaccessible, or failed chain details empty', async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    arm([CONNECTION], { '/warrants': pending });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    expect(screen.getByText('Loading warrants…')).toBeInTheDocument();
    expect(screen.getByText('Direct object grants are an administrator view in this release.')).toBeInTheDocument();
    expect(screen.queryByText('This connection holds no warrant.')).not.toBeInTheDocument();
    expect(screen.queryByText(/No direct standing object grants/)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]: any[]) => String(url).endsWith('/grants'))).toBe(false);
    await act(async () => { release(response({ success: true, warrants: [] })); });
    expect(await screen.findByText('This connection holds no warrant.')).toBeInTheDocument();
  });

  it('shows loaded empty only after valid arrays, with direct-grant wording', async () => {
    arm([CONNECTION], { '/principals/me': root });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    expect(await screen.findByText('This connection holds no warrant.')).toBeInTheDocument();
    expect(await screen.findByText('No direct standing object grants were returned for this connection.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]: any[]) => String(url).endsWith(`/principals/${CONNECTOR_ID}/grants`))).toBe(true);
  });

  it('shows only this connection’s loaded warrants and its returned direct grant rows', async () => {
    arm([CONNECTION], {
      '/principals/me': root,
      '/warrants': response({ success: true, warrants: [
        { id: 'w1', holderPrincipalId: CONNECTOR_ID, name: 'Task warrant', status: 'active' },
        { id: 'w2', holderPrincipalId: 'foreign', name: 'Foreign warrant', status: 'active' },
      ] }),
      [`/principals/${CONNECTOR_ID}/grants`]: response({ success: true, grants: [
        { id: 'g1', verb: 'read', resourceType: 'task', resourceId: null },
      ] }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    expect(await screen.findByText('Task warrant')).toBeInTheDocument();
    expect(await screen.findByText('read on task (all of that type)')).toBeInTheDocument();
    expect(screen.queryByText('Foreign warrant')).not.toBeInTheDocument();
    expect(screen.getByText('These direct rows do not summarize inherited or effective access.')).toBeInTheDocument();
    expect(screen.queryByText('This connection holds no warrant.')).not.toBeInTheDocument();
  });

  it.each([
    ['missing', { id: 'g1', verb: 'read', resourceType: 'task' }],
    ['numeric', { id: 'g1', verb: 'read', resourceType: 'task', resourceId: 0 }],
    ['blank', { id: 'g1', verb: 'read', resourceType: 'task', resourceId: '  ' }],
  ])('does not render a %s resource id as an all-resource wildcard', async (_kind, grant) => {
    arm([CONNECTION], {
      '/principals/me': root,
      [`/principals/${CONNECTOR_ID}/grants`]: response({ success: true, grants: [grant] }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    expect(await screen.findByText('The board returned an incomplete direct-grant response.')).toBeInTheDocument();
    expect(screen.queryByText(/all of that type/)).not.toBeInTheDocument();
  });

  it('does not treat a failure envelope with rows as a loaded empty result', async () => {
    arm([CONNECTION], {
      '/principals/me': root,
      '/warrants': response({ success: false, warrants: [] }),
      [`/principals/${CONNECTOR_ID}/grants`]: response({ success: false, grants: [] }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    expect(await screen.findByText('The board returned an incomplete warrant response.')).toBeInTheDocument();
    expect(await screen.findByText('The board returned an incomplete direct-grant response.')).toBeInTheDocument();
    expect(screen.queryByText('This connection holds no warrant.')).not.toBeInTheDocument();
    expect(screen.queryByText(/No direct standing object grants/)).not.toBeInTheDocument();
  });

  it('keeps permission refusals distinct from loaded empty results', async () => {
    arm([CONNECTION], {
      '/principals/me': root,
      '/warrants': response({}, 403),
      [`/principals/${CONNECTOR_ID}/grants`]: response({}, 403),
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    expect(await screen.findByText('The board did not disclose warrants to this session.')).toBeInTheDocument();
    expect(await screen.findByText('The board did not disclose direct object grants to this session.')).toBeInTheDocument();
    expect(screen.queryByText('This connection holds no warrant.')).not.toBeInTheDocument();
    expect(screen.queryByText(/No direct standing object grants/)).not.toBeInTheDocument();
  });

  it('keeps malformed successful responses and network failures unknown, then permits retry', async () => {
    arm([CONNECTION], {
      '/principals/me': root,
      '/warrants': response({ success: true, warrants: {} }),
      [`/principals/${CONNECTOR_ID}/grants`]: response({ success: true, grants: null }),
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    expect(await screen.findByText('The board returned an incomplete warrant response.')).toBeInTheDocument();
    expect(await screen.findByText('The board returned an incomplete direct-grant response.')).toBeInTheDocument();
    expect(screen.queryByText('This connection holds no warrant.')).not.toBeInTheDocument();
    expect(screen.queryByText(/No direct standing object grants/)).not.toBeInTheDocument();
    const previous = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/warrants') || String(url).endsWith('/grants')) throw new Error('offline');
      return previous(url, init);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh details' }));
    expect(await screen.findByText('Could not read warrants from the board.')).toBeInTheDocument();
    expect(await screen.findByText('Could not read direct object grants from the board.')).toBeInTheDocument();
    expect(screen.queryByText('This connection holds no warrant.')).not.toBeInTheDocument();
  });

  it('ignores an older chain response after a newer refresh completes', async () => {
    let release!: (value: Response) => void;
    const stale = new Promise<Response>((resolve) => { release = resolve; });
    arm([CONNECTION]);
    const previous = fetchMock.getMockImplementation()!;
    let warrantCalls = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/warrants')) {
        warrantCalls += 1;
        return warrantCalls === 1 ? stale : response({ success: true, warrants: [{ id: 'new', holderPrincipalId: CONNECTOR_ID, name: 'Current warrant', status: 'active' }] });
      }
      return previous(url, init);
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    await waitFor(() => expect(warrantCalls).toBe(1));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh details' }));
    expect(await screen.findByText('Current warrant')).toBeInTheDocument();
    await act(async () => { release(response({ success: true, warrants: [] })); });
    expect(screen.getByText('Current warrant')).toBeInTheDocument();
    expect(screen.queryByText('This connection holds no warrant.')).not.toBeInTheDocument();
  });

  it('names the selected credential without calling its scopes the connection authority or its use the connection activity', async () => {
    const nineteenHoursAgo = new Date(Date.now() - 19 * 3600_000).toISOString();
    const twoCredentials: Connection = { ...CONNECTION,
      credentials: [
        { ...CONNECTION.credentials[0], lastUsedAt: nineteenHoursAgo },
        { ...CONNECTION.credentials[0], id: 'cred-2', keyId: 'rh_dev_other', label: 'Other', scopes: ['services:read'], transport: 'api', state: 'live' },
      ],
    };
    arm([twoCredentials]);
    renderPage();
    expect(await screen.findByText(/Connection last seen/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    // Two credentials: the picker starts on nothing, so the shown credential is a choice.
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Credential to edit' }), 'cred-1');
    expect(screen.getByRole('heading', { name: 'Scopes on this credential' })).toBeInTheDocument();
    expect(screen.getByText('rh_dev_public')).toBeInTheDocument();
    expect(screen.getByText(/one of 2 credentials/)).toBeInTheDocument();
    expect(screen.getByText(/not the connection’s effective authority/)).toBeInTheDocument();
    expect(screen.getByText('Credential last used').nextElementSibling).toHaveTextContent('19 h ago');
    expect(screen.getByText(/mcp — accepted through the MCP endpoint/)).toBeInTheDocument();
    expect(screen.queryByText('What it can do')).not.toBeInTheDocument();
  });

  it('does not invent a transport, expiry, or scopes when a connection has no credential', async () => {
    arm([{ ...CONNECTION, credentials: [] }]);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    expect(screen.getByText('No credential is available for this connection.')).toBeInTheDocument();
    expect(screen.getByText('No credential transport pin is available.')).toBeInTheDocument();
    expect(screen.queryByText(/this credential works through/)).not.toBeInTheDocument();
  });
});

// Card ff410dc4 (SQ-4): disabled rows sat beside active ones. A connection
// that can no longer act folds into one collapsed section with a count, and
// stays readable there; a live one, or one still without a credential, stays
// in the list.
describe('non-active connections fold', () => {
  it('folds a disabled Connector and a revoked credential, and keeps the live and the new one listed', async () => {
    const at = (n: string) => `${n}${CONNECTOR_ID.slice(1)}`;
    const disabled: Connection = { ...CONNECTION, principalId: at('1'), handle: 'old-laptop', status: 'disabled',
      service: { ...CONNECTION.service, id: 's2', name: 'Old laptop' } };
    const revoked: Connection = { ...CONNECTION, principalId: at('2'), handle: 'old-desktop',
      service: { ...CONNECTION.service, id: 's3', name: 'Old desktop' },
      credentials: [{ ...CONNECTION.credentials[0], id: 'cred-r', state: 'revoked', revokedAt: '2026-10-01T00:00:00.000Z' }] };
    const fresh: Connection = { ...CONNECTION, principalId: at('3'), handle: 'new-box',
      service: { ...CONNECTION.service, id: 's4', name: 'New box' }, credentials: [] };
    arm([CONNECTION, disabled, revoked, fresh]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    const summary = screen.getByText('Non-active connections (2)');
    const details = summary.closest('details') as HTMLElement;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText('Old laptop')).toBeInTheDocument();
    expect(within(details).getByText('Old desktop')).toBeInTheDocument();
    expect(within(details).queryByText('Laptop')).not.toBeInTheDocument();
    expect(within(details).queryByText('New box')).not.toBeInTheDocument();
    expect(screen.getByText('New box').closest('details')).toBeNull();
  });

  it('shows no folded section when every connection can act', async () => {
    arm([CONNECTION]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Laptop')).toBeInTheDocument());
    expect(screen.queryByText(/Non-active connections/)).not.toBeInTheDocument();
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

it('lets an account owner explicitly appoint and revoke Main without replacing credentials', async () => {
  arm([CONNECTION]);
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: 'Appoint as Main' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
    String(url).endsWith('/owner-control') && JSON.parse(init.body).enabled === true)).toBe(true));
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rotate'))).toBe(false);
});
it('shows an existing Main appointment and surfaces a refused revocation', async () => {
  arm([{...CONNECTION, ownerControl:true}], {'/owner-control': {
    ok:false,status:403,json:async()=>({error:'The owning account must make this change'}),
  }});
  renderPage();
  await userEvent.click(await screen.findByRole('button', {name:'Remove Main appointment'}));
  expect(await screen.findByText('The owning account must make this change')).toBeInTheDocument();
});

describe('connection permissions entry and live agents', () => {
  it('keeps the multi-credential choice labelled and accessible in Setup and Advanced', async () => {
    arm([multiLive()], { '/principals/me': ownerMe });
    const user = userEvent.setup();
    const { container } = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Setup' }));
    const selector = screen.getByRole('combobox', { name: 'Credential to edit' });
    // Several credentials: the picker starts on no pick, and the permissions
    // entry waits for one (E476 finding).
    expect(selector).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Edit permissions' })).toBeDisabled();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(selector);
    const violations = async () => (await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'],
    })).violations.map(({ id }) => id);
    expect(await violations()).toEqual([]);
    await user.selectOptions(selector, 'api-credential');
    await user.click(screen.getByRole('button', { name: 'Edit permissions' }));
    expect(await violations()).toEqual([]);
  });
  it('edits the expressly selected live MCP credential after Setup, with exact-ID step-up', async () => {
    arm([multiLive()], {
      '/principals/me': ownerMe,
      '/credentials/mcp-credential': { ok: true, status: 200, json: async () => ({ success: true }) },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Setup' }));
    const selector = screen.getByRole('combobox', { name: 'Credential to edit' });
    expect(selector).toHaveValue('');
    expect(within(selector).getByRole('option', { name: /Laptop MCP · mcp · live · mcp-credential/ })).toBeInTheDocument();
    await user.selectOptions(selector, 'mcp-credential');
    await user.click(screen.getByRole('button', { name: 'Edit permissions' }));
    expect(screen.getByText('mcp-public')).toBeInTheDocument();
    expect(screen.getByText(/mcp — accepted through the MCP endpoint/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'tasks:write' }));
    await user.click(screen.getByRole('button', { name: 'Save permissions' }));
    expect(screen.getByRole('dialog', { name: 'Confirm edit' })).toHaveTextContent('credential.edit:mcp-credential');
    await user.click(screen.getByRole('button', { name: 'Confirm edit' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/credentials/mcp-credential') && init?.method === 'PATCH')).toBe(true));
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/credentials/api-credential') && init?.method === 'PATCH')).toBe(false);
  });
  it('discards dirty edits on selection change and locks the choice during step-up', async () => {
    arm([multiLive()], { '/principals/me': ownerMe });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Advanced' }));
    const selector = screen.getByRole('combobox', { name: 'Credential to edit' });
    await user.selectOptions(selector, 'mcp-credential');
    await user.click(screen.getByRole('checkbox', { name: 'tasks:write' }));
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeEnabled();
    await user.selectOptions(selector, 'api-credential');
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'tasks:write' })).not.toBeChecked();
    await user.selectOptions(selector, 'mcp-credential');
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'tasks:write' }));
    await user.click(screen.getByRole('button', { name: 'Save permissions' }));
    // The lock reaches the page through the editor's effect (onLockedChange),
    // a render after the click's own: wait for that state, never for time.
    await waitFor(() => {
      expect(selector).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Setup' })).toBeDisabled();
    });
    expect(screen.getByRole('dialog', { name: 'Confirm edit' })).toHaveTextContent('credential.edit:mcp-credential');
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }));
    await waitFor(() => expect(selector).toBeEnabled());
    await user.selectOptions(selector, 'api-credential');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
  it('keeps the selected UUID fixed while a save is pending', async () => {
    let complete!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { complete = resolve; });
    arm([multiLive(['tasks:read', 'tasks:write'])], {
      '/principals/me': ownerMe,
      '/credentials/mcp-credential': pending,
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Advanced' }));
    const selector = screen.getByRole('combobox', { name: 'Credential to edit' });
    await user.selectOptions(selector, 'mcp-credential');
    await user.click(screen.getByRole('checkbox', { name: 'tasks:write' }));
    await user.click(screen.getByRole('button', { name: 'Save permissions' }));
    // The pending lock reaches the page through the editor's effect: wait for
    // the locked state itself. The save cannot finish before `complete` below,
    // so the lock this waits for is the pending one.
    await waitFor(() => {
      expect(selector).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Advanced' })).toBeDisabled();
    });
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith('/credentials/mcp-credential') && init?.method === 'PATCH')).toBe(true);
    await act(async () => { complete({ ok: true, status: 200, json: async () => ({ success: true }) } as Response); });
    await waitFor(() => expect(selector).toBeEnabled());
    expect(selector).toHaveValue('mcp-credential');
  });
  it('does not retarget the editor when its selected credential is revoked or removed on refresh', async () => {
    const initial = multiLive();
    let current = [initial];
    arm(current, { '/principals/me': ownerMe,
      '/principals/me/connectors': { ok: true, status: 200, json: async () => ({ success: true,
        connectors: current, instructions: INSTRUCTIONS, mayLoosenCredentialTransport: false }) },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Advanced' }));
    const selector = screen.getByRole('combobox', { name: 'Credential to edit' });
    await user.selectOptions(selector, 'mcp-credential');
    current = [{ ...initial, credentials: [initial.credentials[0],
      { ...initial.credentials[1], state: 'revoked', revokedAt: new Date().toISOString() }] }];
    await user.click(screen.getByRole('button', { name: 'Appoint as Main' }));
    await waitFor(() => expect(screen.getByText(/state revoked/)).toBeInTheDocument());
    expect(selector).toHaveValue('mcp-credential');
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled();
    current = [{ ...initial, credentials: [initial.credentials[0]] }];
    await user.click(screen.getByRole('button', { name: 'Appoint as Main' }));
    await waitFor(() => expect(screen.getByText(/previously selected credential is no longer available/)).toBeInTheDocument());
    expect(selector).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Save permissions' })).not.toBeInTheDocument();
    await user.selectOptions(selector, 'api-credential');
    expect(screen.getByText('api-public')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).includes('/credentials/') && init?.method === 'PATCH')).toBe(false);
  });
  it('does not offer an ordinary owner looser transport choices for an MCP-pinned credential', async () => {
    arm([CONNECTION]); renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    const transport = screen.getByRole('combobox', { name: 'Credential transport' });
    expect(within(transport).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['mcp']);
    expect(screen.queryByRole('dialog', { name: /Confirm edit/ })).not.toBeInTheDocument();
  });
  it('offers looser transport choices only when the connector response verifies standing', async () => {
    arm([CONNECTION], { '/principals/me/connectors': {
      ok: true, status: 200, json: async () => ({ success: true, connectors: [CONNECTION], instructions: INSTRUCTIONS,
        mayLoosenCredentialTransport: true }),
    } });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    const transport = screen.getByRole('combobox', { name: 'Credential transport' });
    expect(within(transport).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['any', 'mcp', 'api']);
  });
  it('opens the permissions editor directly from Setup', async () => {
    arm([CONNECTION]); renderPage(); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Setup' }));
    await user.click(screen.getByRole('button', { name: 'Edit permissions' }));
    expect(screen.getByText('Scopes on this credential')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled();
    expect(screen.queryByRole('combobox', { name: 'Credential to edit' })).not.toBeInTheDocument();
  });
  it('revokes only the chosen live agent’s live and grace credentials', async () => {
    const agent = { ...CONNECTION.agents[0], credentials: [
      { ...CONNECTION.credentials[0], id: 'agent-live' },
      { ...CONNECTION.credentials[0], id: 'agent-grace', state: 'graced' as const },
    ] };
    arm([{ ...CONNECTION, agents: [agent] }]); renderPage(); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Advanced' }));
    await user.click(screen.getByRole('button', { name: 'Revoke agent credentials' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url)).toEqual([
      '/api/credentials/agent-live/revoke', '/api/credentials/agent-grace/revoke',
    ]);
  });
});
