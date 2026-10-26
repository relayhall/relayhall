// @vitest-environment jsdom
/**
 * The SU-33 retry dialog hands the challenge's own methods to the dialog
 * (card f5a70765). The SU-14 challenge names which proofs the caller's
 * Account can give (card 72b8fb97); the retry dialog it opens shows what the
 * board says for THIS challenge, and when the methods read fails it falls
 * back to what the challenge advertised, not to a password alone.
 *
 * Owner ruling E444, through this wrapper (every surface that retries an act
 * after a 403 STEP_UP_REQUIRED uses it): a reused provider sign-in counts
 * down and asks again by itself, and the act gets its token; Cancel during the
 * countdown resolves the ask with null and starts nothing more.
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { STEP_UP_MESSAGE_TYPE } from '../../utils/stepUpLanding';

let methodsReply: { status: number; body: unknown } = { status: 503, body: {} };
/** E444: replies by path for the single sign-on arm; anything else answers `methodsReply`. */
const routed = new Map<string, { status: number; body: unknown }>();
const asked: string[] = [];
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string) => {
    asked.push(String(url));
    const key = [...routed.keys()].sort((a, b) => b.length - a.length).find((path) => String(url).endsWith(path));
    const answer = key ? routed.get(key)! : methodsReply;
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  }),
}));

import { useStepUpRetry } from './useStepUpRetry';
import type { StepUpChallenge } from '../../utils/stepUpChallenge';

let ask: ((challenge: StepUpChallenge) => Promise<string | null>) | null = null;

const Host: React.FC = () => {
  const { askForToken, retryDialog } = useStepUpRetry();
  ask = askForToken;
  return <>{retryDialog}</>;
};

afterEach(() => {
  cleanup();
  ask = null;
  routed.clear();
  asked.length = 0;
  vi.restoreAllMocks();
});

describe('useStepUpRetry', () => {
  test('a failed methods read falls back to the methods the challenge advertised', async () => {
    methodsReply = { status: 429, body: { error: 'Too Many Requests' } };
    render(<Host />);
    act(() => { void ask!({ action: 'grant.edit', targetId: 'g-1', methods: ['sso'] }); });
    expect(await screen.findByRole('button', { name: 'Continue with single sign-on' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  test('a challenge for a password Account still opens the password path', async () => {
    methodsReply = { status: 200, body: { success: true, methods: ['password'], preferred: 'password' } };
    render(<Host />);
    act(() => { void ask!({ action: 'grant.edit', targetId: 'g-1', methods: ['password'] }); });
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /single sign-on/i })).not.toBeInTheDocument();
  });
});

describe('E444 through the retry wrapper', () => {
  const FIRST = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
  const SECOND = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
  const starts = () => asked.filter((url) => url.endsWith('/auth/step-up')).length;
  const land = (requestId: string, outcome: 'complete' | 'refused', code: string | null = null) => act(() => {
    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { type: STEP_UP_MESSAGE_TYPE, outcome, requestId, code } }));
  });
  const startWith = (requestId: string) => routed.set('/auth/step-up', {
    status: 200, body: { success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize', requestId },
  });

  async function reuseOnce() {
    methodsReply = { status: 200, body: { success: true, methods: ['sso'], preferred: 'sso' } };
    const popup = { location: { href: '' }, close: vi.fn(), focus: vi.fn() };
    vi.spyOn(window, 'open').mockImplementation(() => popup as unknown as Window);
    startWith(FIRST);
    render(<Host />);
    let result: Promise<string | null> = Promise.resolve(null);
    act(() => { result = ask!({ action: 'grant.edit', targetId: 'g-1', methods: ['sso'] }); });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
    await screen.findByText(/Finish signing in/);
    land(FIRST, 'refused', 'SSO_STEP_UP_NOT_FRESH');
    await screen.findByRole('timer');
    return { result: () => result, popup };
  }

  test('a reused sign-in is waited out and asked again by itself; the act gets the fresh token', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = await reuseOnce();
      startWith(SECOND);
      routed.set('/auth/step-up/collect', { status: 200, body: { success: true, stepUpToken: 'rhsu_retry', action: 'grant.edit', targetId: 'g-1' } });
      await act(async () => { vi.advanceTimersByTime(35_000); });
      await waitFor(() => expect(starts()).toBe(2));
      await screen.findByText(/Finish signing in/);
      land(SECOND, 'complete');
      await expect(result()).resolves.toBe('rhsu_retry');
    } finally {
      vi.useRealTimers();
    }
  });

  test('Cancel during the countdown resolves the ask with null and starts nothing more', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = await reuseOnce();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await expect(result()).resolves.toBeNull();
      await act(async () => { vi.advanceTimersByTime(120_000); });
      expect(starts()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
