import { PREFERENCES_CACHE_KEY_PREFIX } from './theme';

// Scope browser credentials to the actual deployment origin. A RelayHall
// instance is one environment; separate instances already have separate origins,
// databases and signing secrets.
const getOrigin = (): string =>
  typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'local';

const TOKEN_KEY = `relayhall_auth_token:${getOrigin()}`;
/**
 * SS-W1. A login session lives in an httpOnly cookie that no script can read,
 * so this marker is how the app knows to render the board instead of the login
 * page on the next load. It is a HINT and never a credential: it authorises
 * nothing, and a stale marker costs one 401, which `authenticatedFetch`
 * already turns into a clean return to the login page.
 */
const SESSION_KEY = `relayhall_session_active:${getOrigin()}`;
/**
 * Owner ruling 60307311 §1.1: the password door is BREAK-GLASS. When it is
 * used on a deployment that HAS an administrator Account, the dashboard says
 * so — the login response is the only place that fact is available, because
 * the token itself is opaque to the app. Like the session marker beside it
 * this is a HINT, not a credential: it authorises nothing, and a stale one
 * costs an unnecessary banner until the next sign-in.
 */
const BREAK_GLASS_KEY = `relayhall_break_glass:${getOrigin()}`;
// Same origin scoping as the token, and cleared with it — see clearToken.
const PREFERENCES_CACHE_KEY = `${PREFERENCES_CACHE_KEY_PREFIX}${getOrigin()}`;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const auth = {
  // Get token from localStorage
  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },

  // Save token to localStorage
  setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  },

  // Remove token from localStorage.
  //
  // The cached Theme preferences go with it (RH-UI.2). That cache exists so the
  // FOUC guard can resolve a Theme before any fetch, and it is keyed by ORIGIN,
  // not by principal — one browser, one deployment, whoever is signed in. If it
  // outlived the session, the next principal to sign in on this browser would
  // be shown the previous one's Theme until their own row arrived. Clearing it
  // here covers both exits from a session: the logout button, and
  // `authenticatedFetch` discarding an expired token on a 401.
  //
  // The login-session marker goes with it for the same reason: a 401 ends a
  // session of either kind, and leaving the marker would loop the app back to
  // a board it cannot load.
  clearToken(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PREFERENCES_CACHE_KEY);
    localStorage.removeItem(SESSION_KEY);
    // The announcement belongs to the session that earned it: leaving it would
    // announce a break-glass sign-in over somebody else's ordinary one.
    localStorage.removeItem(BREAK_GLASS_KEY);
  },

  /**
   * Whether THIS session arrived through the break-glass door on a deployment
   * that already has an administrator Account.
   */
  usedBreakGlass(): boolean {
    return localStorage.getItem(BREAK_GLASS_KEY) === '1';
  },

  /** Whether this browser believes it holds a live login session (SS-W1). */
  hasSession(): boolean {
    return localStorage.getItem(SESSION_KEY) === '1';
  },

  // Check if user is authenticated (has valid token, or a login session)
  isAuthenticated(): boolean {
    return !!this.getToken() || this.hasSession();
  },

  /**
   * ef35d960: a federated login sets ONLY the httpOnly login-session cookie — no
   * script can read it, and nothing on the SSO return path could arm the
   * marker, so the app rendered the login page while the server held a live
   * login session (the owner's first interactive test minted three). The
   * marker is therefore a CACHE of this probe's answer: when the app holds
   * neither a token nor the marker, it asks the API once, with credentials,
   * and arms the marker on 200.
   *
   * The two failure modes are now symmetric and both self-heal at the cost of
   * one clean round trip: a stale marker meets a 401 and clearToken() drops
   * it; a missing marker over a live cookie meets a 200 here and is armed.
   * A genuinely signed-out visitor pays one 401 on the login page.
   */
  async ensureSessionMarker(): Promise<boolean> {
    if (this.isAuthenticated()) return true;
    try {
      const response = await fetch(`${API_BASE_URL}/auth/sessions`, {
        credentials: 'same-origin',
      });
      if (response.ok) {
        localStorage.setItem(SESSION_KEY, '1');
        return true;
      }
    } catch {
      // Unreachable API renders the login page, exactly as before this probe.
    }
    return false;
  },

  // Login with password — the break-glass path (design d95136d7 §8.5).
  // Its request contract is deliberately unchanged: a password-only body.
  async login(password: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      });

      const data = await response.json();

      if (response.ok && data.token) {
        this.setToken(data.token);
        if (data.administratorExists === true) {
          localStorage.setItem(BREAK_GLASS_KEY, '1');
        } else {
          localStorage.removeItem(BREAK_GLASS_KEY);
        }
        return { success: true };
      }

      return { success: false, error: data.message || 'Login failed' };
    } catch (error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Sign in as a named Account (SS-16). The response carries NO token: the
   * session is delivered as an httpOnly cookie, so there is nothing here to
   * store and nothing a script could exfiltrate.
   */
  /**
   * SS-W2. Begin a federated login. The route RETURNS the authorization URL
   * rather than redirecting, so this page can be a fetch() and the browser
   * makes the navigation itself. The state cookie is set on this response,
   * which is why it must be a same-origin credentialed request.
   *
   * No identity provider detail is passed or received here: the deployment has
   * exactly one enabled provider (SS-14a) and the board picks it.
   */
  async startSso(): Promise<{ success: boolean; authorizeUrl?: string; error?: string }> {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/sso/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (response.ok && typeof data.authorizeUrl === 'string') {
        return { success: true, authorizeUrl: data.authorizeUrl };
      }
      return { success: false, error: data.message || 'Could not start single sign-on' };
    } catch {
      return { success: false, error: 'Could not reach the identity provider' };
    }
  },

  async loginWithAccount(account: string, password: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({ account, password }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        localStorage.setItem(SESSION_KEY, '1');
        return { success: true };
      }

      return { success: false, error: data.message || 'Login failed' };
    } catch (error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Create the FIRST administrator Account (owner ruling 60307311 §1.1).
   *
   * Like `loginWithAccount` the response carries no token: the new
   * administrator is signed in with an httpOnly session cookie, so the
   * credential that signs them in can never be read by a script.
   */
  async completeFirstRun(
    handle: string,
    displayName: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/first-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ handle, displayName, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success) {
        localStorage.setItem(SESSION_KEY, '1');
        // A brand-new administrator did not come through the break-glass door.
        localStorage.removeItem(BREAK_GLASS_KEY);
        return { success: true };
      }
      return { success: false, error: data.message || 'The administrator could not be created' };
    } catch {
      return { success: false, error: 'Network error' };
    }
  },

  // Logout.
  //
  // A login session lives on the server, so ending one is a request, not a
  // local erase — and the reload waits for it, or the page would reload with
  // the cookie still live. The token path is unchanged and stays synchronous.
  logout(): void {
    const hadSession = this.hasSession();
    this.clearToken();
    if (hadSession) {
      fetch(`${API_BASE_URL}/auth/session`, { method: 'DELETE', credentials: 'same-origin' })
        .catch(() => undefined)
        .then(() => { window.location.reload(); });
      return;
    }
    window.location.reload();
  },
};

// Fetch wrapper that adds auth token to all requests
export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = auth.getToken();

  const headers = {
    ...options.headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const response = await fetch(url, { ...options, headers });

  // If 401, reload to show login page
  if (response.status === 401) {
    auth.clearToken();
    window.location.reload();
  }

  return response;
}
