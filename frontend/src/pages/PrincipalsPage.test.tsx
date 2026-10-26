// @vitest-environment jsdom
import { render as rtlRender, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { authenticatedFetch } from '../utils/auth';
import { PrincipalsPage } from './PrincipalsPage';

/** The intro and the wizard link onward with router links. */
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: MemoryRouter });

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../components/PrincipalAvatar', () => ({
  PrincipalAvatar: ({ principal }: { principal: { handle: string } }) => <span>{principal.handle}</span>,
}));

const mockFetch = vi.mocked(authenticatedFetch);

const directory = [
  { id: 'sys-1', kind: 'service', handle: 'system', displayName: 'System', status: 'active', role: 'admin', provenance: 'bootstrap' },
  { id: 'own-1', kind: 'human', handle: 'dashboard_user', displayName: 'Owner', status: 'active', role: 'admin', provenance: 'bootstrap' },
  { id: 'agt-1', kind: 'agent', handle: 'build-agent', displayName: 'Build Agent', status: 'active', role: 'agent', provenance: 'managed' },
];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function routeMock({ principals = directory, meId = 'own-1', status = 200 }: { principals?: typeof directory; meId?: string | null; status?: number } = {}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/principals/me')) {
      const me = principals.find(p => p.id === meId);
      return me ? jsonResponse({ success: true, principal: me }) : jsonResponse({ success: false }, false, 404);
    }
    if (String(url).endsWith('/principals')) {
      if (status === 503) return jsonResponse({ success: false }, false, 503);
      if (status !== 200) return jsonResponse({ success: false }, false, status);
      return jsonResponse({ success: true, principals });
    }
    return jsonResponse({ success: false }, false, 404);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(cleanup);

