// @vitest-environment jsdom
/**
 * RH-P3.C6 — the consent page renders the board's answer and decides nothing.
 *
 * The page's whole contract is that it is a VIEW over a server decision: it
 * shows what the board says was asked for, offers only what the board says is
 * grantable, and posts an approval back. Every assertion below is about that
 * boundary, because a consent page that computed a ceiling, or that assembled
 * its own redirect target, would be a second implementation of an
 * authorization decision — the exact class this programme keeps rejecting.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { OAuthConsentPage } from './OAuthConsentPage';

const mocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../utils/auth', () => ({ authenticatedFetch: mocks.authenticatedFetch }));

const REQUEST = {
  id: '11111111-2222-3333-4444-555555555555',
  clientId: 'https://chat.example.com/.well-known/oauth-client',
  clientName: 'Example Chat',
  clientUri: 'https://chat.example.com',
  redirectUri: 'https://chat.example.com/oauth/callback',
  requestedScopes: ['tasks:read', 'tasks:write', 'principals:admin'],
  grantableScopes: ['tasks:read', 'tasks:write'],
  unavailableScopes: ['principals:admin'],
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

const ok = (body: unknown) => Promise.resolve({
  ok: true, status: 200, json: () => Promise.resolve(body),
} as unknown as Response);
const refused = (status: number, body: unknown) => Promise.resolve({
  ok: false, status, json: () => Promise.resolve(body),
} as unknown as Response);

const assign = vi.fn();

function renderPage(search = `?request_id=${REQUEST.id}`) {
  return render(
    <MemoryRouter initialEntries={[`/oauth/consent${search}`]}>
      <OAuthConsentPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.authenticatedFetch.mockReset();
  assign.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, origin: 'https://board.example.com' },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe('the consent page shows what the board says was asked for', () => {
  test('names the client, its identifying URL and where it will return to', async () => {
    mocks.authenticatedFetch.mockImplementation(() => ok(REQUEST));
    renderPage();
    await screen.findByRole('heading', { name: /Authorize Example Chat/i });
    expect(screen.getByText(REQUEST.clientId)).toBeInTheDocument();
    expect(screen.getByText(REQUEST.redirectUri)).toBeInTheDocument();
  });

  test('offers exactly the grantable scopes, and never the unavailable ones', async () => {
    mocks.authenticatedFetch.mockImplementation(() => ok(REQUEST));
    renderPage();
    const scopes = await screen.findByRole('group', { name: /What it is asking for/i });
    const boxes = within(scopes).getAllByRole('checkbox');
    expect(boxes).toHaveLength(REQUEST.grantableScopes.length);
    for (const scope of REQUEST.grantableScopes) {
      expect(within(scopes).getByText(scope)).toBeInTheDocument();
    }
    // The control: a scope the board withheld is NOT offered as a choice.
    const labels = boxes.map((box) => box.closest('label')?.textContent ?? '');
    expect(labels.some((label) => label.includes('principals:admin'))).toBe(false);
  });

  test('says plainly why a requested permission was withheld', async () => {
    mocks.authenticatedFetch.mockImplementation(() => ok(REQUEST));
    renderPage();
    const note = await screen.findByText(/your own access does not include/i);
    expect(within(note).getByText('principals:admin')).toBeInTheDocument();
  });

  test('shows the scope string beside every plain-language line', async () => {
    // The sentence is a help, never the only truth on screen: a person
    // approving authority must be able to see the exact string.
    mocks.authenticatedFetch.mockImplementation(() => ok(REQUEST));
    renderPage();
    const scopes = await screen.findByRole('group', { name: /What it is asking for/i });
    expect(within(scopes).getByText('Read your tasks')).toBeInTheDocument();
    expect(within(scopes).getByText('tasks:read')).toBeInTheDocument();
    expect(within(scopes).getByText('Create and change tasks')).toBeInTheDocument();
  });
});

describe('client-supplied display values never become an executable link', () => {
  // Review 6fe97bc5 B3: `client_uri` comes from a metadata document an
  // UNAUTHENTICATED caller controls, and this page carries the signed-in
  // session. The board sanitizes it server-side; this is the second layer, and
  // these are the exact schemes the reviewer demonstrated with.
  const UNSAFE = [
    'javascript:alert(document.domain)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'http://chat.example.com',
    'https://user:pass@chat.example.com',
    'not a url at all',
    '',
  ];

  test.each(UNSAFE)('renders %j as text, with no anchor at all', async (clientUri) => {
    mocks.authenticatedFetch.mockImplementation(() => ok({ ...REQUEST, clientUri }));
    renderPage();
    await screen.findByRole('heading', { name: /Authorize Example Chat/i });
    // The client is still named — the page does not hide who is asking — but
    // there is nothing to click, and nothing carrying the unsafe value.
    expect(screen.getAllByText('Example Chat').length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Example Chat' })).not.toBeInTheDocument();
    expect(document.querySelector(`a[href="${clientUri}"]`)).toBeNull();
  });

  test('renders an https client_uri as a link — the control the checks above need', async () => {
    // Without this, every assertion above would pass on a page that rendered
    // no links whatsoever.
    mocks.authenticatedFetch.mockImplementation(() => ok(REQUEST));
    renderPage();
    const link = await screen.findByRole('link', { name: 'Example Chat' });
    expect(link).toHaveAttribute('href', 'https://chat.example.com/');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});

describe('the decision goes to the board, and the board says where to go next', () => {
  test('posts the selected scopes and follows the redirect the board returned', async () => {
    const redirectTo = 'https://chat.example.com/oauth/callback?code=abc&state=xyz';
    mocks.authenticatedFetch
      .mockImplementationOnce(() => ok(REQUEST))
      .mockImplementationOnce(() => ok({ approved: true, redirectTo }));
    renderPage();
    await screen.findByRole('heading', { name: /Authorize Example Chat/i });
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalledTimes(2));
    const [url, init] = mocks.authenticatedFetch.mock.calls[1];
    expect(String(url)).toContain(`/oauth/authorization-requests/${REQUEST.id}/decision`);
    expect(JSON.parse((init as RequestInit).body as string))
      .toEqual({ approve: true, grantedScopes: REQUEST.grantableScopes });
    // The page never assembles a redirect: it goes where the board said.
    await waitFor(() => expect(assign).toHaveBeenCalledWith(redirectTo));
  });

  test('sends only what the person left ticked', async () => {
    mocks.authenticatedFetch
      .mockImplementationOnce(() => ok(REQUEST))
      .mockImplementationOnce(() => ok({ approved: true, redirectTo: 'https://chat.example.com/cb' }));
    renderPage();
    const scopes = await screen.findByRole('group', { name: /What it is asking for/i });
    await userEvent.click(within(scopes).getAllByRole('checkbox')[1]);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalledTimes(2));
    const [, init] = mocks.authenticatedFetch.mock.calls[1];
    expect(JSON.parse((init as RequestInit).body as string).grantedScopes).toEqual(['tasks:read']);
  });

  test('declining sends approve:false and grants nothing', async () => {
    mocks.authenticatedFetch
      .mockImplementationOnce(() => ok(REQUEST))
      .mockImplementationOnce(() => ok({
        approved: false, redirectTo: 'https://chat.example.com/cb?error=access_denied',
      }));
    renderPage();
    await screen.findByRole('heading', { name: /Authorize Example Chat/i });
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalledTimes(2));
    const [, init] = mocks.authenticatedFetch.mock.calls[1];
    expect(JSON.parse((init as RequestInit).body as string))
      .toEqual({ approve: false, grantedScopes: [] });
  });

  test('cannot approve nothing', async () => {
    mocks.authenticatedFetch.mockImplementation(() => ok(REQUEST));
    renderPage();
    const scopes = await screen.findByRole('group', { name: /What it is asking for/i });
    for (const box of within(scopes).getAllByRole('checkbox')) await userEvent.click(box);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  test('cannot approve a request whose scopes are all withheld', async () => {
    mocks.authenticatedFetch.mockImplementation(() => ok({
      ...REQUEST, grantableScopes: [], unavailableScopes: REQUEST.requestedScopes,
    }));
    renderPage();
    await screen.findByText(/None of the requested permissions are yours to give/i);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });
});

describe('a request that cannot be shown authorizes nothing', () => {
  test('reports the board refusal and offers no approve control', async () => {
    mocks.authenticatedFetch.mockImplementation(() => refused(410, {
      error: 'invalid_request', error_description: 'this authorization request has expired',
    }));
    renderPage();
    await screen.findByRole('alert');
    expect(screen.getByText(/this authorization request has expired/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing has been authorized/i)).toBeInTheDocument();
  });

  test('refuses a link that carries no request id, without calling the board', async () => {
    renderPage('');
    await screen.findByRole('alert');
    expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  test('surfaces a decision failure and does NOT navigate', async () => {
    mocks.authenticatedFetch
      .mockImplementationOnce(() => ok(REQUEST))
      .mockImplementationOnce(() => refused(409, {
        error: 'invalid_request',
        error_description: 'this authorization request has already been decided',
      }));
    renderPage();
    await screen.findByRole('heading', { name: /Authorize Example Chat/i });
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText(/already been decided/i);
    expect(assign).not.toHaveBeenCalled();
  });
});
