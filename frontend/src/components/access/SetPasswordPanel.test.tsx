/*
 * THE PASSWORD CONTROL (card bc5cd9f0).
 *
 * What is pinned here is what the panel OFFERS and what it SENDS — the two
 * things a rewrite could break silently. The server is the authority on every
 * refusal, so this file deliberately does not restate one; it measures that the
 * panel narrows its own target list by the same ordering the route enforces,
 * that it states no password policy of its own, that a typed password does not
 * outlive the call it was typed for, and that the route's own sentence about
 * existing sessions is the sentence the person reads.
 */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetPasswordPanel } from './SetPasswordPanel';
import type { Principal } from '../../types/task';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const principal = (over: Partial<Principal> & { id: string; handle: string }): Principal => ({
  kind: 'human', displayName: null, status: 'active', role: 'user', ...over,
} as Principal);

const PEOPLE: Principal[] = [
  principal({ id: 'me', handle: 'ada', role: 'admin' }),
  principal({ id: 'p-grace', handle: 'grace', role: 'user' }),
  principal({ id: 'p-op', handle: 'olive', role: 'operator' }),
  principal({ id: 'p-admin', handle: 'aisha', role: 'admin' }),
  principal({ id: 'p-none', handle: 'noel', role: null }),
  principal({ id: 'p-sys', handle: 'system', role: null }),
  principal({ id: 'p-local', handle: 'dashboard_user', role: 'orchestrator' }),
  principal({ id: 'p-disabled', handle: 'dora', role: 'user', status: 'disabled' }),
  principal({ id: 'p-svc', handle: 'connector-laptop', role: null, kind: 'service' }),
];

const surface = vi.fn();

const renderPanel = (issuerRole: string) => render(
  <SetPasswordPanel
    principals={PEOPLE}
    issuerRole={issuerRole}
    ownPrincipalId="me"
    surface={surface}
  />,
);

const options = () => Array.from(
  (screen.getByLabelText('Account') as HTMLSelectElement).options,
).map((option) => option.textContent || '');

const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
const refused = (status: number, payload: unknown) =>
  ({ ok: false, status, json: async () => payload });

beforeEach(() => {
  fetchMock.mockReset();
  surface.mockReset();
});
afterEach(cleanup);

describe('what it offers', () => {
  it('an admin sees every human Account it could assign a role to, and nobody else', async () => {
    renderPanel('admin');
    const listed = options().join(' | ');
    expect(listed).toContain('grace');
    expect(listed).toContain('olive');
    expect(listed).toContain('aisha');   // an admin may reach an admin
    expect(listed).toContain('noel');    // a role-less Account: canAssignRole admits it

    // Never the caller's own row — changing your own password is a different
    // act with a different rule (the current one must be re-entered).
    expect(listed).not.toContain('ada');
    // Never the request-less internal actor, and never the break-glass identity.
    expect(listed).not.toContain('system');
    expect(listed).not.toContain('dashboard_user');
    // Never a disabled Account: AccountPasswordService refuses it by name.
    expect(listed).not.toContain('dora');
    // Never a Connector: AUTHZ §7.1 gives a password to humans only.
    expect(listed).not.toContain('connector-laptop');
  });

  it('an operator does NOT see the Accounts its own role cannot reach', async () => {
    // The display half of `canAssignRole`: an operator may not assign `admin`
    // or `orchestrator`, so it may not give those Accounts a way in either. The
    // route refuses it regardless; this makes the refusal unreachable rather
    // than merely explained.
    renderPanel('operator');
    const listed = options().join(' | ');
    expect(listed).toContain('grace');
    expect(listed).toContain('olive');
    expect(listed).not.toContain('aisha');
  });

  it('CONTROL: the two roles genuinely differ, so the test above is not vacuous', () => {
    renderPanel('admin');
    const asAdmin = options().length;
    cleanup();
    renderPanel('operator');
    expect(options().length).toBeLessThan(asAdmin);
  });
});