describe('PrincipalsPage', () => {
  test('renders the directory grouped by kind', async () => {
    routeMock();
    render(<PrincipalsPage />);
    expect(await screen.findByText('build-agent')).toBeInTheDocument();
    expect(screen.getByText('system')).toBeInTheDocument();
  });

  test('protected principals show a disabled toggle with an explanation', async () => {
    routeMock();
    render(<PrincipalsPage />);
    await screen.findByText('build-agent');
    const buttons = screen.getAllByRole('button', { name: 'Disable' });
    const protectedButton = buttons.find(b => b.hasAttribute('title') && b.title.includes('system principal'));
    expect(protectedButton).toBeTruthy();
    expect(protectedButton).toBeDisabled();
    // The owner's own row (me) has no toggle at all.
    const ownerRow = screen.getByText('dashboard_user').closest('[role="row"]');
    expect(ownerRow?.querySelector('button')).toBeNull();
  });

  test('a regular principal keeps a live toggle that busies while in flight', async () => {
    routeMock();
    render(<PrincipalsPage />);
    await screen.findByText('build-agent');
    const agentRow = screen.getByText('build-agent').closest('[role="row"]') as HTMLElement;
    const toggle = agentRow.querySelector('button.principals-toggle') as HTMLButtonElement;
    expect(toggle).not.toBeDisabled();

    let resolvePatch: (value: Response) => void = () => {};
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return new Promise<Response>(resolve => { resolvePatch = resolve; });
      return base(url);
    });
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeDisabled());
    resolvePatch(jsonResponse({ success: true }));
    await waitFor(() => expect(toggle).not.toBeDisabled());
  });

  test('filters that match nothing render a no-match state with a clear action', async () => {
    routeMock();
    render(<PrincipalsPage />);
    await screen.findByText('build-agent');
    await userEvent.type(screen.getByLabelText('Search principals'), 'zzz-nobody');
    expect(screen.getByText(/No principals match the current filters/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('build-agent')).toBeInTheDocument();
  });

  /*
   * The four-field "New principal" form is gone (card `5592baf6`). It could
   * not complete two of the three kinds it offered — Service answered 422
   * PURPOSE_REQUIRED because it never asked for a purpose (defect
   * `43fcd071`), and Agent, its own default, answered 422 AGENT_MINT_ONLY —
   * so what this page owes is the one flow, opened. The flow itself is
   * measured in `components/identity/CreateIdentityWizard.test.tsx`.
   */
  test('Create identity opens the one wizard, with all three kinds', async () => {
    routeMock();
    render(<PrincipalsPage />);
    await screen.findByText('build-agent');
    expect(screen.queryByRole('button', { name: /New principal/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Create identity/ }));
    expect(await screen.findByRole('heading', { name: /Create identity/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Human/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Service/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Agent/ })).toBeInTheDocument();
  });

  test('503 renders the benign not-migrated state, not an error', async () => {
    routeMock({ status: 503 });
    render(<PrincipalsPage />);
    expect(await screen.findByText(/identity substrate is not migrated/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a failed lookup renders an error with retry, never an empty directory', async () => {
    routeMock({ status: 500 });
    render(<PrincipalsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load principals');
    expect(screen.queryByText('No principals found.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  // Card ff410dc4 (SQ-4): the owner's directory listed dozens of terminated
  // archive rows interleaved with live ones. Non-active rows fold per kind,
  // with a count, and stay readable; status and sort are controls.
  const folding = [
    ...directory,
    { id: 'agt-2', kind: 'agent', handle: 'archive-agent-1', displayName: null, status: 'terminated', role: 'agent', provenance: 'managed', lastSeenAt: '2026-10-01T10:00:00.000Z' },
    { id: 'agt-3', kind: 'agent', handle: 'archive-agent-2', displayName: null, status: 'disabled', role: 'agent', provenance: 'managed', lastSeenAt: '2026-10-19T10:00:00.000Z' },
    { id: 'agt-4', kind: 'agent', handle: 'agent-zulu', displayName: null, status: 'active', role: 'agent', provenance: 'managed', lastSeenAt: '2026-10-20T10:00:00.000Z' },
  ] as unknown as typeof directory;

  test('non-active identities fold per kind into one collapsed section with a count (ff410dc4)', async () => {
    routeMock({ principals: folding });
    render(<PrincipalsPage />);
    await screen.findByText('build-agent');
    const live = screen.getAllByRole('table', { name: 'Accounts' });
    expect(live.some(t => t.textContent?.includes('archive-agent-1'))).toBe(false);
    const folded = screen.getByRole('table', { name: 'Non-active agent identities' });
    expect(folded.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Non-active agent identities (2)')).toBeInTheDocument();
    expect(folded).toHaveTextContent('archive-agent-1');
    expect(folded).toHaveTextContent('archive-agent-2');
    expect(folded).not.toHaveTextContent('build-agent');
    // The other kinds have nothing non-active, so nothing folds there.
    expect(screen.queryByText(/Non-active human identities/)).not.toBeInTheDocument();
  });

  test('the Status filter shows only active or only non-active rows, opened (ff410dc4)', async () => {
    routeMock({ principals: folding });
    render(<PrincipalsPage />);
    await screen.findByText('build-agent');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'active');
    expect(screen.queryByText('archive-agent-1')).not.toBeInTheDocument();
    expect(screen.getByText('agent-zulu')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'non-active');
    expect(screen.queryByText('build-agent')).not.toBeInTheDocument();
    const folded = screen.getByRole('table', { name: 'Non-active agent identities' });
    expect(folded.closest('details')).toHaveAttribute('open');
  });

  test('Sort by last seen orders each section newest first; the default is by handle (ff410dc4)', async () => {
    routeMock({ principals: folding });
    render(<PrincipalsPage />);
    await screen.findByText('build-agent');
    const handles = (name: string) => Array.from(screen.getByRole('table', { name }).querySelectorAll('[role="row"]'))
      .slice(1).map(r => r.querySelector('.principals-open')?.textContent);
    expect(handles('Non-active agent identities')).toEqual(['archive-agent-1', 'archive-agent-2']);
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'last-seen');
    expect(handles('Non-active agent identities')).toEqual(['archive-agent-2', 'archive-agent-1']);
  });
});
