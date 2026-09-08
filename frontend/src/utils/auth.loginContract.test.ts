/**
 * Login contract pin (card 60558599, risk R11).
 *
 * The identity lane must NEVER change how the owner logs in. Locking the
 * owner out is the worst outcome this lane can produce, and browser-auth
 * changes belong to the later SSO work — not here.
 *
 * These assertions describe the contract exactly as it behaved before the
 * identity lane began: password-only body, token read from `data.token`, storage under
 * the environment-scoped key, and 401 anywhere clearing the token and
 * reloading. Any lane change that alters one of them fails here first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, authenticatedFetch } from './auth';

const TOKEN_KEY = 'relayhall_auth_token:local';

const originalFetch = global.fetch;
let reloadCalls = 0;

// This suite runs without jsdom (the project has no DOM environment
// configured), so the few browser globals `auth` touches are stubbed the same
// way the existing tests do it.
beforeEach(() => {
  const store = new Map<string, string>();
  reloadCalls = 0;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { reload: () => { reloadCalls += 1; } } },
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetch(response: { ok: boolean; status: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    });
  }) as unknown as typeof global.fetch;
  return calls;
}

describe('login request contract', () => {
  it('posts ONLY a password, as JSON', async () => {
    const calls = mockFetch({ ok: true, status: 200, body: { success: true, token: 'tok-1' } });

    await auth.login('hunter2');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/auth/login');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const body = JSON.parse(String(calls[0].init?.body));
    // Exactly one field. A lane change that starts sending a username, a
    // principal handle or a v2 flag would break the break-glass login path.
    expect(Object.keys(body)).toEqual(['password']);
    expect(body.password).toBe('hunter2');
  });

  it('stores the token from data.token under the env-scoped key', async () => {
    mockFetch({ ok: true, status: 200, body: { success: true, token: 'tok-2', expiresIn: '30d' } });

    const result = await auth.login('hunter2');

    expect(result.success).toBe(true);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok-2');
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('stores an opaque, undecodable token verbatim', async () => {
    // The client must never inspect or decode the token. A v2-shaped string
    // would still be stored by an implementation that decodes and validates,
    // so this pins the negative with a token that is NOT decodable: anything
    // parsing the payload would reject or mangle it.
    const opaque = 'not.a.jwt-at-all~~opaque~~';
    mockFetch({ ok: true, status: 200, body: { success: true, token: opaque } });

    const result = await auth.login('hunter2');

    expect(result.success).toBe(true);
    expect(localStorage.getItem(TOKEN_KEY)).toBe(opaque);
  });

  it('stores a v2-shaped token verbatim too', async () => {
    const v2Looking = 'eyJhbGciOiJIUzI1NiJ9.eyJ2IjoyLCJzdWIiOiJhYmMiLCJoYW5kbGUiOiJkYXNoYm9hcmRfdXNlciJ9.sig';
    mockFetch({ ok: true, status: 200, body: { success: true, token: v2Looking } });

    await auth.login('hunter2');

    expect(localStorage.getItem(TOKEN_KEY)).toBe(v2Looking);
  });

  it('does not log the owner out on a failed login', async () => {
    // login() must never route through the 401-clears-and-reloads path: a
    // typo would otherwise reload the page mid-attempt.
    localStorage.setItem(TOKEN_KEY, 'existing-session');
    mockFetch({ ok: false, status: 401, body: { message: 'Invalid password' } });

    await auth.login('typo');

    expect(reloadCalls).toBe(0);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('existing-session');
  });

  it('reports failure and stores nothing on a bad password', async () => {
    mockFetch({ ok: false, status: 401, body: { error: 'Unauthorized', message: 'Invalid password' } });

    const result = await auth.login('wrong');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid password');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('survives a network failure without throwing', async () => {
    global.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof global.fetch;

    const result = await auth.login('hunter2');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });
});

describe('401 handling contract', () => {
  it('clears the token and reloads on any 401', async () => {
    localStorage.setItem(TOKEN_KEY, 'stale-token');
    mockFetch({ ok: false, status: 401, body: {} });

    await authenticatedFetch('/api/tasks');

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(reloadCalls).toBe(1);
  });

  it('sends the stored token as a Bearer header and leaves it alone on success', async () => {
    localStorage.setItem(TOKEN_KEY, 'good-token');
    const calls = mockFetch({ ok: true, status: 200, body: { success: true } });

    await authenticatedFetch('/api/tasks');

    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer good-token');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('good-token');
    expect(reloadCalls).toBe(0);
  });

  it('omits the Authorization header entirely when there is no token', async () => {
    const calls = mockFetch({ ok: true, status: 200, body: {} });

    await authenticatedFetch('/api/health');

    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('logout clears the token and reloads', () => {
    localStorage.setItem(TOKEN_KEY, 'tok');

    auth.logout();

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(reloadCalls).toBe(1);
  });

  it('does NOT log out on 403 — only 401 ends a session', () => {
    // A 403 means "authenticated but not permitted". Treating it as a logout
    // would evict the owner the moment role/scope enforcement lands in CB-7.
    localStorage.setItem(TOKEN_KEY, 'good-token');
    mockFetch({ ok: false, status: 403, body: { error: 'Forbidden' } });

    return authenticatedFetch('/api/tasks').then(() => {
      expect(localStorage.getItem(TOKEN_KEY)).toBe('good-token');
      expect(reloadCalls).toBe(0);
    });
  });

  it('does NOT log out on 500', () => {
    localStorage.setItem(TOKEN_KEY, 'good-token');
    mockFetch({ ok: false, status: 500, body: {} });

    return authenticatedFetch('/api/tasks').then(() => {
      expect(localStorage.getItem(TOKEN_KEY)).toBe('good-token');
      expect(reloadCalls).toBe(0);
    });
  });
});
