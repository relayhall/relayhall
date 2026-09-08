// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { LoginPage } from './LoginPage';
import { DEFAULT_CONFIG, RelayHallPublicConfig } from '../config/relayhall';

/**
 * THE FIRST-RUN STEP on the login page (owner ruling `60307311` §1.1).
 *
 * Four properties are load-bearing:
 *  - the step appears exactly while `/config` says the deployment has no
 *    administrator, and never otherwise — a step offered on a deployment that
 *    has one is a step whose route answers 409;
 *  - the fail-closed default holds: a `/config` that could not be read shows
 *    the ordinary form, not a bootstrapping step;
 *  - the break-glass door stays reachable from the step, because §8.5 makes it
 *    permanent and a UI that hid it would disable it in the only way that
 *    matters;
 *  - the two passwords must agree before anything is sent.
 */
const login = vi.hoisted(() => vi.fn());
const loginWithAccount = vi.hoisted(() => vi.fn());
const completeFirstRun = vi.hoisted(() => vi.fn());

vi.mock('../utils/auth', () => ({
  auth: {
    login, loginWithAccount, completeFirstRun,
    startSso: vi.fn(), isAuthenticated: () => false,
  },
}));

const mockConfig = vi.hoisted(() => ({ current: null as RelayHallPublicConfig | null }));
vi.mock('../contexts/RelayHallConfigContext', async () => {
  const actual = await import('../config/relayhall');
  return {
    useRelayHallConfig: () => ({
      config: mockConfig.current ?? actual.DEFAULT_CONFIG,
      loading: false,
      error: null,
    }),
  };
});

const withFirstRun = (firstRun: boolean): RelayHallPublicConfig => ({
  ...DEFAULT_CONFIG,
  auth: { ...DEFAULT_CONFIG.auth, sessions: true, firstRun },
});

const STEP_BUTTON = 'Create the first administrator';

afterEach(() => {
  mockConfig.current = null;
  login.mockReset();
  loginWithAccount.mockReset();
  completeFirstRun.mockReset();
  cleanup();
});

function fill(values: { handle?: string; name?: string; password?: string; confirm?: string }) {
  if (values.handle !== undefined) {
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: values.handle } });
  }
  if (values.name !== undefined) {
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: values.name } });
  }
  if (values.password !== undefined) {
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: values.password } });
  }
  if (values.confirm !== undefined) {
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: values.confirm } });
  }
}

describe('when the step appears', () => {
  test('while the deployment has no administrator', () => {
    mockConfig.current = withFirstRun(true);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.getByRole('button', { name: STEP_BUTTON })).toBeInTheDocument();
    // The ordinary sign-in form is replaced, not merely appended.
    expect(screen.queryByRole('button', { name: 'Login' })).not.toBeInTheDocument();
  });

  test('never once an administrator exists', () => {
    mockConfig.current = withFirstRun(false);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.queryByRole('button', { name: STEP_BUTTON })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument();
  });

  test('and not on the fail-closed default, so an unreadable /config shows the ordinary form', () => {
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.queryByRole('button', { name: STEP_BUTTON })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument();
  });
});

describe('the break-glass door stays reachable', () => {
  test('the step offers the way back to the password form', () => {
    mockConfig.current = withFirstRun(true);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /deployment password instead/ }));
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: STEP_BUTTON })).not.toBeInTheDocument();
  });
});

describe('what the step sends', () => {
  test('the handle lowercased and trimmed, the display name trimmed, the password as typed', async () => {
    mockConfig.current = withFirstRun(true);
    completeFirstRun.mockResolvedValue({ success: true });
    const onLoginSuccess = vi.fn();
    render(<LoginPage onLoginSuccess={onLoginSuccess} />);
    fill({ handle: '  Ada  ', name: '  Ada Lovelace  ', password: 'a-long-enough-password', confirm: 'a-long-enough-password' });
    fireEvent.click(screen.getByRole('button', { name: STEP_BUTTON }));
    await waitFor(() => expect(completeFirstRun).toHaveBeenCalledWith('ada', 'Ada Lovelace', 'a-long-enough-password'));
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());
  });

  test('nothing at all while the two passwords disagree', async () => {
    mockConfig.current = withFirstRun(true);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    fill({ handle: 'ada', password: 'a-long-enough-password', confirm: 'a-different-password' });
    const submit = screen.getByRole('button', { name: STEP_BUTTON });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(completeFirstRun).not.toHaveBeenCalled();
  });

  test('nothing at all while the password is too short', () => {
    mockConfig.current = withFirstRun(true);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    fill({ handle: 'ada', password: 'short', confirm: 'short' });
    expect(screen.getByRole('button', { name: STEP_BUTTON })).toBeDisabled();
    expect(completeFirstRun).not.toHaveBeenCalled();
  });
});

describe('what the step says when the server refuses', () => {
  test('the server sentence, verbatim, in an alert', async () => {
    mockConfig.current = withFirstRun(true);
    completeFirstRun.mockResolvedValue({
      success: false,
      error: "'dashboard_user' is a reserved handle",
    });
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    fill({ handle: 'ada', password: 'a-long-enough-password', confirm: 'a-long-enough-password' });
    fireEvent.click(screen.getByRole('button', { name: STEP_BUTTON }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("'dashboard_user' is a reserved handle");
    // A refused attempt must not leave the typed password sitting in the DOM.
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  });
});

describe('the step is reachable without a mouse', () => {
  test('every field is labelled and every hint is associated', () => {
    mockConfig.current = withFirstRun(true);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    for (const label of ['Account name', 'Display name', 'Password', 'Confirm password']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    const handle = screen.getByLabelText('Account name');
    const describedBy = handle.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toBeInTheDocument();
  });
});
