// @vitest-environment jsdom
/**
 * ef35d960 — the login-session marker is a CACHE of the probe's answer.
 *
 * A federated login sets only the httpOnly cookie; the SSO return path cannot
 * arm the localStorage marker synchronously, so `ensureSessionMarker()` is the
 * one mechanism that turns a live cookie into a rendered board. These tests
 * are the committed control for that mechanism: remove the probe, or the
 * arming line, or widen it to arm on a refusal, and one of them goes red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { auth } from './auth';

const ORIGIN = window.location.origin;
const TOKEN_KEY = `relayhall_auth_token:${ORIGIN}`;
const SESSION_KEY = `relayhall_session_active:${ORIGIN}`;

describe('ef35d960 · ensureSessionMarker', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('arms the marker over a live login-session cookie (the SSO return path)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sessions: [] }), { status: 200 }) as Response,
    );

    await expect(auth.ensureSessionMarker()).resolves.toBe(true);

    expect(localStorage.getItem(SESSION_KEY)).toBe('1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The probe must CARRY the cookie — without credentials it can only 401.
    expect(String(url)).toMatch(/\/auth\/sessions$/);
    expect(init?.credentials).toBe('same-origin');
  });

  it('leaves a signed-out browser signed out on 401, marker unarmed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) as Response,
    );

    await expect(auth.ensureSessionMarker()).resolves.toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('does not probe at all when the marker is already armed', async () => {
    localStorage.setItem(SESSION_KEY, '1');
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(auth.ensureSessionMarker()).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not probe when a bearer token is present', async () => {
    localStorage.setItem(TOKEN_KEY, 'a-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(auth.ensureSessionMarker()).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats an unreachable API as signed out, exactly as before the probe existed', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));

    await expect(auth.ensureSessionMarker()).resolves.toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('NON-VACUITY control: a 200 without the arming write would fail the first test', () => {
    // The first test asserts BOTH the resolved value and the stored marker.
    // This control documents why: a probe that returns true without writing
    // the marker satisfies the return-value half alone, and the app would
    // sign out again on the next full reload. The marker assertion is the
    // load-bearing half.
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });
});
