// @vitest-environment jsdom
// Card ff410dc4 (owner ruling E407 item 1): the Current grants list reads ONE
// server page at a time, opens on hand-made grants only, names each row's
// origin from the server's fields, filters, sorts and searches through query
// parameters, and offers Edit and Revoke as one equal inline pair.
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GrantsPage } from './GrantsPage';

const authenticatedFetch = vi.fn();
const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();

vi.mock('../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args) }));
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

const principal = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', handle: 'tester', displayName: 'Focused Tester', kind: 'human', status: 'active', role: 'viewer' };
const holder = { id: principal.id, handle: 'tester', displayName: 'Focused Tester', kind: 'human', status: 'active', compatibility: false };
const connector = { id: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd', handle: 'pc-connector', displayName: null, kind: 'service', status: 'active', compatibility: false };

function row(n: number, extra: Record<string, unknown> = {}) {
  const id = `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  return {
    id, granteeType: 'principal', granteeId: holder.id, resourceType: 'task', resourceId: '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a', verb: 'read',
    grantedByPrincipalId: holder.id, expiresAt: null, createdAt: '2026-10-20T12:00:00.000Z', origin: 'manual', grantee: holder, grantedBy: holder,
    madeBy: { class: 'hand', via: 'direct', evidence: 'audit' }, target: { label: 'Quarterly review', status: 'todo', state: 'live' }, ...extra,
  };
}

function response(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 403, json: () => Promise.resolve(body) });
}

/** Every GET the page sent, as parsed query parameters. */
function listCalls(): URLSearchParams[] {
  return authenticatedFetch.mock.calls
    .filter(([url, options]) => !options && String(url).startsWith('/api/grants?'))
    .map(([url]) => new URL(String(url), 'http://x').searchParams);
}

let pages: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  useMyPrincipal.mockReturnValue({ me: { role: 'orchestrator' }, scopes: ['root'], loading: false });
  usePrincipals.mockReturnValue({ principals: [principal], loading: false, failed: false, reload: vi.fn() });
  pages = {
    first: { success: true, grants: [row(1), row(2)], pagination: { limit: 50, sort: '-created', returned: 2, total: 3, hasMore: true, nextCursor: 'gc1.second' }, madeCounts: { hand: 3, system: 3911, unknown: 2 } },
    second: { success: true, grants: [row(2), row(3)], pagination: { limit: 50, sort: '-created', returned: 2, total: 3, hasMore: false, nextCursor: null } },
  };
  authenticatedFetch.mockImplementation((url: string, options?: RequestInit) => {
    const stepUp = stepUpAnswer(String(url));
    if (stepUp) return stepUp;
    if (!options) return response(String(url).includes('cursor=') ? pages.second : pages.first);
    if (options.method === 'DELETE') return response({ success: true, grant: row(1) });
    return response({ success: true, grant: row(9) });
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

/** Owner ruling E418(b): a revoke asks for a step-up; the dialog's two reads. */
function stepUpAnswer(url: string) {
  if (url.endsWith('/auth/step-up/methods')) return response({ success: true, methods: ['password'], preferred: 'password' });
  if (url.endsWith('/auth/step-up')) return response({ success: true, stepUpToken: 'rhsu_revoke' });
  return null;
}
async function confirmStepUp() {
  const dialog = within(await screen.findByRole('dialog'));
  fireEvent.change(await dialog.findByLabelText('Password'), { target: { value: 'test-password' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Continue' }));
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the paged list', () => {
  test('opens on ONE server page of hand-made grants, newest first, never an unbounded read', async () => {
    render(<GrantsPage />);
    await screen.findAllByText('Hand-made', { selector: 'strong' });
    const [first, ...rest] = listCalls();
    expect(rest).toHaveLength(0);
    expect(Object.fromEntries(first)).toEqual({ limit: '50', sort: '-created', made: 'hand' });
    expect(authenticatedFetch.mock.calls.some(([url]) => url === '/api/grants')).toBe(false);
    expect(screen.getByText('Showing 2 of 3')).toBeInTheDocument();
  });

  test('Load more sends the cursor and appends the next page without duplicating a row', async () => {
    const user = userEvent.setup();
    render(<GrantsPage />);
    await user.click(await screen.findByRole('button', { name: 'Load more grants' }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(listCalls()[1].get('cursor')).toBe('gc1.second');
    expect(Object.fromEntries([...listCalls()[1]].filter(([key]) => key !== 'cursor'))).toEqual(Object.fromEntries(listCalls()[0]));
    const table = await screen.findByRole('table', { name: 'Current access grants' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(1 + 3));
    expect(screen.queryByRole('button', { name: 'Load more grants' })).not.toBeInTheDocument();
  });

  test('says what the hand-made view hides, and Show all origins asks the server for every origin', async () => {
    const user = userEvent.setup();
    render(<GrantsPage />);
    expect(await screen.findByText(/Showing hand-made grants only\. Hidden by the Origin filter: 3911 system-made, 2 of unknown origin\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all origins' }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(listCalls()[1].get('made')).toBe('all');
    expect(listCalls()[1].has('cursor')).toBe(false);
  });

  test.each([
    ['Origin', 'system', 'made', 'system'],
    ['Resource type filter', 'report', 'resourceType', 'report'],
    ['Permission filter', 'write', 'verb', 'write'],
    ['Expiry state', 'expiring', 'expiry', 'expiring'],
    ['Resource state', 'archived', 'target', 'archived'],
    ['Sort', 'grantee', 'sort', 'grantee'],
  ])('the %s control is a server query parameter', async (label, value, key, sent) => {
    const user = userEvent.setup();
    render(<GrantsPage />);
    await screen.findByText('Showing 2 of 3');
    await user.selectOptions(screen.getByLabelText(label), value);
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(listCalls()[1].get(key)).toBe(sent);
    expect(listCalls()[1].get('limit')).toBe('50');
  });

  test('search is sent once, when typing pauses, and Reset returns to the hand-made view', async () => {
    const user = userEvent.setup();
    render(<GrantsPage />);
    await screen.findByText('Showing 2 of 3');
    await user.type(screen.getByLabelText('Search grants'), 'quarterly');
    await waitFor(() => expect(listCalls()).toHaveLength(2), { timeout: 2000 });
    expect(listCalls()[1].get('q')).toBe('quarterly');
    await user.click(screen.getByRole('button', { name: 'Reset to the hand-made view' }));
    await waitFor(() => expect(listCalls()).toHaveLength(3));
    expect(Object.fromEntries(listCalls()[2])).toEqual({ limit: '50', sort: '-created', made: 'hand' });
    expect(screen.getByLabelText('Search grants')).toHaveValue('');
  });
});

describe('origin labels come from the server and are never guessed', () => {
  test('hand-made, system-made with its writer, unknown, and a Group grantee', async () => {
    pages.first = { success: true, grants: [
      row(1),
      row(2, { madeBy: { class: 'system', via: 'task-creator', evidence: 'audit' }, grantedBy: connector, target: { label: 'Old work', status: 'archived', state: 'archived' } }),
      row(3, { madeBy: { class: 'unknown', via: null, evidence: 'none' }, grantedBy: null }),
      row(4, { granteeType: 'group', granteeId: '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e', grantee: null, granteeGroup: { id: '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e', name: 'Operators' },
        madeBy: { class: 'system', via: 'project-default', evidence: 'column' }, resourceType: 'project' }),
      row(5, { madeBy: undefined }),
    ], pagination: { limit: 50, sort: '-created', returned: 5, total: 5, hasMore: false, nextCursor: null } };
    render(<GrantsPage />);
    const table = await screen.findByRole('table', { name: 'Current access grants' });
    const rows = within(table).getAllByRole('row').slice(1);
    const origin = (r: HTMLElement) => within(r).getAllByRole('cell')[3].textContent;
    expect(origin(rows[0])).toBe('Hand-madeAccess page, CLI or API · by Focused Tester (tester)');
    expect(origin(rows[1])).toBe('System-madeTask creator access · by pc-connector');
    expect(within(rows[1]).getAllByRole('cell')[2].textContent).toContain('task · Old work');
    expect(within(rows[1]).getAllByRole('cell')[2].textContent).toContain('archived');
    expect(origin(rows[2])).toBe('Unknown originno creation record · writer not recorded');
    expect(within(rows[3]).getAllByRole('cell')[0].textContent).toContain('Group Operators');
    expect(origin(rows[3])).toBe('System-madeProject creation default · by Focused Tester (tester)');
    // A row the server sent without an origin is unknown, not hand-made.
    expect(origin(rows[4])).toContain('Unknown origin');
  });
});

describe('Edit and Revoke are one tidy, equal inline pair', () => {
  test('each row has one labelled group of exactly two same-class controls', async () => {
    render(<GrantsPage />);
    const table = await screen.findByRole('table', { name: 'Current access grants' });
    const groups = within(table).getAllByRole('group');
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group).toHaveAccessibleName(/^Actions for the read task grant for Focused Tester \(tester\)$/);
      const buttons = within(group).getAllByRole('button');
      expect(buttons.map(b => b.textContent)).toEqual(['Edit', 'Revoke']);
      expect(buttons.map(b => b.classList.contains('grants-action'))).toEqual([true, true]);
      expect(buttons[0]).toHaveAccessibleName('Edit read task grant for Focused Tester (tester)');
      expect(buttons[1]).toHaveAccessibleName('Revoke read task grant for Focused Tester (tester)');
    }
  });

  test('the stylesheet gives the pair two equal tracks and the danger modifier changes colour only', () => {
    const css = readFileSync(resolvePath(__dirname, 'GrantsPage.css'), 'utf8');
    const rule = (selector: string) => {
      const match = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      expect(match, selector).not.toBeNull();
      return match![2];
    };
    expect(rule('.grants-actions')).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    const action = rule('.grants-action');
    for (const declaration of ['width: 100%', 'min-height: var(--control-compact)', 'padding: 0 var(--space-3)', 'font-size: var(--text-sm)']) {
      expect(action).toContain(declaration);
    }
    const danger = rule('.grants-action--danger');
    expect(danger.split(';').map(d => d.split(':')[0].trim()).filter(Boolean).sort()).toEqual(['border-color', 'color']);
    // No narrower width collapses the pair into a stack.
    expect(css).not.toMatch(/\.grants-actions\s*\{[^}]*grid-template-columns:\s*1fr\s*;/);
  });

  test('Revoke removes the row and the count follows', async () => {
    render(<GrantsPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Revoke read task grant/ }))[0]);
    await confirmStepUp();
    await waitFor(() => expect(screen.getByText('Showing 1 of 2')).toBeInTheDocument());
  });
});

// Round-1 review of card ff410dc4: a grant made on this page was put at the
// top whatever the view showed (System-made only, another type, a search),
// with no resource title and stale per-origin counts; and Revoke stayed live
// while a save ran, so the pair looked different mid-save.
describe('a grant made on this page lands where the view says', () => {
  /** A POST answer as the server sends it: no origin or target fields. */
  function posted(extra: Record<string, unknown>) {
    const { madeBy: _madeBy, target: _target, ...plain } = row(9, extra);
    return { success: true, grant: plain };
  }
  const tableRows = () => within(screen.getByRole('table', { name: 'Current access grants' })).getAllByRole('row').slice(1);

  test('a type-wide grant the newest-first hand-made view shows is placed at the top, counted, without another read', async () => {
    const user = userEvent.setup();
    authenticatedFetch.mockImplementation((_url: string, options?: RequestInit) => (
      options ? response(posted({ resourceType: 'project', resourceId: null })) : response(pages.first)));
    render(<GrantsPage />);
    await screen.findByText('Showing 2 of 3');
    await user.click(screen.getByRole('button', { name: 'Create grant' }));
    expect(await screen.findByText('Showing 3 of 4')).toBeInTheDocument();
    expect(listCalls()).toHaveLength(1);
    const [first] = tableRows();
    expect(within(first).getAllByRole('cell')[2].textContent).toContain('Every resource of this type');
    expect(within(first).getAllByRole('cell')[3].textContent).toContain('Hand-made');
  });

  test.each([
    ['Origin', 'system', 'made'],
    ['Resource type filter', 'report', 'resourceType'],
    ['Sort', 'grantee', 'sort'],
  ])('with %s = %s the new grant is not prepended: the first page is read again', async (label, value, key) => {
    const user = userEvent.setup();
    authenticatedFetch.mockImplementation((_url: string, options?: RequestInit) => (
      options ? response(posted({ resourceType: 'project', resourceId: null })) : response(pages.first)));
    render(<GrantsPage />);
    await screen.findByText('Showing 2 of 3');
    await user.selectOptions(screen.getByLabelText(label), value);
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Create grant' }));
    await waitFor(() => expect(listCalls()).toHaveLength(3));
    expect(Object.fromEntries(listCalls()[2])).toEqual(Object.fromEntries(listCalls()[1]));
    expect(listCalls()[2].get(key)).toBe(value);
    expect(listCalls()[2].has('cursor')).toBe(false);
    // What shows is the server's page, not the POST row on top of it.
    await screen.findByText('Showing 2 of 3');
    expect(tableRows().some(r => (within(r).getAllByRole('cell')[2].textContent ?? '').includes('Every resource of this type'))).toBe(false);
  });

  test('a grant on one resource is read back, with its title and the origin counts from the server', async () => {
    const user = userEvent.setup();
    let reads = 0;
    authenticatedFetch.mockImplementation((_url: string, options?: RequestInit) => {
      if (options) return response(posted({}));
      reads += 1;
      return response(reads === 1 ? pages.first : {
        success: true,
        grants: [row(9, { target: { label: 'Fresh resource title', status: 'todo', state: 'live' } }), row(1), row(2)],
        pagination: { limit: 50, sort: '-created', returned: 3, total: 4, hasMore: true, nextCursor: 'gc1.second' },
        madeCounts: { hand: 4, system: 3912, unknown: 2 },
      });
    });
    render(<GrantsPage />);
    await screen.findByText('Showing 2 of 3');
    await user.click(screen.getByRole('button', { name: 'Create grant' }));
    expect(await screen.findByText('Showing 3 of 4')).toBeInTheDocument();
    expect(listCalls()).toHaveLength(2);
    expect(Object.fromEntries(listCalls()[1])).toEqual(Object.fromEntries(listCalls()[0]));
    expect(within(tableRows()[0]).getAllByRole('cell')[2].textContent).toContain('task · Fresh resource title');
    expect(screen.getByText(/Hidden by the Origin filter: 3912 system-made, 2 of unknown origin\./)).toBeInTheDocument();
  });
});

describe('Edit and Revoke share one disabled condition', () => {
  const actionButtons = () => within(screen.getByRole('table', { name: 'Current access grants' }))
    .getAllByRole('button', { name: /^(Edit|Revoke) read task grant/ });

  test('while a grant is being created, and while a revoke runs, both controls of every row are disabled together', async () => {
    const user = userEvent.setup();
    let finish: (() => void) | null = null;
    const held = (body: unknown) => new Promise(resolve => {
      finish = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    });
    authenticatedFetch.mockImplementation((url: string, options?: RequestInit) => {
      const stepUp = stepUpAnswer(String(url));
      if (stepUp) return stepUp;
      if (!options) return response(pages.first);
      if (options.method === 'DELETE') return held({ success: true, grant: row(1) });
      return held({ success: true, grant: row(9, { resourceType: 'project', resourceId: null }) });
    });
    render(<GrantsPage />);
    await screen.findByText('Showing 2 of 3');
    expect(actionButtons()).toHaveLength(4);
    for (const button of actionButtons()) expect(button).toBeEnabled();

    // A save in flight (Create grant): Edit AND Revoke are disabled.
    await user.click(screen.getByRole('button', { name: 'Create grant' }));
    await waitFor(() => expect(finish).not.toBeNull());
    for (const button of actionButtons()) expect([button.getAttribute('aria-label'), button.hasAttribute('disabled')]).toEqual([button.getAttribute('aria-label'), true]);
    finish!(); finish = null;
    await screen.findByText('Showing 3 of 4');
    await waitFor(() => { for (const button of actionButtons()) expect(button).toBeEnabled(); });

    // A revoke in flight: the same condition, the same pair.
    fireEvent.click(actionButtons().filter(b => b.textContent === 'Revoke')[0]);
    await confirmStepUp();
    await waitFor(() => expect(finish).not.toBeNull());
    for (const button of actionButtons()) expect([button.getAttribute('aria-label'), button.hasAttribute('disabled')]).toEqual([button.getAttribute('aria-label'), true]);
    finish!();
    await waitFor(() => { for (const button of actionButtons()) expect(button).toBeEnabled(); });
  });
});
