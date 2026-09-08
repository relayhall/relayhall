/*
 * THE ONE CREATE-IDENTITY FLOW (card `5592baf6`, defect `43fcd071`).
 *
 * What is pinned here is the SHAPE OF THE CALLS, not the pixels: which route
 * each kind reaches, that a Service is refused in the form when it declares no
 * purpose — the defect — that a Service's credential is a CONNECTOR registered
 * under the Account the same act just created, and that the Agent arm is the
 * existing connection wizard rather than a second implementation of it.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';

/** The wizard links onward with router links, so every render needs a router. */
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: MemoryRouter });
import { CreateIdentityWizard } from './CreateIdentityWizard';
import { CREDENTIAL_TOKEN_PATTERN } from '../../types/connections';
import { PURPOSE_REQUIRED_MESSAGE } from '../../types/identities';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const SESSION_SCOPES = ['tasks:read', 'tasks:write', 'reports:read'];
const REAL_TOKEN = 'rh_dev_ab12cd34ef56.SECRETVALUE0000000000';

const ok = (payload: unknown, status = 200) => ({ ok: true, status, json: async () => payload });
const refused = (status: number, payload: unknown) => ({ ok: false, status, json: async () => payload });

const PACK = {
  boardEndpoint: 'https://board.example/api',
  bootstrapLine: 'You have a RelayHall board at https://board.example/api.',
  mcpConfig: {
    claudeCode: { mcpServers: {} },
    codex: '[mcp_servers.relayhall]',
    generic: { transport: 'streamable-http', url: 'https://board.example/api/mcp' },
  },
  cliEnv: [`export RELAYHALL_TOKEN=${REAL_TOKEN}`],
  credential: { credentialId: 'c1', keyId: 'rh_dev_key', secretOnce: REAL_TOKEN, expiresAt: null, transport: 'api' },
  authoritySummary: { scopes: SESSION_SCOPES, rules: [] },
  previewPath: '/principals/me/effective-access',
  credentialPlaceholder: '',
};

/** Every call the wizard made to one route, newest last. */
function callsTo(suffix: string): Array<{ url: string; init: RequestInit }> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).endsWith(suffix))
    .map((call) => ({ url: String(call[0]), init: (call[1] || {}) as RequestInit }));
}

function bodyOf(call: { init: RequestInit }): any {
  return JSON.parse(String(call.init.body));
}

/**
 * Every mutating call the wizard made, in ORDER, as one log.
 *
 * `callsTo` projects per route, and a projection discards exactly the fact the
 * Service flow claims: that the Account is created FIRST and the connection is
 * registered under the id that act returned. A regression that reversed the two
 * would satisfy every per-route assertion in this file (round-2 finding 2).
 */
function mutationOrder(): string[] {
  return fetchMock.mock.calls
    .filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')
    .map((call) => String(call[0]).replace(/^.*(\/[a-z]+)$/, '$1'));
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/principals/me')) {
      return ok({
        success: true,
        principal: { id: 'me', handle: 'ada', kind: 'human', role: 'user' },
        scopes: SESSION_SCOPES,
        delegableScopes: SESSION_SCOPES,
      });
    }
    if (target.endsWith('/principals') && init?.method === 'POST') {
      return ok({ success: true, principal: { id: 'acct-1' } }, 201);
    }
    if (target.endsWith('/services') && init?.method === 'POST') {
      return ok({ success: true, service: { id: 's1' }, onboarding: PACK }, 201);
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});

afterEach(cleanup);

/** Step 1 → step 2, choosing a kind by its label. */
async function chooseKind(label: string) {
  await userEvent.click(screen.getByRole('radio', { name: new RegExp(label) }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
}

async function fillIdentity(handle: string, purpose?: string) {
  await userEvent.type(screen.getByLabelText('Handle'), handle);
  if (purpose !== undefined) await userEvent.type(screen.getByLabelText('Purpose'), purpose);
}

describe('step 1 — one flow, three kinds, one sentence each', () => {
  it('offers Human, Service and Agent, each with when-to-use text', async () => {
    render(<CreateIdentityWizard />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((node) => (node.textContent || '').trim())).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /Human/ })).toHaveTextContent(/signs in/);
    expect(screen.getByRole('radio', { name: /Service/ })).toHaveTextContent(/acts on its own/);
    expect(screen.getByRole('radio', { name: /Agent/ })).toHaveTextContent(/My connections/);
  });
});

