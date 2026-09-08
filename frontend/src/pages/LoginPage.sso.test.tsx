// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { LoginPage } from './LoginPage';
import { DEFAULT_CONFIG, RelayHallPublicConfig } from '../config/relayhall';

/**
 * SS-W2 · the login page's federated door (owner D5).
 *
 * Three properties are load-bearing and are asserted rather than assumed:
 *  - the button appears only where `/config` says the deployment federates, so
 *    a deployment that does not is byte-for-byte the page it was;
 *  - the button's label comes from the presence block and NEVER from an issuer
 *    or an endpoint, because presence is all an unauthenticated caller gets;
 *  - a federated login that FAILS to start must leave the password form usable.
 *    §8.5 makes the break-glass door permanent, and a page that stranded
 *    someone on a broken provider would remove it in the only way that matters.
 */
const login = vi.hoisted(() => vi.fn());
const loginWithAccount = vi.hoisted(() => vi.fn());
const startSso = vi.hoisted(() => vi.fn());

vi.mock('../utils/auth', () => ({
  auth: { login, loginWithAccount, startSso, isAuthenticated: () => false },
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

const withSso = (enabled: boolean, displayName: string | null = 'Estate SSO'): RelayHallPublicConfig => ({
  ...DEFAULT_CONFIG,
  auth: { ...DEFAULT_CONFIG.auth, sessions: true, sso: { enabled, displayName } },
});

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, 'location', {
    value: { ...window.location, assign },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  mockConfig.current = null;
  login.mockReset();
  loginWithAccount.mockReset();
  startSso.mockReset();
  cleanup();
});

describe('the SSO button follows the presence block', () => {
  test('is absent where the deployment does not federate', () => {
    mockConfig.current = withSso(false);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /sign in with/i })).not.toBeInTheDocument();
    // The control: the page still rendered, so the absence is the presence
    // block and not a page that failed to mount.
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  test('is present, and labelled from the presence block, where it does', () => {
    mockConfig.current = withSso(true, 'Estate SSO');
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Sign in with Estate SSO/i })).toBeInTheDocument();
  });

  test('falls back to a neutral label rather than rendering a null', () => {
    mockConfig.current = withSso(true, null);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    const button = screen.getByRole('button', { name: /sign in with/i });
    expect(button).toBeInTheDocument();
    expect(button.textContent).not.toMatch(/null|undefined/);
  });
});

describe('starting a federated login', () => {
  test('navigates the browser to the authorization URL the board returned', async () => {
    mockConfig.current = withSso(true);
    startSso.mockResolvedValue({
      success: true,
      authorizeUrl: 'https://idp.example.test/authorize?state=abc',
    });
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Sign in with Estate SSO/i }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://idp.example.test/authorize?state=abc');
    });
  });

  test('a provider that cannot be reached leaves the password door open', async () => {
    // The property §8.5 makes permanent. This is the one that matters: an
    // unreachable identity provider must cost a message, never the deployment.
    mockConfig.current = withSso(true);
    startSso.mockResolvedValue({ success: false, error: 'Could not reach the identity provider' });
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Sign in with Estate SSO/i }));

    await waitFor(() => {
      expect(screen.getByText('Could not reach the identity provider')).toBeInTheDocument();
    });
    expect(assign).not.toHaveBeenCalled();

    // And the password form still works, end to end, with the provider down.
    login.mockResolvedValue({ success: true });
    const onLoginSuccess = vi.fn();
    cleanup();
    render(<LoginPage onLoginSuccess={onLoginSuccess} />);
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'break-glass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalled());
  });

  test('does not start a second time while the first is in flight', async () => {
    mockConfig.current = withSso(true);
    let release: (value: unknown) => void = () => undefined;
    startSso.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    const button = screen.getByRole('button', { name: /Sign in with Estate SSO/i });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(startSso).toHaveBeenCalledTimes(1);
    release({ success: false, error: 'done' });
  });
});

describe('a refused federated login is RENDERED on the login page (a07f3277)', () => {
  const at = (search: string) => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign, search, href: `http://board.test/dashboard/${search}` },
      writable: true,
      configurable: true,
    });
  };

  test('the named refusal arrives as a person-visible sentence, with its code, and the password door stays open', () => {
    mockConfig.current = withSso(true);
    at('?sso_refused=SSO_LOGIN_GROUP_REFUSED');
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Sign-in refused: This account is not a member of a group permitted to sign in here.');
    expect(alert).toHaveTextContent('SSO_LOGIN_GROUP_REFUSED');
    expect(alert).toHaveAttribute('data-sso-refusal', 'SSO_LOGIN_GROUP_REFUSED');
    // The login page is the page: the form and the federated button are both still here.
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in with Estate SSO/i })).toBeInTheDocument();
  });

  test('an unknown code gets the neutral sentence and is still shown as the reason', () => {
    mockConfig.current = withSso(true);
    at('?sso_refused=SSO_SOMETHING_NEW');
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The sign-in could not be completed.');
    expect(alert).toHaveTextContent('SSO_SOMETHING_NEW');
  });

  test('a malformed value is not echoed at all', () => {
    mockConfig.current = withSso(true);
    at('?sso_refused=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('<script>');
  });

  test('CONTROL: with no refusal in the query there is no alert', () => {
    mockConfig.current = withSso(true);
    at('');
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
