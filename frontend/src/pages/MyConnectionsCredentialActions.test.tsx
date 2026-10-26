/*
 * My connections -> Advanced: the two credential actions say what they touch
 * (owner finding E476, 24 Oct).
 *
 * The page's danger button used to read "Disable" and, with one press, revoked
 * ONLY the credential picked in "Credential to edit" - while reading like a
 * switch for the whole connector. The picker also started on a guess (the
 * first live credential), so a connection with several credentials could lose
 * the wrong one. What is pinned here:
 *
 *  - the button says what it does ("Revoke this credential") and the word
 *    "disable" never describes a single credential;
 *  - a connection with several credentials starts on NO pick, and Revoke and
 *    Regenerate stay disabled until one is chosen; a lone credential stays
 *    preselected;
 *  - revoking needs a second, explicit press in an in-page confirmation that
 *    names the credential, backs out on Cancel and Escape, takes focus when it
 *    opens and gives it back;
 *  - the revoke posts ONLY the picked id, and nothing else;
 *  - the replace-the-secret action says, on the button and in its notice, that
 *    it touches only the picked credential, that the old secret keeps working
 *    for its grace hours, and that it is not a revoke; the notice names the NEW
 *    key id the secret belongs to and the key id it replaces, and the button
 *    waits for a live credential (the board refuses to rotate a retired one);
 *  - the confirmation's own button is as locked as its trigger while the row is
 *    busy, and a pick that vanished on refresh asks for another choice rather
 *    than claiming nothing is available.
 *
 * Every title below is one claim: the mutation harness
 * (scripts/authority-edit-frontend-mutations.py) removes one guard at a time
 * and requires exactly the matching title to go red.
 *
 * Labels, key ids and ids are invented. The 375 px and three-theme pictures
 * are browser captures kept with the release receipts; jsdom has no layout, so
 * axe here covers the structural rules in each theme only.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { MyConnectionsPage } from './MyConnectionsPage';
import { CONNECTION_TEMPLATES, Connection, ConnectionCredential } from '../types/connections';

const fetchMock = vi.fn();
vi.mock('../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('../components/access/StepUpDialog', () => ({
  StepUpDialog: () => null,
}));

const CONNECTOR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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

const credential = (over: Partial<ConnectionCredential>): ConnectionCredential => ({
  id: 'x', keyId: 'rh_dev_x', label: 'x', scopes: ['tasks:read'], transport: 'mcp',
  createdAt: null, expiresAt: null, revokedAt: null, lastUsedAt: null, graceUntil: null,
  revealCount: 0, revealable: true, state: 'live', ...over,
});

const BENCH_MCP = '11111111-aaaa-4aaa-8aaa-000000000001';
const BENCH_API = '22222222-aaaa-4aaa-8aaa-000000000002';
const BENCH_OLD = '33333333-aaaa-4aaa-8aaa-000000000003';
const BENCH_GONE = '44444444-aaaa-4aaa-8aaa-000000000004';

const FOUR: ConnectionCredential[] = [
  credential({ id: BENCH_MCP, keyId: 'rh_dev_lanternAlfa', label: 'Studio bench MCP', transport: 'mcp' }),
  credential({ id: BENCH_API, keyId: 'rh_dev_lanternBravo', label: 'Studio bench API', transport: 'api' }),
  credential({ id: BENCH_OLD, keyId: 'rh_dev_lanternCharlie', label: 'Studio bench earlier', transport: 'mcp',
    state: 'graced', graceUntil: new Date(Date.now() + 3600_000).toISOString() }),
  credential({ id: BENCH_GONE, keyId: 'rh_dev_lanternDelta', label: 'Studio bench retired', transport: 'mcp',
    state: 'revoked', revokedAt: new Date(Date.now() - 3600_000).toISOString() }),
];

const connectionWith = (credentials: ConnectionCredential[]): Connection => ({
  principalId: CONNECTOR_ID,
  handle: 'connector-studio',
  displayName: 'Studio bench',
  status: 'active',
  lastSeenAt: new Date(Date.now() - 3600_000).toISOString(),
  purpose: 'Connector for service studio',
  service: {
    id: 's9', slug: 'studio', name: 'Studio bench',
    description: CONNECTION_TEMPLATES[0].registrationText,
    status: 'draft', runtimeMode: 'direct', createdAt: null,
  },
  credentials,
  agents: [],
});

const MEMBER_SCOPES = ['tasks:read', 'tasks:write'];
const meResponse = (scopes: string[]) => ({
  ok: true, status: 200,
  json: async () => ({ success: true, principal: { id: 'me', handle: 'ada', role: 'user' }, scopes, delegableScopes: scopes }),
});

// What the connectors read returns NOW; a test swaps it to model a refresh.
let served: Connection;
const NEW_KEY_ID = 'rh_dev_lanternReplacement';
const NEW_CREDENTIAL_ID = '55555555-aaaa-4aaa-8aaa-000000000005';

const arm = (connection: Connection, scopes: string[] = MEMBER_SCOPES) => {
  served = connection;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/principals/me')) return meResponse(scopes);
    if (target.endsWith('/principals/me/connectors')) {
      return { ok: true, status: 200, json: async () => ({ success: true, connectors: [served],
        instructions: INSTRUCTIONS, mayLoosenCredentialTransport: false }) };
    }
    if (target.endsWith('/warrants')) return { ok: true, status: 200, json: async () => ({ success: true, warrants: [] }) };
    if (target.endsWith(`/principals/${CONNECTOR_ID}/grants`)) return { ok: true, status: 200, json: async () => ({ success: true, grants: [] }) };
    if (init?.method === 'POST' && target.endsWith('/rotate')) {
      // The real route's answer (201): the NEW credential's id and key id, the
      // key id it replaces, the grace window and the secret.
      const rotated = connection.credentials.find((item) => target.endsWith(`/credentials/${item.id}/rotate`));
      return { ok: true, status: 201, json: async () => ({
        success: true, id: NEW_CREDENTIAL_ID, keyId: NEW_KEY_ID, secretOnce: 'shown-once-secret',
        previousKeyId: rotated?.keyId, graceHours: 24,
        warning: 'This is the only time the full key is shown. Store it now.',
      }) };
    }
    if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ success: true }) };
    throw new Error(`unexpected fetch: ${target}`);
  });
};

const posts = () => fetchMock.mock.calls
  .filter(([, init]: any[]) => init?.method === 'POST')
  .map(([url, init]: any[]) => ({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null }));

const renderPage = () => render(<MemoryRouter><MyConnectionsPage /></MemoryRouter>);

async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Advanced' }));
  return screen.getByRole('button', { name: 'Revoke this credential' });
}
const picker = () => screen.getByRole('combobox', { name: 'Credential to edit' }) as HTMLSelectElement;

beforeEach(() => {
  fetchMock.mockReset();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
});
afterEach(cleanup);

describe('the credential picker and the actions that wait for it', () => {
  it('a connection with several credentials starts on no pick, and Revoke and Regenerate wait for one', async () => {
    arm(connectionWith(FOUR), ['root']);
    const user = userEvent.setup();
    renderPage();
    const revoke = await openAdvanced(user);
    expect(picker()).toHaveValue('');
    expect(within(picker()).getByRole('option', { name: 'Choose a credential…' })).toBeInTheDocument();
    expect(revoke).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Regenerate credential' })).toBeDisabled();
    expect(screen.getByText(/Choose a credential in the picker above first/)).toBeInTheDocument();
    await user.selectOptions(picker(), BENCH_API);
    expect(screen.getByRole('button', { name: 'Revoke this credential' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Regenerate credential' })).toBeEnabled();
    expect(posts()).toEqual([]);
  });

  it('a connection with exactly one credential stays preselected, so its actions are available at once', async () => {
    arm(connectionWith([FOUR[0]]), ['root']);
    const user = userEvent.setup();
    renderPage();
    const revoke = await openAdvanced(user);
    expect(screen.queryByRole('combobox', { name: 'Credential to edit' })).not.toBeInTheDocument();
    expect(revoke).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Regenerate credential' })).toBeEnabled();
  });

  it('an unpicked connection still shows its Setup instructions rather than demanding a pick first', async () => {
    arm(connectionWith(FOUR));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Setup' }));
    expect(picker()).toHaveValue('');
    expect(screen.queryByText(/Choose an available credential to see its setup instructions/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit permissions' })).toBeDisabled();
  });

  it('with no pick the scopes section says to choose one rather than claiming there is no credential', async () => {
    arm(connectionWith(FOUR));
    const user = userEvent.setup();
    renderPage();
    await openAdvanced(user);
    expect(screen.queryByText('No credential is available for this connection.')).not.toBeInTheDocument();
    expect(screen.getByText(/No credential is picked yet/)).toBeInTheDocument();
  });

  it('a revoked credential cannot be revoked again', async () => {
    arm(connectionWith(FOUR));
    const user = userEvent.setup();
    renderPage();
    await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_GONE);
    expect(screen.getByRole('button', { name: 'Revoke this credential' })).toBeDisabled();
  });
});

describe('revoking one credential', () => {
  it('the first press asks and posts nothing; the second explicit press revokes only the picked credential', async () => {
    arm(connectionWith(FOUR));
    const user = userEvent.setup();
    renderPage();
    const revoke = await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_API);
    await user.click(revoke);
    expect(await screen.findByRole('alertdialog', { name: 'Revoke this credential?' })).toBeInTheDocument();
    expect(posts()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, revoke this credential' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toBe(`/api/credentials/${BENCH_API}/revoke`);
    expect(posts()[0].body.reason).toBe('revoked by its owner from My connections');
    for (const other of [BENCH_MCP, BENCH_OLD, BENCH_GONE]) {
      expect(fetchMock.mock.calls.some(([url]: any[]) => String(url).includes(other) && String(url).includes('/revoke'))).toBe(false);
    }
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('the confirmation names the label, key id, transport and full id, and says what stays unchanged', async () => {
    arm(connectionWith(FOUR));
    const user = userEvent.setup();
    renderPage();
    const revoke = await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_API);
    await user.click(revoke);
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke this credential?' });
    expect(within(dialog).getByText('Studio bench API')).toBeInTheDocument();
    expect(within(dialog).getByText('rh_dev_lanternBravo')).toBeInTheDocument();
    expect(within(dialog).getByText('api')).toBeInTheDocument();
    expect(within(dialog).getByText(BENCH_API)).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Calls using this credential will be refused; the other credentials on this connection are unchanged; the connector stays enabled.');
    expect(dialog).toHaveAccessibleDescription(/Calls using this credential will be refused/);
  });

  it('focus moves into the confirmation when it opens', async () => {
    arm(connectionWith(FOUR));
    const user = userEvent.setup();
    renderPage();
    const revoke = await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_MCP);
    await user.click(revoke);
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('Cancel backs out without posting and returns focus to the Revoke button', async () => {
    arm(connectionWith(FOUR));
    const user = userEvent.setup();
    renderPage();
    const revoke = await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_MCP);
    await user.click(revoke);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Revoke this credential' }));
    expect(posts()).toEqual([]);
  });

  it('Escape backs out without posting and returns focus to the Revoke button', async () => {
    arm(connectionWith(FOUR));
    const user = userEvent.setup();
    renderPage();
    const revoke = await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_MCP);
    await user.click(revoke);
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Revoke this credential' }));
    expect(posts()).toEqual([]);
  });

  it('changing the picked credential while the confirmation is open closes it and posts nothing', async () => {
    arm(connectionWith(FOUR));
    const user = userEvent.setup();
    renderPage();
    const revoke = await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_MCP);
    await user.click(revoke);
    await screen.findByRole('alertdialog');
    await user.selectOptions(picker(), BENCH_API);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // Going back to the first credential does not re-arm the old question: a
    // confirmation belongs to one press, not to a credential.
    await user.selectOptions(picker(), BENCH_MCP);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(posts()).toEqual([]);
  });

  it('the notice after a confirmed revoke names the credential and says the connector stays enabled', async () => {
    arm(connectionWith(FOUR));
    const user = userEvent.setup();
    renderPage();
    const revoke = await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_MCP);
    await user.click(revoke);
    await user.click(await screen.findByRole('button', { name: 'Yes, revoke this credential' }));
    const notice = await screen.findByText(/is revoked/);
    expect(notice).toHaveTextContent('rh_dev_lanternAlfa');
    expect(notice).toHaveTextContent('Studio bench MCP');
    expect(notice).toHaveTextContent('Calls using that credential are refused; other credentials on the connection are unchanged; the connector stays enabled.');
  });

  it('a refused revoke says it was a revoke that failed', async () => {
    arm(connectionWith(FOUR));
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (init?.method === 'POST' ? { ok: false, status: 403, json: async () => ({}) } : base(url, init)));
    const user = userEvent.setup();
    renderPage();
    const revoke = await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_MCP);
    await user.click(revoke);
    await user.click(await screen.findByRole('button', { name: 'Yes, revoke this credential' }));
    expect(await screen.findByText('The board refused to revoke that credential.')).toBeInTheDocument();
  });

  it("while the row is busy, the confirmation's own button is as locked as the Revoke button was", async () => {
    arm(connectionWith(FOUR));
    const base = fetchMock.getMockImplementation()!;
    // Appointing a Main keeps the row busy until the board answers; hold it.
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      (String(url).endsWith('/owner-control') ? new Promise(() => undefined) : base(url, init)));
    const user = userEvent.setup();
    renderPage();
    const revoke = await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_MCP);
    await user.click(revoke);
    const yes = await screen.findByRole('button', { name: 'Yes, revoke this credential' });
    expect(yes).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Appoint as Main' }));
    await waitFor(() => expect(yes).toBeDisabled());
    await user.click(yes);
    expect(posts().filter(({ url }) => url.includes('/revoke'))).toEqual([]);
  });

  it('a pick that vanished on refresh asks for another choice, keeps both actions off and never retargets', async () => {
    arm(connectionWith(FOUR), ['root']);
    const user = userEvent.setup();
    renderPage();
    await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_API);
    // A refresh (here: the one after appointing a Main) no longer lists the
    // picked credential.
    served = connectionWith(FOUR.filter((item) => item.id !== BENCH_API));
    await user.click(screen.getByRole('button', { name: 'Appoint as Main' }));
    await waitFor(() => expect(screen.getByText(/The credential you picked is gone from this connection/)).toBeInTheDocument());
    expect(screen.getByText(/Choose another credential in the picker above to see its scopes/)).toBeInTheDocument();
    expect(screen.queryByText('No credential is available for this connection.')).not.toBeInTheDocument();
    expect(screen.getByText(/The previously selected credential is no longer available/)).toBeInTheDocument();
    expect(picker()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Revoke this credential' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Regenerate credential' })).toBeDisabled();
    expect(posts().filter(({ url }) => /\/(revoke|rotate)$/.test(url))).toEqual([]);
  });

  it('the word disable never describes a single credential on the Advanced tab', async () => {
    arm(connectionWith(FOUR));
    const user = userEvent.setup();
    const { container } = renderPage();
    const revoke = await openAdvanced(user);
    expect(screen.queryByRole('button', { name: /disable/i })).not.toBeInTheDocument();
    await user.selectOptions(picker(), BENCH_MCP);
    await user.click(revoke);
    await screen.findByRole('alertdialog');
    const advanced = container.querySelector('.conn-advanced') as HTMLElement;
    expect(advanced.textContent).not.toMatch(/disabl/i);
  });
});

describe('replacing a credential secret', () => {
  it('Regenerate says on its description that it touches only the picked credential, is not a revoke and keeps the old secret for its grace hours', async () => {
    arm(connectionWith(FOUR), ['root']);
    const user = userEvent.setup();
    renderPage();
    await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_MCP);
    const button = screen.getByRole('button', { name: 'Regenerate credential' });
    expect(button).toHaveAccessibleDescription(/picked credential only/);
    expect(button).toHaveAccessibleDescription(/old secret keeps working for 24 hours/);
    expect(button).toHaveAccessibleDescription(/not a revoke/);
  });

  it('Revoke says on its description that the connection and its other credentials are left as they are', async () => {
    arm(connectionWith(FOUR));
    const user = userEvent.setup();
    renderPage();
    const revoke = await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_MCP);
    expect(revoke).toHaveAccessibleDescription(/other credentials, and the connector itself, as they are/);
  });

  it('regenerating posts only the picked credential with the grace window, and the notice repeats what it did', async () => {
    arm(connectionWith(FOUR), ['root']);
    const user = userEvent.setup();
    renderPage();
    await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_API);
    await user.click(screen.getByRole('button', { name: 'Regenerate credential' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toBe(`/api/credentials/${BENCH_API}/rotate`);
    expect(posts()[0].body).toEqual({ graceHours: 24 });
    const notice = await screen.findByText(/shown once, copy it now/);
    expect(notice).toHaveTextContent('Only that credential was replaced');
    expect(notice).toHaveTextContent('which keeps working for 24 hours');
    expect(notice).toHaveTextContent('This is not a revoke');
  });

  it('the notice names the NEW key id the secret belongs to and the key id it replaces, not the old one as the new', async () => {
    arm(connectionWith(FOUR), ['root']);
    const user = userEvent.setup();
    renderPage();
    await openAdvanced(user);
    await user.selectOptions(picker(), BENCH_API);
    await user.click(screen.getByRole('button', { name: 'Regenerate credential' }));
    const notice = await screen.findByText(/shown once, copy it now/);
    expect(notice).toHaveTextContent(`Replacement secret for new key id ${NEW_KEY_ID}`);
    expect(notice).toHaveTextContent('shown-once-secret');
    expect(notice).toHaveTextContent('It replaces rh_dev_lanternBravo (Studio bench API), which keeps working for 24 hours');
    expect(notice).not.toHaveTextContent('Replacement secret for new key id rh_dev_lanternBravo');
  });

  it('Regenerate waits for a live credential: a replaced, still-working or revoked one cannot be regenerated again', async () => {
    arm(connectionWith(FOUR), ['root']);
    const user = userEvent.setup();
    renderPage();
    await openAdvanced(user);
    const button = () => screen.getByRole('button', { name: 'Regenerate credential' });
    await user.selectOptions(picker(), BENCH_OLD);
    expect(button()).toBeDisabled();
    expect(button()).toHaveAccessibleDescription(/Only a live credential can be regenerated; the picked one is graced/);
    await user.selectOptions(picker(), BENCH_GONE);
    expect(button()).toBeDisabled();
    expect(screen.getByText(/the picked one is revoked/)).toBeInTheDocument();
    await user.selectOptions(picker(), BENCH_MCP);
    expect(button()).toBeEnabled();
    expect(screen.queryByText(/Only a live credential can be regenerated/)).not.toBeInTheDocument();
    expect(posts()).toEqual([]);
  });

  it('a member session sees Regenerate refused with the reason, and the replacement route advises a revoke of this credential', async () => {
    arm(connectionWith([FOUR[0]]));
    const user = userEvent.setup();
    renderPage();
    await openAdvanced(user);
    expect(screen.getByRole('button', { name: 'Regenerate credential' })).toBeDisabled();
    expect(screen.getByText(/connecting a new agent and revoking this credential/)).toBeInTheDocument();
  });
});

describe('structure in every theme', () => {
  it.each(['relay-dark', 'relay-light', 'high-contrast'])('axe finds no structural violation with four credentials and the confirmation open (%s)', async (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      arm(connectionWith(FOUR));
      const user = userEvent.setup();
      const { container } = renderPage();
      const revoke = await openAdvanced(user);
      await user.selectOptions(picker(), BENCH_API);
      const run = async () => (await axe.run(container, {
        rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'],
      })).violations.map(({ id }) => id);
      expect(await run()).toEqual([]);
      await user.click(revoke);
      await screen.findByRole('alertdialog');
      expect(await run()).toEqual([]);
    } finally {
      document.documentElement.removeAttribute('data-theme');
    }
  });
});