describe('Human — an Account that signs in and holds no key', () => {
  it('creates the Account and never asks a credential route for one', async () => {
    render(<CreateIdentityWizard />);
    await chooseKind('Human');
    await fillIdentity('colleague');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Step 3 says the substrate rule rather than offering a key it cannot mint.
    expect(screen.getByText(/never hold a key of their own/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create identity' }));

    await waitFor(() => expect(callsTo('/principals')).toHaveLength(1));
    expect(bodyOf(callsTo('/principals')[0])).toMatchObject({ kind: 'human', handle: 'colleague', role: 'user' });
    expect(bodyOf(callsTo('/principals')[0]).purpose).toBeUndefined();
    expect(callsTo('/services')).toHaveLength(0);
    expect(await screen.findByText(/colleague is ready/)).toBeInTheDocument();
  });
});

describe('Service — the purpose defect, and what a service credential actually is', () => {
  it('DEFECT 43fcd071: a Service with no purpose cannot leave step 2, and nothing is sent', async () => {
    render(<CreateIdentityWizard />);
    await chooseKind('Service');
    await userEvent.type(screen.getByLabelText('Handle'), 'ci-bot');

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    // The refusal is the board's own sentence, so a person reads one wording.
    expect(screen.getAllByText(PURPOSE_REQUIRED_MESSAGE).length).toBeGreaterThan(0);
    expect(callsTo('/principals')).toHaveLength(0);

    await userEvent.type(screen.getByLabelText('Purpose'), 'Runs the nightly build.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  });

  it('creates the Account, then a Connector UNDER it, and shows the credential once', async () => {
    render(<CreateIdentityWizard />);
    await chooseKind('Service');
    await fillIdentity('ci-bot', 'Runs the nightly build.');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    // The default is the whole delegable catalogue (ruling 2026-09-07) and the
    // default transport is REST/CLI.
    expect(screen.getByLabelText('Mint a credential now')).toBeChecked();
    expect(screen.getByRole('radio', { name: /REST or CLI/ })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Create identity' }));

    await waitFor(() => expect(callsTo('/services')).toHaveLength(1));
    expect(bodyOf(callsTo('/principals')[0])).toMatchObject({
      kind: 'service', handle: 'ci-bot', purpose: 'Runs the nightly build.',
    });
    // A service ACCOUNT is keyless: its credential belongs to a Connector
    // registered under the Account this same act created.
    expect(bodyOf(callsTo('/services')[0])).toMatchObject({
      kind: 'connector',
      slug: 'ci-bot',
      ownerAccountId: 'acct-1',
      issueCredential: { scopes: SESSION_SCOPES, transport: 'api' },
    });

    // THE ORDER, not only the bodies: create, then connect under what it
    // returned. `ownerAccountId` above is the id the FIRST response carried.
    expect(mutationOrder()).toEqual(['/principals', '/services']);

    // Step 4 — the credential, in the same harness tabs, with the warning.
    expect(await screen.findByText(new RegExp(REAL_TOKEN))).toBeInTheDocument();
    expect(screen.getByText(/shown once and is never stored on the board/)).toBeInTheDocument();
    // FIXTURE VALIDATION, and nothing more (round-2 finding 2). This says the
    // token this file renders through the pane has the grammar the board
    // actually mints -- so the assertion above is not satisfied by a string
    // no credential could ever be. It proves nothing about production
    // issuance; that is measured in the backend arm, which reads the
    // secretOnce the server emitted.
    expect(CREDENTIAL_TOKEN_PATTERN.test(REAL_TOKEN)).toBe(true);
  });

  it('an MCP service pins the credential to mcp', async () => {
    render(<CreateIdentityWizard />);
    await chooseKind('Service');
    await fillIdentity('mcp-bot', 'Answers MCP calls.');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('radio', { name: /MCP client/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create identity' }));

    await waitFor(() => expect(callsTo('/services')).toHaveLength(1));
    expect(bodyOf(callsTo('/services')[0]).issueCredential.transport).toBe('mcp');
  });

  it('unchecking the credential creates the Account alone', async () => {
    render(<CreateIdentityWizard />);
    await chooseKind('Service');
    await fillIdentity('quiet-bot', 'Holds attribution only.');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByLabelText('Mint a credential now'));
    await userEvent.click(screen.getByRole('button', { name: 'Create identity' }));

    await waitFor(() => expect(callsTo('/principals')).toHaveLength(1));
    expect(callsTo('/services')).toHaveLength(0);
  });

  it('a refused connection says the Account survived, and a retry makes no second one', async () => {
    render(<CreateIdentityWizard />);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/principals/me')) {
        return ok({ success: true, principal: { id: 'me' }, scopes: SESSION_SCOPES, delegableScopes: SESSION_SCOPES });
      }
      if (target.endsWith('/principals') && init?.method === 'POST') {
        return ok({ success: true, principal: { id: 'acct-1' } }, 201);
      }
      if (target.endsWith('/services') && init?.method === 'POST') {
        return refused(409, { code: 'SERVICE_SLUG_TAKEN' });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    await chooseKind('Service');
    await fillIdentity('taken-bot', 'Collides on the slug.');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create identity' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('taken-bot was created, but its connection was not');
    expect(alert).toHaveTextContent('already taken');

    await userEvent.click(screen.getByRole('button', { name: 'Create identity' }));
    await waitFor(() => expect(callsTo('/services')).toHaveLength(2));
    // The Account was made once, and the retry knew it.
    expect(callsTo('/principals')).toHaveLength(1);
  });
});

describe('Agent — the connection wizard, embedded, not reimplemented', () => {
  it('hands the whole step over to Connect your agent', async () => {
    render(<CreateIdentityWizard />);
    await userEvent.click(screen.getByRole('radio', { name: /Agent/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: /Connect your agent/ })).toBeInTheDocument();
    expect(screen.getByText(/belongs to somebody else/)).toBeInTheDocument();
  });

  it('reaches the connection route and shows the credential once', async () => {
    render(<CreateIdentityWizard />);
    await userEvent.click(screen.getByRole('radio', { name: /Agent/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('radio', { name: /API script/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Laptop');
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(callsTo('/services')).toHaveLength(1));
    expect(bodyOf(callsTo('/services')[0])).toMatchObject({ kind: 'connector', slug: 'laptop' });
    // No Account is created for an agent: `POST /principals` refuses kind=agent
    // outright (422 AGENT_MINT_ONLY), which is why this arm exists at all.
    expect(callsTo('/principals')).toHaveLength(0);
    expect(await screen.findByText(new RegExp(REAL_TOKEN))).toBeInTheDocument();
  });
});

describe('My connections — the same component, preset', () => {
  it('opens straight into Connect your agent and never offers the kind question', async () => {
    render(<CreateIdentityWizard initialKind="agent" lockKind />);
    expect(await screen.findByRole('heading', { name: /Connect your agent/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Human/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/belongs to somebody else/)).not.toBeInTheDocument();
  });
});
