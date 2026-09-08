// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { LoginSessions } from './LoginSessions';

/**
 * SS-W1 · the session list and its revoke controls.
 *
 * What matters here is that the surface asks the server for the caller's own
 * sessions and never filters them itself — a client-side "whose" filter is a
 * disclosure waiting to happen, so the request must carry no such parameter.
 */
const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../utils/auth', () => ({ authenticatedFetch }));

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    createdAt: '2026-08-30T09:00:00.000Z',
    lastSeenAt: '2026-08-30T10:00:00.000Z',
    expiresAt: '2026-09-29T09:00:00.000Z',
    ip: '203.0.113.4',
    userAgent: 'Firefox on Linux',
    current: true,
    ...overrides,
  };
}

function reply(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

beforeEach(() => {
  authenticatedFetch.mockReset();
});

afterEach(cleanup);

describe('the session list', () => {
  test('asks the server for the caller own sessions, with no "whose" parameter', async () => {
    authenticatedFetch.mockResolvedValue(reply({ sessions: [session()] }));

    render(<LoginSessions />);

    await waitFor(() => expect(screen.getByText('Firefox on Linux')).toBeInTheDocument());
    const url = String(authenticatedFetch.mock.calls[0][0]);
    expect(url).toContain('/auth/sessions');
    expect(url).not.toContain('?');
  });

  test('marks the browser you are reading it in', async () => {
    authenticatedFetch.mockResolvedValue(reply({
      sessions: [session(), session({ id: 'sess-2', userAgent: 'curl', current: false })],
    }));

    render(<LoginSessions />);

    await waitFor(() => expect(screen.getByText('This browser')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'End session' })).toHaveLength(2);
  });

  test('says so plainly when there are none', async () => {
    authenticatedFetch.mockResolvedValue(reply({ sessions: [] }));

    render(<LoginSessions />);

    await waitFor(() =>
      expect(screen.getByText(/no server-side login sessions/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).not.toBeInTheDocument();
  });

  test('renders nothing dangerous when the endpoint refuses', async () => {
    authenticatedFetch.mockResolvedValue(reply({ error: 'Not Found' }, 404));

    render(<LoginSessions />);

    await waitFor(() =>
      expect(screen.getByText(/no server-side login sessions/i)).toBeInTheDocument());
  });
});

describe('revoking', () => {
  test('ends one session by id and reloads the list', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(reply({ sessions: [session({ id: 'sess-2', current: false, userAgent: 'curl' })] }))
      .mockResolvedValueOnce(reply(undefined, 204))
      .mockResolvedValueOnce(reply({ sessions: [] }));

    render(<LoginSessions />);
    await waitFor(() => expect(screen.getByText('curl')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'End session' }));

    await waitFor(() =>
      expect(screen.getByText(/no server-side login sessions/i)).toBeInTheDocument());
    expect(String(authenticatedFetch.mock.calls[1][0])).toContain('/auth/sessions/sess-2');
    expect(authenticatedFetch.mock.calls[1][1]).toEqual({ method: 'DELETE' });
  });

  test('signs out everywhere through the collection route', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(reply({ sessions: [session()] }))
      .mockResolvedValueOnce(reply({ success: true, revoked: 2 }));
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: vi.fn() },
    });

    render(<LoginSessions />);
    await waitFor(() => expect(screen.getByText('Firefox on Linux')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    const [url, init] = authenticatedFetch.mock.calls[1];
    expect(String(url)).toMatch(/\/auth\/sessions$/);
    expect(init).toEqual({ method: 'DELETE' });
  });
});