describe('what it says, and does not say', () => {
  it('states NO password policy of its own', async () => {
    // The minimum length and the bcrypt byte ceiling live in one place on the
    // server, shared with the first-run act precisely so they cannot come to
    // differ. A number here would be a second place, and the census that would
    // have caught it does not exist — so this assertion is it.
    renderPanel('admin');
    const rendered = document.body.textContent || '';
    expect(rendered).not.toMatch(/\b\d+\s*(characters|bytes)\b/i);
    expect(rendered).toMatch(/wait for confirmation below before trying to sign in/);
  });

  it('says plainly that existing sign-ins are not ended', () => {
    renderPanel('admin');
    expect(document.body.textContent).toMatch(/does not sign that Account out/);
  });
});

describe('what it sends', () => {
  const fill = async (password: string, confirmation = password) => {
    await userEvent.selectOptions(screen.getByLabelText('Account'), 'p-grace');
    await userEvent.type(screen.getByLabelText(/New password/), password);
    await userEvent.type(screen.getByLabelText('Type it again'), confirmation);
  };

  it('PUTs the password to the route, and nothing else', async () => {
    fetchMock.mockResolvedValue(ok({ success: true, sessionsRevoked: false, note: 'The password is set and can be used to sign in now.' }));
    renderPanel('admin');
    await fill('a-perfectly-fine-password');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/principals/p-grace/password');
    expect(init.method).toBe('PUT');
    // A password never travels in a URL, and the body carries the password and
    // nothing more — no handle, no role, nothing the server should be deciding.
    expect(String(url)).not.toContain('password=');
    expect(JSON.parse(init.body)).toEqual({ password: 'a-perfectly-fine-password' });
  });

  it('surfaces the SERVER’s sentence about what just happened', async () => {
    const note = 'The password is set and can be used to sign in now. Any sessions that Account already has stay signed in — setting a password does not end them.';
    fetchMock.mockResolvedValue(ok({ success: true, sessionsRevoked: false, note }));
    renderPanel('admin');
    await fill('a-perfectly-fine-password');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(surface).toHaveBeenCalledWith('notice', note));
    expect(screen.getByText(note)).toBeVisible();
  });

  it('renders the board’s named refusal rather than a sentence of its own', async () => {
    fetchMock.mockResolvedValue(refused(422, {
      error: 'Refused', code: 'PASSWORD_TOO_SHORT',
      message: 'A password must be at least 12 characters',
    }));
    renderPanel('admin');
    await fill('short');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(surface).toHaveBeenCalledWith('error', 'A password must be at least 12 characters'));
    // Parent notifications can be several sections above this form. The
    // refusal must be visible here even when surface is only a callback.
    expect(screen.getByRole('alert')).toHaveTextContent('Password not set. A password must be at least 12 characters');
    expect(screen.getByLabelText(/New password/)).toHaveAttribute('aria-describedby', 'axm-password-outcome');
    expect(screen.queryByText(/can sign in with this password now/)).not.toBeInTheDocument();
    fetchMock.mockResolvedValue(ok({ success: true, note: 'Password saved. Sign in now.' }));
    await fill('a-perfectly-fine-password');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(screen.getByText('Password saved. Sign in now.')).toBeVisible());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('will not send two entries that do not match', async () => {
    renderPanel('admin');
    await fill('a-perfectly-fine-password', 'a-different-password');
    expect(screen.getByRole('button', { name: 'Set password' })).toBeDisabled();
    expect(screen.getByText('The two entries do not match.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps no typed password in the page after the call, on success OR refusal', async () => {
    // A value typed for one call has no reason to sit in a live page afterwards
    // — including after a failure, which is exactly when somebody walks away
    // from the screen.
    fetchMock.mockResolvedValue(refused(500, { message: 'boom' }));
    renderPanel('admin');
    await fill('a-perfectly-fine-password');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(surface).toHaveBeenCalledWith('error', 'boom'));
    expect((screen.getByLabelText(/New password/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Type it again') as HTMLInputElement).value).toBe('');
  });

  it('never shows the typed password on screen', async () => {
    renderPanel('admin');
    await fill('a-perfectly-fine-password');
    for (const field of ['New password', 'Type it again']) {
      const input = screen.getByLabelText(new RegExp(field)) as HTMLInputElement;
      expect(input.type).toBe('password');
      expect(input.autocomplete).toBe('new-password');
    }
    // And it is nowhere in the rendered text either.
    expect(document.body.textContent).not.toContain('a-perfectly-fine-password');
  });
});
