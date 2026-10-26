// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { LoginPage } from './LoginPage';
import { DEFAULT_CONFIG, RelayHallPublicConfig } from '../config/relayhall';

/**
 * SIGN-IN ON AN ORIGIN THE BROWSER DOES NOT TRUST.
 *
 * The Account session rides a `Secure` cookie. A browser keeps it only from a
 * secure context: HTTPS, or `localhost`. Opened over plain HTTP at a LAN
 * address or a host name, the sign-in answers 200, the browser drops the
 * cookie, every following call is 401, and the page silently shows the empty
 * form again. First run is worse: the administrator IS created, and then can
 * never sign in from that address.
 *
 * So the page says it, plainly, BEFORE the form is sent, whenever the browser
 * itself reports `window.isSecureContext === false`, and says nothing on a
 * secure origin. The browser's own flag is the input, not a guess from the
 * host name: it already knows that `localhost` counts and a LAN address does
 * not.
 */
vi.mock('../utils/auth', () => ({
  auth: {
    login: vi.fn(), loginWithAccount: vi.fn(), completeFirstRun: vi.fn(),
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

const withAuth = (sessions: boolean, firstRun: boolean): RelayHallPublicConfig => ({
  ...DEFAULT_CONFIG,
  auth: { ...DEFAULT_CONFIG.auth, sessions, firstRun },
});

/** The browser's own answer, as a real browser exposes it (a read-only getter on window). */
function browserSays(secure: boolean | undefined) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => secure });
}

afterEach(() => {
  mockConfig.current = null;
  // jsdom itself defines no isSecureContext; restore exactly that.
  delete (window as unknown as Record<string, unknown>).isSecureContext;
  cleanup();
});

const NOTICE = /needs HTTPS or localhost/;

describe('the login form', () => {
  test('warns on an insecure origin before anything is sent', () => {
    mockConfig.current = withAuth(true, false);
    browserSays(false);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent(NOTICE);
    expect(notice).toHaveTextContent(/browser will not keep/);
    // The way that does work here is named, so the person is not stranded.
    expect(notice).toHaveTextContent(/deployment password/);
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument();
  });

  test('says nothing on a secure origin', () => {
    mockConfig.current = withAuth(true, false);
    browserSays(true);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('says nothing when the browser does not report the flag', () => {
    mockConfig.current = withAuth(true, false);
    browserSays(undefined);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  test('says nothing where no Account sign-in is offered (deployment password only)', () => {
    mockConfig.current = withAuth(false, false);
    browserSays(false);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});

describe('the first-run step', () => {
  test('warns that the administrator would be created but could not sign in here', () => {
    mockConfig.current = withAuth(true, true);
    browserSays(false);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Create the first administrator' })).toBeInTheDocument();
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent(NOTICE);
    expect(notice).toHaveTextContent(/would be created/);
    expect(notice).toHaveTextContent(/could not sign in/);
  });

  test('says nothing on a secure origin', () => {
    mockConfig.current = withAuth(true, true);
    browserSays(true);
    render(<LoginPage onLoginSuccess={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Create the first administrator' })).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});
