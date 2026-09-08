// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { LoginPage } from './LoginPage';
import { DEFAULT_CONFIG, RelayHallPublicConfig } from '../config/relayhall';

/**
 * SS-W1 · the login page's account field.
 *
 * Two properties are load-bearing and are asserted here rather than assumed:
 *  - the field appears only where the deployment offers login sessions, so a
 *    deployment that does not is byte-for-byte the page it was;
 *  - a BLANK account still reaches the break-glass door. §8.5 makes that door
 *    permanent and says no configuration may disable it; a UI that made it
 *    unreachable would disable it in the only way that matters.
 */
const login = vi.hoisted(() => vi.fn());
const loginWithAccount = vi.hoisted(() => vi.fn());

vi.mock('../utils/auth', () => ({
  auth: { login, loginWithAccount, startSso: vi.fn(), isAuthenticated: () => false },
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

const withSessions = (sessions: boolean): RelayHallPublicConfig => ({
  ...DEFAULT_CONFIG,
  auth: { ...DEFAULT_CONFIG.auth, sessions },
});

afterEach(() => {
  mockConfig.current = null;
  login.mockReset();
  loginWithAccount.mockReset();
  cleanup();
});

describe('the account field follows the deployment presence block', () => {
  test('is absent where the deployment offers no login sessions', () => {
    mockConfig.current = withSessions(false);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.queryByLabelText('Account')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  test('is present, and labelled, where it does', () => {
    mockConfig.current = withSessions(true);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.getByLabelText('Account')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  test('defaults to absent, so a /config that could not be read shows the break-glass form', () => {
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.queryByLabelText('Account')).not.toBeInTheDocument();
  });
});

describe('which door a submission takes', () => {
  test('a named account signs that Account in', async () => {
    mockConfig.current = withSessions(true);
    loginWithAccount.mockResolvedValue({ success: true });
    const onLoginSuccess = vi.fn();
    render(<LoginPage onLoginSuccess={onLoginSuccess} />);

    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'her-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());
    expect(loginWithAccount).toHaveBeenCalledWith('ada', 'her-password');
    expect(login).not.toHaveBeenCalled();
  });

  test('a BLANK account still reaches the permanent break-glass door', async () => {
    mockConfig.current = withSessions(true);
    login.mockResolvedValue({ success: true });
    const onLoginSuccess = vi.fn();
    render(<LoginPage onLoginSuccess={onLoginSuccess} />);

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'deployment-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());
    expect(login).toHaveBeenCalledWith('deployment-password');
    expect(loginWithAccount).not.toHaveBeenCalled();
  });

  test('whitespace is not an account name', async () => {
    mockConfig.current = withSessions(true);
    login.mockResolvedValue({ success: true });
    render(<LoginPage onLoginSuccess={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Account'), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'deployment-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => expect(login).toHaveBeenCalled());
    expect(loginWithAccount).not.toHaveBeenCalled();
  });

  test('a refusal is shown and the password is cleared, whichever door refused', async () => {
    mockConfig.current = withSessions(true);
    loginWithAccount.mockResolvedValue({ success: false, error: 'Invalid account or password' });
    render(<LoginPage onLoginSuccess={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => expect(screen.getByText('Invalid account or password')).toBeInTheDocument());
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    // The account name survives, so a mistyped password is one field to retry.
    expect((screen.getByLabelText('Account') as HTMLInputElement).value).toBe('ada');
  });
});
