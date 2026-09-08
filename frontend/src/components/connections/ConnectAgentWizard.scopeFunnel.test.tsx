/*
 * T1-R2 (round-2 control gap, card 7f6d7635): the `chooseScopes` funnel.
 *
 * The wizard stops tracking the session's authority once the person has EDITED
 * the selection — not merely opened the disclosure. That flag is set in exactly
 * one place, `chooseScopes`, and the claim is that every path which changes the
 * selection goes through it.
 *
 * Round 2 proved the existing tests could not see that claim: changing the
 * editor back to `onChange={setChosenScopes}` left all fifteen wizard tests
 * green, because none of them changed the resolved scopes AFTER an edit. This
 * file does exactly that, which is the only arrangement in which bypassing the
 * funnel is observable — with the flag lost, a later authority update silently
 * overwrites a deliberate choice.
 *
 * The session hook is mocked rather than the fetch, because the property under
 * test is "what happens when the resolved scope set CHANGES", and driving that
 * through the network mock would test the hook instead of the wizard.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ConnectAgentWizard } from './ConnectAgentWizard';

/** The scope set the session currently resolves to; swapped mid-test. */
let sessionScopes: string[] = ['tasks:read', 'tasks:write', 'reports:read'];

vi.mock('../../hooks/usePrincipals', () => ({
  useMyPrincipal: () => ({ me: { id: 'me', handle: 'ada' }, scopes: sessionScopes, loading: false }),
  usePrincipals: () => ({ principals: [], byId: new Map(), byHandle: new Map(), loading: false, unavailable: false, failed: false, reload: () => undefined }),
}));

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const checkboxes = () => screen.getAllByRole('checkbox') as HTMLInputElement[];
const checkedIds = () => checkboxes().filter((b) => b.checked).map((b) => b.id);

beforeEach(() => {
  fetchMock.mockReset();
  sessionScopes = ['tasks:read', 'tasks:write', 'reports:read'];
});
afterEach(cleanup);

describe('the chooseScopes funnel', () => {
  it('a deliberate edit survives a LATER change to the resolved authority', async () => {
    const view = render(<MemoryRouter><ConnectAgentWizard /></MemoryRouter>);
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    await waitFor(() => expect(checkboxes()).toHaveLength(3));
    expect(checkboxes().every((b) => b.checked)).toBe(true);

    // The person deliberately drops one.
    const dropped = checkboxes()[0].id;
    await userEvent.click(checkboxes()[0]);
    expect(checkedIds()).not.toContain(dropped);

    // The session's authority is then answered again, with MORE scopes — a
    // late refresh, a re-render, a second resolution. This is the moment the
    // bypass is visible: without the flag, the effect re-syncs and the
    // deliberate choice is silently undone.
    sessionScopes = ['tasks:read', 'tasks:write', 'reports:read', 'projects:read'];
    view.rerender(<MemoryRouter><ConnectAgentWizard /></MemoryRouter>);
    await waitFor(() => expect(checkboxes()).toHaveLength(4));

    expect(checkedIds()).not.toContain(dropped);
    // The newly-arrived scope is not silently granted either — the selection
    // belongs to the person now.
    expect(checkedIds()).toHaveLength(2);
  });

  it('CONTROL: before any edit, a change to the resolved authority IS adopted', async () => {
    // The mirror case, so the test above cannot be satisfied by a wizard that
    // simply never tracks the session at all.
    const view = render(<MemoryRouter><ConnectAgentWizard /></MemoryRouter>);
    await userEvent.click(screen.getByRole('radio', { name: /Claude Code/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Narrow it' }));
    await waitFor(() => expect(checkboxes()).toHaveLength(3));

    sessionScopes = ['tasks:read', 'tasks:write', 'reports:read', 'projects:read'];
    view.rerender(<MemoryRouter><ConnectAgentWizard /></MemoryRouter>);

    await waitFor(() => expect(checkboxes()).toHaveLength(4));
    expect(checkboxes().every((b) => b.checked)).toBe(true);
  });
});
