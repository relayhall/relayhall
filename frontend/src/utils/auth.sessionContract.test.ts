/**
 * SS-W1 · the login-session half of the browser auth contract.
 *
 * `auth.loginContract.test.ts` pins the break-glass path and must keep
 * passing untouched — that is the whole point of a break-glass path. This
 * file pins what SS-W1 adds beside it:
 *
 *  - a session login stores NO token, because the response carries none: the
 *    credential is an httpOnly cookie no script can read (AZ-18/A17.1);
 *  - the marker it does store is a hint, cleared by every exit from a session;
 *  - logging out of a session is a REQUEST, not a local erase, and the reload
 *    waits for it — otherwise the page returns with the cookie still live.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, authenticatedFetch } from './auth';

const TOKEN_KEY = 'relayhall_auth_token:local';
const SESSION_KEY = 'relayhall_session_active:local';

const originalFetch = global.fetch;
let reloadCalls = 0;

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

describe('session login request contract', () => {
  it('posts the account and the password to /auth/session', async () => {
    const calls = mockFetch({ ok: true, status: 200, body: { success: true, expiresAt: 'later' } });

    await auth.loginWithAccount('ada', 'her-password');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/auth/session');
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(Object.keys(body).sort()).toEqual(['account', 'password']);
    expect(body).toEqual({ account: 'ada', password: 'her-password' });
  });

  it('stores NO token — the response carries none and the cookie is httpOnly', async () => {
    mockFetch({ ok: true, status: 200, body: { success: true, expiresAt: 'later' } });

    const result = await auth.loginWithAccount('ada', 'her-password');

    expect(result.success).toBe(true);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBe('1');
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('ignores a token if a server ever sent one', async () => {
    // Defence in depth against a future server that returns a session token
    // in the body: this client must never put one in storage, where a script
    // could read it.
    mockFetch({ ok: true, status: 200, body: { success: true, token: 'should-not-be-stored' } });

    await auth.loginWithAccount('ada', 'her-password');

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('marks nothing and reports the message on a refusal', async () => {
    mockFetch({ ok: false, status: 401, body: { error: 'Unauthorized', message: 'Invalid account or password' } });

    const result = await auth.loginWithAccount('ada', 'wrong');

    expect(result).toEqual({ success: false, error: 'Invalid account or password' });
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(reloadCalls).toBe(0);
  });

  it('survives a network failure without throwing', async () => {
    global.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof global.fetch;

    const result = await auth.loginWithAccount('ada', 'her-password');

    expect(result).toEqual({ success: false, error: 'Network error' });
  });
});

describe('ending a session', () => {
  it('asks the server to end it, and reloads only after that request settles', async () => {
    localStorage.setItem(SESSION_KEY, '1');
    let release: (value: unknown) => void = () => undefined;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Promise((resolve) => { release = resolve; });
    }) as unknown as typeof global.fetch;

    auth.logout();

    expect(calls[0].url).toContain('/auth/session');
    expect(calls[0].init?.method).toBe('DELETE');
    // The marker goes immediately; the reload waits for the server.
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(reloadCalls).toBe(0);
    release({ ok: true, status: 204 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reloadCalls).toBe(1);
  });

  it('still reloads when the logout request fails', async () => {
    localStorage.setItem(SESSION_KEY, '1');
    global.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof global.fetch;

    auth.logout();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reloadCalls).toBe(1);
  });

  it('a 401 anywhere clears the session marker too', async () => {
    localStorage.setItem(SESSION_KEY, '1');
    mockFetch({ ok: false, status: 401, body: {} });

    await authenticatedFetch('/api/tasks');

    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
    expect(reloadCalls).toBe(1);
  });

  it('sends no Authorization header for a session request — the cookie is the credential', async () => {
    localStorage.setItem(SESSION_KEY, '1');
    const calls = mockFetch({ ok: true, status: 200, body: {} });

    await authenticatedFetch('/api/auth/sessions');

    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
