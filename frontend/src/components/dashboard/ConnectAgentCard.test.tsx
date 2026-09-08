/*
 * The first-login "Connect your agent" card (card 653be44f; owner design
 * record 99d6b0ad §3.1).
 *
 * The card exists for exactly ONE state — a person with no Connector — and the
 * tests that matter are the ones about when it does NOT appear. A failed read
 * and an unmigrated substrate must both stay silent: inviting someone to make
 * their first connection when they may already have several is worse than
 * showing nothing, and an empty array is the only evidence that earns the card.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ConnectAgentCard } from './ConnectAgentCard';
import { lostCredentialRecovery } from '../../types/connections';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const armConnectors = (response: { ok: boolean; status: number; body?: unknown }) => {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/principals/me/connectors')) {
      return { ok: response.ok, status: response.status, json: async () => response.body ?? {} };
    }
    if (String(url).endsWith('/principals/me')) {
      return { ok: true, status: 200, json: async () => ({ success: true, principal: { id: 'me' }, scopes: ['tasks:read'] }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
};

const renderCard = () => render(<MemoryRouter><ConnectAgentCard /></MemoryRouter>);

beforeEach(() => {
  fetchMock.mockReset();
  window.localStorage.clear();
});
afterEach(cleanup);

describe('ConnectAgentCard', () => {
  it('appears for a person with no connection at all', async () => {
    armConnectors({ ok: true, status: 200, body: { success: true, connectors: [], instructions: null } });
    renderCard();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Connect your agent/ })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'See My connections' })).toHaveAttribute('href', '/settings/connections');
  });

  it('stays away when the person already has one', async () => {
    armConnectors({ ok: true, status: 200, body: { success: true, connectors: [{ principalId: 'c1' }], instructions: null } });
    renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: /Connect your agent/ })).not.toBeInTheDocument();
  });

  it('stays away when the read FAILED — a broken lookup is not an empty chain', async () => {
    armConnectors({ ok: false, status: 500 });
    renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: /Connect your agent/ })).not.toBeInTheDocument();
  });

  it('stays away while the identity substrate is unmigrated', async () => {
    armConnectors({ ok: false, status: 503 });
    renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: /Connect your agent/ })).not.toBeInTheDocument();
  });

  it('dismisses, remembers it in the browser only, and stays re-openable from My connections', async () => {
    armConnectors({ ok: true, status: 200, body: { success: true, connectors: [], instructions: null } });
    renderCard();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Connect your agent/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss the connect your agent card' }));
    expect(screen.queryByRole('heading', { name: /Connect your agent/ })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('relayhall.connect-agent-card.dismissed')).toBe('true');
    // Dismissal is a view preference: it never reaches the board.
    expect(fetchMock.mock.calls.every(([, init]: any[]) => !init || !init.method || init.method === 'GET')).toBe(true);
  });

  it('REGRESSION: creating a connection does not unmount the wizard holding the one-time pack', async () => {
    // Found by the live walkthrough, not by this suite: the card's own
    // visibility rule (no connection yet) goes FALSE the instant the wizard
    // succeeds, and an unguarded rule then unmounted the wizard while it was
    // displaying the credential — which is rendered once and never stored
    // server-side, so it would have been destroyed in front of the person.
    let connectors: unknown[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/principals/me/connectors')) {
        return { ok: true, status: 200, json: async () => ({ success: true, connectors, instructions: null }) };
      }
      if (target.endsWith('/principals/me')) {
        return { ok: true, status: 200, json: async () => ({ success: true, principal: { id: 'me' }, scopes: ['tasks:read'] }) };
      }
      if (target.endsWith('/services') && init?.method === 'POST') {
        // The board now holds a connection: every later read says so.
        connectors = [{ principalId: 'c1' }];
        return {
          ok: true,
          status: 201,
          json: async () => ({
            success: true,
            service: { id: 's1' },
            onboarding: {
              boardEndpoint: 'https://board.example/api',
              bootstrapLine: 'You have a RelayHall board at https://board.example/api.',
              mcpConfig: { claudeCode: { mcpServers: { relayhall: { type: 'http', url: 'https://board.example/api/mcp', headers: { Authorization: 'Bearer rh_dev_ab12cd34ef56.SECRETVALUE0000000000' } } } }, codex: '[mcp_servers.relayhall]', generic: {} },
              cliEnv: ['export RELAYHALL_TOKEN=rh_dev_ab12cd34ef56.SECRETVALUE0000000000'],
              credential: { credentialId: 'c', keyId: 'k', secretOnce: 'rh_dev_ab12cd34ef56.SECRETVALUE0000000000', expiresAt: null, transport: 'mcp' },
              authoritySummary: { scopes: [], rules: [] },
              previewPath: '/principals/me/effective-access',
            },
          }),
        };
      }
      throw new Error(`unexpected fetch: ${target}`);
    });

    renderCard();
    await waitFor(() => expect(screen.getByRole('button', { name: /Connect your agent/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Connect your agent/ }));
    await waitFor(() => expect(screen.getByText('What is it for?')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'Laptop');
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));

    // The pack is on screen and STAYS there, with its credential.
    await waitFor(() => {
      expect(screen.getByText('Paste this into your agent and let it configure itself.')).toBeInTheDocument();
    });
    expect(screen.getByText(/rh_dev_ab12cd34ef56.SECRETVALUE0000000000/)).toBeInTheDocument();
    expect(screen.getByText(/shown once and is never stored on the board/)).toBeInTheDocument();

    // And only when the person is finished does the card fold away, because
    // the rule that was suspended is now true.
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /Connect your agent/ })).not.toBeInTheDocument();
    });
  });

  it('T4-R2: a create request that THROWS after the write may have committed', async () => {
    // Round-2 control gap (card 7f6d7635): neither half of the P3 repair was
    // pinned — restoring the old "Nothing was created" copy left 22 tests
    // green, and separately deleting the catch-branch refresh left the same 22
    // green. No committed test drove a thrown create at all.
    //
    // This drives one, and asserts all three things the repair claims: the copy
    // is ambiguity-safe AND tells this session something it can actually do,
    // the refresh fires, and the card does not fold while the wizard is still
    // holding the failure on screen.
    const MEMBER_SCOPES = ['tasks:read', 'tasks:write'];
    let connectors: unknown[] = [];
    let connectorReads = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/principals/me/connectors')) {
        connectorReads += 1;
        return { ok: true, status: 200, json: async () => ({ success: true, connectors, instructions: null }) };
      }
      if (target.endsWith('/principals/me')) {
        return { ok: true, status: 200, json: async () => ({ success: true, principal: { id: 'me' }, scopes: MEMBER_SCOPES }) };
      }
      if (target.endsWith('/services') && init?.method === 'POST') {
        // The board COMMITTED, then the response was lost.
        connectors = [{ principalId: 'c1' }];
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`unexpected fetch: ${target}`);
    });

    renderCard();
    await waitFor(() => expect(screen.getByRole('button', { name: /Connect your agent/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Connect your agent/ }));
    await waitFor(() => expect(screen.getByText('What is it for?')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'Laptop');

    const readsBefore = connectorReads;
    await userEvent.click(screen.getByRole('button', { name: 'Create connection' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    // 1. Ambiguity-safe: it does not claim a rollback it cannot know happened.
    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).toMatch(/Could not confirm whether the connection was created/);
    expect(alert).not.toMatch(/Nothing was created/);
    // 2. ...and the recovery it names is what THIS session may actually do,
    //    taken from the same predicate My connections uses.
    expect(alert).toContain(lostCredentialRecovery(MEMBER_SCOPES));
    expect(alert).not.toMatch(/regenerate its credential/);
    // 3. The refresh fired, so the list behind the wizard is no longer stale.
    await waitFor(() => expect(connectorReads).toBeGreaterThan(readsBefore));
    // 4. And the card did NOT fold, even though the refreshed chain is now
    //    non-empty — the person is still looking at the failure.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('opens the wizard in place', async () => {
    armConnectors({ ok: true, status: 200, body: { success: true, connectors: [], instructions: null } });
    renderCard();
    await waitFor(() => expect(screen.getByRole('button', { name: /Connect your agent/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Connect your agent/ }));
    await waitFor(() => expect(screen.getByText('What is it for?')).toBeInTheDocument());
  });
});
