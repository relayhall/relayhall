// @vitest-environment jsdom
/**
 * StepUpDialog — card a3e76724. The dialog asks for the proof THIS Account
 * can give, measured with the board's answer doubled both ways:
 *  - a password Account sees the password form, exactly as before, and no
 *    single sign-on control;
 *  - an Identity-provider-only Account is NOT asked for a password: it opens
 *    the provider in its own window, waits for the landing message naming ITS
 *    request, collects the token and hands it on;
 *  - a refusal arrives as a named code and renders a fixed sentence; a
 *    message for another request, or from another origin, is ignored;
 *  - a blocked pop-up starts nothing; a not-yet-finished proof says so.
 *
 * Card 7a99d63e (design SU-32, SU-35) adds the NAMED causes, each pinned by
 * its exact sentence: a weak confirmation (S7) and a provider decline (S8)
 * say so and offer "Try again"; no state ever tells the person to sign out.
 *
 * Owner ruling E444 replaces the reused sign-in's red refusal and manual
 * "Try again" (S6): the dialog counts down and asks again by itself, as a NEW
 * request in the window the landing kept open, never collecting the refused
 * one; a second reuse restarts the countdown; past the bound the normal
 * message (S6 with S6b) shows and nothing more starts; Cancel always stops
 * it; the countdown is announced politely and not every second, focus stays
 * in the dialog, and it is axe-clean.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
const replies = new Map<string, { status?: number; body: unknown }>();
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, options?: RequestInit) => {
    fetchCalls.push({ url, options });
    // Longest key first, so '/auth/step-up/collect' wins over '/auth/step-up'.
    const keys = [...replies.keys()].sort((a, b) => b.length - a.length);
    const key = keys.find((candidate) => url.endsWith(candidate));
    const reply = key ? replies.get(key)! : { body: { success: true } };
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body };
  }),
}));

import { MAX_AUTOMATIC_RETRIES, StepUpDialog } from './StepUpDialog';
import {
  RELAUNCH_ACK_MS,
  STEP_UP_CHANNEL,
  STEP_UP_MESSAGE_TYPE,
  STEP_UP_RELAUNCH_TYPE,
  completeStepUpLanding,
  stopKeptLanding,
} from '../../utils/stepUpLanding';
import axe from 'axe-core';

const REQUEST_ID = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const OTHER_REQUEST = '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e';

function renderDialog() {
  const onToken = vi.fn();
  const onCancel = vi.fn();
  render(
    <StepUpDialog action="approval.decide" targetId="f655be10" description="Approve the agent-mint request."
      onToken={onToken} onCancel={onCancel} />,
  );
  return { onToken, onCancel };
}

function land(outcome: 'complete' | 'refused', requestId = REQUEST_ID, code: string | null = null, origin = window.location.origin) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      origin, data: { type: STEP_UP_MESSAGE_TYPE, outcome, requestId, code },
    }));
  });
}

function bodyOf(path: string): Record<string, unknown> | undefined {
  const call = fetchCalls.find((entry) => entry.url.endsWith(path) && entry.options?.method === 'POST');
  return call ? JSON.parse(String(call.options?.body)) : undefined;
}

let popup: { location: { href: string }; close: ReturnType<typeof vi.fn> };
let openSpy: MockInstance<Parameters<Window['open']>, ReturnType<Window['open']>>;

beforeEach(() => {
  replies.clear();
  fetchCalls.length = 0;
  popup = { location: { href: '' }, close: vi.fn() };
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => popup as unknown as Window);
});

afterEach(() => {
  cleanup();
  stopKeptLanding();
  try { window.localStorage.clear(); } catch { /* no storage */ }
  openSpy.mockRestore();
  vi.clearAllMocks();
});

describe('a password Account', () => {
  test('sees the password form and no single sign-on control; the password arm posts as before', async () => {
    replies.set('/auth/step-up/methods', { body: { success: true, methods: ['password'], preferred: 'password' } });
    replies.set('/auth/step-up', { body: { success: true, stepUpToken: 'rhsu_password' } });
    const { onToken } = renderDialog();
    // Card f5a70765: nothing is offered before the board answers.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    await waitFor(() => expect(fetchCalls.some((call) => call.url.endsWith('/auth/step-up/methods'))).toBe(true));
    expect(screen.queryByRole('button', { name: /single sign-on/i })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('rhsu_password'));
    expect(bodyOf('/auth/step-up')).toEqual({ password: 'hunter2', action: 'approval.decide', targetId: 'f655be10' });
    expect(openSpy).not.toHaveBeenCalled();
  });

  // Card f5a70765 replaces "keeps the password form when the board cannot say
  // which method applies": a password ALONE was the one proof an
  // Identity-provider-only Account cannot give, so a failed read now offers
  // both, says why, and can ask again. The board decides which it accepts.
  test('when the board cannot say which method applies, both are offered, the reason is shown, and Check again asks once more', async () => {
    replies.set('/auth/step-up/methods', { status: 503, body: { code: 'SESSION_AUTH_UNAVAILABLE' } });
    renderDialog();
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByText(/could not check how your account confirms/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use single sign-on instead' })).toBeInTheDocument();
    replies.set('/auth/step-up/methods', { body: { success: true, methods: ['password'], preferred: 'password' } });
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /single sign-on/i })).not.toBeInTheDocument());
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByText(/could not check how your account confirms/)).not.toBeInTheDocument();
    expect(fetchCalls.filter((call) => call.url.endsWith('/auth/step-up/methods'))).toHaveLength(2);
  });

  test('an answer without a methods list is a failed read, not a password-only answer', async () => {
    replies.set('/auth/step-up/methods', { body: { success: true } });
    renderDialog();
    expect(await screen.findByText(/could not check how your account confirms/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use single sign-on instead' })).toBeInTheDocument();
  });
});

describe('an Identity-provider-only Account', () => {
  beforeEach(() => {
    replies.set('/auth/step-up/methods', { body: { success: true, methods: ['sso'], preferred: 'sso' } });
  });

  test('is not asked for a password: it confirms at the provider and the collected token is handed on', async () => {
    replies.set('/auth/step-up', { body: { success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize?prompt=login', requestId: REQUEST_ID } });
    replies.set('/auth/step-up/collect', { body: { success: true, method: 'sso', stepUpToken: 'rhsu_sso', action: 'approval.decide', targetId: 'f655be10' } });
    const { onToken } = renderDialog();
    const start = await screen.findByRole('button', { name: 'Continue with single sign-on' });
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    await userEvent.click(start);
    expect(openSpy).toHaveBeenCalledWith('', 'relayhall-step-up', expect.any(String));
    expect(bodyOf('/auth/step-up')).toEqual({ method: 'sso', action: 'approval.decide', targetId: 'f655be10' });
    await waitFor(() => expect(popup.location.href).toBe('https://idp.example.test/authorize?prompt=login'));
    expect(await screen.findByText(/Finish signing in in the window that opened/)).toBeInTheDocument();

    // Another request's landing, and a foreign origin, are ignored.
    land('complete', OTHER_REQUEST);
    land('complete', REQUEST_ID, null, 'https://evil.example.test');
    expect(fetchCalls.some((call) => call.url.endsWith('/auth/step-up/collect'))).toBe(false);

    land('complete');
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('rhsu_sso'));
    expect(bodyOf('/auth/step-up/collect')).toEqual({ requestId: REQUEST_ID });
  });

  test('a refused re-authentication renders the fixed sentence for its code and hands nothing on', async () => {
    replies.set('/auth/step-up', { body: { success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize', requestId: REQUEST_ID } });
    const { onToken } = renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
    await screen.findByText(/Finish signing in in the window that opened/);
    land('refused', REQUEST_ID, 'SSO_STEP_UP_SUBJECT_MISMATCH');
    expect(await screen.findByRole('alert')).toHaveTextContent('Your Identity provider signed in a different account');
    expect(onToken).not.toHaveBeenCalled();
    expect(fetchCalls.some((call) => call.url.endsWith('/auth/step-up/collect'))).toBe(false);
    // It can start again.
    expect(screen.getByRole('button', { name: 'Continue with single sign-on' })).toBeInTheDocument();
  });

  test('a proof the provider has not finished says so, and Check again collects it', async () => {
    replies.set('/auth/step-up', { body: { success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize', requestId: REQUEST_ID } });
    replies.set('/auth/step-up/collect', { status: 409, body: { code: 'STEP_UP_PENDING' } });
    const { onToken } = renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Still waiting for your Identity provider');
    replies.set('/auth/step-up/collect', { body: { success: true, stepUpToken: 'rhsu_late', action: 'approval.decide', targetId: 'f655be10' } });
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('rhsu_late'));
  });

  test('a token bound to some other act is not handed on', async () => {
    replies.set('/auth/step-up', { body: { success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize', requestId: REQUEST_ID } });
    replies.set('/auth/step-up/collect', { body: { success: true, stepUpToken: 'rhsu_other', action: 'warrant.create', targetId: 'f655be10' } });
    const { onToken } = renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
    await screen.findByText(/Finish signing in/);
    land('complete');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onToken).not.toHaveBeenCalled();
  });

  test('a blocked pop-up starts nothing at the board', async () => {
    openSpy.mockImplementation(() => null);
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Allow pop-ups for this site');
    expect(bodyOf('/auth/step-up')).toBeUndefined();
  });

  test('a non-https authorize URL is never handed to the window', async () => {
    replies.set('/auth/step-up', { body: { success: true, method: 'sso', authorizeUrl: 'javascript:alert(1)', requestId: REQUEST_ID } });
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(popup.location.href).toBe('');
    expect(popup.close).toHaveBeenCalled();
  });
});

const S6 = 'Your identity provider reused your current sign-in instead of asking you again, so this was not confirmed. If you signed in or confirmed something less than half a minute ago, wait a moment and try again.';
const S6_PAST = 'Your identity provider reused your current sign-in again instead of asking you, so this was not confirmed.';
const S6B = 'Your identity provider is not asking again for this site. An administrator can change how this board asks it; until then this act cannot be confirmed through single sign-on.';
const S7 = 'This act needs a stronger confirmation (for example your passkey) than the one used.';
const S8 = 'Your identity provider could not confirm it was you in the way this act needs.';
const SECOND_REQUEST = '2d2d2d2d-2d2d-4d2d-8d2d-2d2d2d2d2d2d';

function startPosts(): number {
  return fetchCalls.filter((call) => call.url.endsWith('/auth/step-up') && call.options?.method === 'POST').length;
}

function collectedIds(): unknown[] {
  return fetchCalls
    .filter((call) => call.url.endsWith('/auth/step-up/collect'))
    .map((call) => JSON.parse(String(call.options?.body)).requestId);
}

describe('card 7a99d63e: the dialog names the cause, and never says sign out', () => {
  beforeEach(() => {
    replies.set('/auth/step-up/methods', { body: { success: true, methods: ['sso'], preferred: 'sso' } });
    replies.set('/auth/step-up', { body: { success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize', requestId: REQUEST_ID } });
  });

  test.each([
    ['SSO_STEP_UP_TOO_WEAK', S7],
    ['SSO_STEP_UP_PROVIDER_DECLINED', S8],
  ])('%s renders its sentence and offers Try again', async (code, sentence) => {
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
    await screen.findByText(/Finish signing in/);
    land('refused', REQUEST_ID, code);
    expect((await screen.findByRole('alert')).textContent).toBe(sentence);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  test('a named cause from the start itself (the board refusing to begin) renders the same state', async () => {
    replies.set('/auth/step-up', { status: 400, body: { code: 'SSO_STEP_UP_PROVIDER_DECLINED' } });
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
    expect((await screen.findByRole('alert')).textContent).toBe(S8);
    expect(popup.close).toHaveBeenCalled();
  });

  test('no refusal state tells the person to sign out or log out', async () => {
    for (const code of ['SSO_STEP_UP_TOO_WEAK', 'SSO_STEP_UP_PROVIDER_DECLINED', 'SSO_ID_TOKEN_REFUSED', 'SSO_STEP_UP_SUBJECT_MISMATCH', 'UNKNOWN_CODE']) {
      cleanup();
      fetchCalls.length = 0;
      const { container } = render(
        <StepUpDialog action="approval.decide" targetId="f655be10" description="Approve the agent-mint request." onToken={vi.fn()} onCancel={vi.fn()} />,
      );
      await userEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
      await screen.findByText(/Finish signing in/);
      land('refused', REQUEST_ID, code);
      await screen.findByRole('alert');
      expect(container.textContent ?? '').not.toMatch(/sign[ -]?out|log[ -]?out/i);
    }
  });
});

/**
 * Owner ruling E444: a reused provider sign-in is waited out and asked again
 * by the dialog itself. Fake timers drive the countdown; `shouldAdvanceTime`
 * keeps the Testing Library's own waits moving.
 */
describe('E444: a reused sign-in counts down and asks again by itself', () => {
  const COUNTDOWN = 'Your identity provider reused your recent sign-in instead of asking you again. This dialog asks it again by itself as soon as it can.';
  const CAUTIOUS = 'Your identity provider does not say how long it reuses a sign-in, so this waits a cautious 35 seconds.';
  const THIRD_REQUEST = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
  const announced = () => document.querySelector('.sr-only[aria-live="polite"]')?.textContent ?? '';
  const timerText = () => screen.getByRole('timer').textContent;
  const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    replies.set('/auth/step-up/methods', { body: { success: true, methods: ['sso'], preferred: 'sso' } });
    replies.set('/auth/step-up', { body: { success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize', requestId: REQUEST_ID } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Start the dialog's first single sign-on request and wait for its window. */
  async function startFirst() {
    await user.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
    await screen.findByText(/Finish signing in in the window that opened/);
  }

  /** Hand the dialog a NEW request id for its next start. */
  function nextRequest(requestId: string) {
    replies.set('/auth/step-up', { body: { success: true, method: 'sso', authorizeUrl: `https://idp.example.test/authorize?r=${requestId.slice(0, 4)}`, requestId } });
  }

  test('a reuse shows a countdown, no refusal and no Try again; the countdown ends in ONE new request in the same window', async () => {
    const { onToken } = renderDialog();
    await startFirst();
    land('refused', REQUEST_ID, 'SSO_STEP_UP_NOT_FRESH');

    expect(await screen.findByText(COUNTDOWN)).toBeInTheDocument();
    expect(timerText()).toBe('Asking again in 35 seconds.');
    expect(screen.getByText(CAUTIOUS)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with single sign-on' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(announced()).toBe(`${COUNTDOWN} Asking again in 35 seconds.`);

    // The visible number ticks; the polite announcement does not.
    await advance(10_000);
    expect(timerText()).toBe('Asking again in 25 seconds.');
    expect(announced()).toBe(`${COUNTDOWN} Asking again in 35 seconds.`);
    expect(startPosts()).toBe(1);

    nextRequest(SECOND_REQUEST);
    replies.set('/auth/step-up/collect', { body: { success: true, stepUpToken: 'rhsu_after_wait', action: 'approval.decide', targetId: 'f655be10' } });
    await advance(25_000);
    await waitFor(() => expect(startPosts()).toBe(2));
    expect(announced()).toBe('Asking your identity provider again now.');
    // No kept landing answers on the channel here (route 1), so the window
    // reference, which was not cut off (route 2), is pointed at the provider
    // again; no new window is opened.
    await advance(RELAUNCH_ACK_MS);
    expect(openSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(popup.location.href).toBe('https://idp.example.test/authorize?r=2d2d'));
    await screen.findByText(/Finish signing in in the window that opened/);

    // Only the NEW request counts.
    land('complete', REQUEST_ID);
    expect(collectedIds()).toEqual([]);
    land('complete', SECOND_REQUEST);
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('rhsu_after_wait'));
    expect(collectedIds()).toEqual([SECOND_REQUEST]);

    // Nothing more is started once the countdown has done its one retry.
    await advance(120_000);
    expect(startPosts()).toBe(2);
  });

  test(`a second reuse restarts the countdown; past ${MAX_AUTOMATIC_RETRIES} automatic retries the normal message shows and nothing more starts`, async () => {
    const { onToken } = renderDialog();
    await startFirst();
    expect(MAX_AUTOMATIC_RETRIES).toBe(2);

    land('refused', REQUEST_ID, 'SSO_STEP_UP_NOT_FRESH');
    await screen.findByText(COUNTDOWN);
    nextRequest(SECOND_REQUEST);
    await advance(35_000);
    await waitFor(() => expect(startPosts()).toBe(2));
    await advance(RELAUNCH_ACK_MS);
    await screen.findByText(/Finish signing in/);

    land('refused', SECOND_REQUEST, 'SSO_STEP_UP_NOT_FRESH');
    await screen.findByText(COUNTDOWN);
    expect(timerText()).toBe('Asking again in 35 seconds.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    nextRequest(THIRD_REQUEST);
    await advance(35_000);
    await waitFor(() => expect(startPosts()).toBe(3));
    await advance(RELAUNCH_ACK_MS);
    await screen.findByText(/Finish signing in/);

    land('refused', THIRD_REQUEST, 'SSO_STEP_UP_NOT_FRESH');
    // Past the bound nothing tells the person to wait and try again beside "cannot be confirmed".
    const message = (await screen.findByRole('alert')).textContent ?? '';
    expect(message).toBe(`${S6_PAST} ${S6B}`);
    expect(message).not.toContain(S6);
    expect(message).not.toMatch(/wait a moment|try again/i);
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with single sign-on' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // The window kept for retries is let go.
    expect(popup.close).toHaveBeenCalled();
    await advance(300_000);
    expect(startPosts()).toBe(3);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(onToken).not.toHaveBeenCalled();
  });

  test('past the bound, an Account with a password is still offered it', async () => {
    replies.set('/auth/step-up/methods', { body: { success: true, methods: ['password', 'sso'], preferred: 'sso' } });
    renderDialog();
    await startFirst();
    // Every start is a NEW request (SU-16), so each reuse lands under its own id.
    const ids = [REQUEST_ID, SECOND_REQUEST, THIRD_REQUEST];
    for (let reuse = 0; reuse < MAX_AUTOMATIC_RETRIES; reuse += 1) {
      land('refused', ids[reuse], 'SSO_STEP_UP_NOT_FRESH');
      await screen.findByText(COUNTDOWN);
      // The countdown offers the password too.
      expect(screen.getByRole('button', { name: 'Use password instead' })).toBeInTheDocument();
      nextRequest(ids[reuse + 1]);
      await advance(35_000);
      await waitFor(() => expect(startPosts()).toBe(reuse + 2));
      await advance(RELAUNCH_ACK_MS);
      await screen.findByText(/Finish signing in/);
    }
    land('refused', ids[MAX_AUTOMATIC_RETRIES], 'SSO_STEP_UP_NOT_FRESH');
    expect(await screen.findByRole('alert')).toHaveTextContent(S6B);
    expect(screen.getByRole('button', { name: 'Use password instead' })).toBeInTheDocument();
  });

  test('Cancel during the countdown stops it: nothing more is started and the kept window is closed', async () => {
    const { onCancel, onToken } = renderDialog();
    await startFirst();
    land('refused', REQUEST_ID, 'SSO_STEP_UP_NOT_FRESH');
    await screen.findByText(COUNTDOWN);
    await advance(5_000);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalled();
    // The parent here keeps the dialog mounted: the countdown itself has stopped.
    await advance(120_000);
    expect(startPosts()).toBe(1);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(onToken).not.toHaveBeenCalled();
  });

  test('the close (X) button and a press on the backdrop stop the countdown too', async () => {
    for (const how of ['x', 'backdrop'] as const) {
      cleanup();
      fetchCalls.length = 0;
      const { onCancel } = renderDialog();
      await startFirst();
      land('refused', REQUEST_ID, 'SSO_STEP_UP_NOT_FRESH');
      await screen.findByText(COUNTDOWN);
      if (how === 'x') await user.click(screen.getByRole('button', { name: 'Cancel step-up' }));
      else await user.click(document.querySelector('.stepup-backdrop') as HTMLElement);
      expect(onCancel).toHaveBeenCalledTimes(1);
      await advance(60_000);
      expect(startPosts()).toBe(1);
    }
  });

  test('a dialog closed by its caller during the countdown starts nothing more', async () => {
    const { unmount } = render(
      <StepUpDialog action="approval.decide" targetId="f655be10" description="Approve the agent-mint request." onToken={vi.fn()} onCancel={vi.fn()} />,
    );
    await startFirst();
    land('refused', REQUEST_ID, 'SSO_STEP_UP_NOT_FRESH');
    await screen.findByText(COUNTDOWN);
    unmount();
    expect(popup.close).toHaveBeenCalled();
    await advance(60_000);
    expect(startPosts()).toBe(1);
  });

  test('a refusal that carries the reused sign-in\'s auth_time and the provider\'s window waits only as long as needed, and says no cautious figure', async () => {
    renderDialog();
    await startFirst();
    const authTime = Math.floor(Date.now() / 1000) - 20;
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: STEP_UP_MESSAGE_TYPE, outcome: 'refused', requestId: REQUEST_ID, code: 'SSO_STEP_UP_NOT_FRESH', authTime, reuseWindowSeconds: 30 },
      }));
    });
    await screen.findByText(COUNTDOWN);
    // auth_time + 30 s window + 2 s margin, from 20 s after auth_time: 12 s (13 at a second's edge).
    expect(timerText()).toMatch(/^Asking again in 1[23] seconds\.$/);
    expect(screen.queryByText(/cautious/)).not.toBeInTheDocument();
    await advance(14_000);
    await waitFor(() => expect(startPosts()).toBe(2));
  });

  test('other refusals are unchanged: no countdown, and nothing starts by itself', async () => {
    renderDialog();
    await startFirst();
    land('refused', REQUEST_ID, 'SSO_STEP_UP_TOO_WEAK');
    expect((await screen.findByRole('alert')).textContent).toBe(S7);
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await advance(120_000);
    expect(startPosts()).toBe(1);
  });

  test('when no kept landing answers, the kept window is gone and the browser blocks a new one, the person is asked for one click, not refused', async () => {
    renderDialog();
    await startFirst();
    land('refused', REQUEST_ID, 'SSO_STEP_UP_NOT_FRESH');
    await screen.findByText(COUNTDOWN);
    (popup as unknown as { closed: boolean }).closed = true;
    openSpy.mockImplementation(() => null);
    nextRequest(SECOND_REQUEST);
    await advance(35_000);
    await waitFor(() => expect(startPosts()).toBe(2));
    await advance(RELAUNCH_ACK_MS);
    expect(await screen.findByText(/did not let this page open the sign-in window by itself/, { selector: 'p.stepup-description' })).toBeInTheDocument();
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(announced()).toMatch(/did not let this page open the sign-in window by itself/);

    // The person's click opens it, as yet another NEW request.
    const fresh = { location: { href: '' }, close: vi.fn(), focus: vi.fn() };
    openSpy.mockImplementation(() => fresh as unknown as Window);
    nextRequest(THIRD_REQUEST);
    await user.click(screen.getByRole('button', { name: 'Continue with single sign-on' }));
    await waitFor(() => expect(startPosts()).toBe(3));
    await waitFor(() => expect(fresh.location.href).toBe('https://idp.example.test/authorize?r=3c3c'));
  });

  test('focus stays in the dialog when the countdown starts and when it ends', async () => {
    renderDialog();
    await startFirst();
    screen.getByRole('button', { name: 'Check again' }).focus();
    land('refused', REQUEST_ID, 'SSO_STEP_UP_NOT_FRESH');
    await screen.findByText(COUNTDOWN);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    nextRequest(SECOND_REQUEST);
    await advance(35_000);
    await screen.findByText(/Finish signing in/);
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
  });

  test('the countdown is axe-clean, and the third reuse\'s message too', async () => {
    const { container } = render(
      <StepUpDialog action="approval.decide" targetId="f655be10" description="Approve the agent-mint request." onToken={vi.fn()} onCancel={vi.fn()} />,
    );
    // The colour-contrast rule needs a layout engine jsdom does not have; the
    // pairing matrix owns that, per Theme, in scripts/check-design-contrast.py.
    const audit = async () => (await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] }))
      .violations.map((violation) => violation.id);
    await startFirst();
    const ids = [REQUEST_ID, SECOND_REQUEST, THIRD_REQUEST];
    land('refused', ids[0], 'SSO_STEP_UP_NOT_FRESH');
    await screen.findByText(COUNTDOWN);
    expect(await audit()).toEqual([]);
    for (let retry = 0; retry < MAX_AUTOMATIC_RETRIES; retry += 1) {
      if (retry > 0) land('refused', ids[retry], 'SSO_STEP_UP_NOT_FRESH');
      nextRequest(ids[retry + 1]);
      await advance(35_000);
      await waitFor(() => expect(startPosts()).toBe(retry + 2));
      await advance(RELAUNCH_ACK_MS);
      await screen.findByText(/Finish signing in/);
    }
    land('refused', ids[MAX_AUTOMATIC_RETRIES], 'SSO_STEP_UP_NOT_FRESH');
    await screen.findByText(/is not asking again for this site/);
    expect(await audit()).toEqual([]);
  });

  /**
   * Round-2 review blocker: the board's cross-origin opener policy cuts the
   * kept window off from the dialog on its way back from the provider. These
   * tests MODEL THE CUT: the dialog's reference reads closed, the landing's
   * opener is null, window.open is blocked, and the landing (the real
   * `completeStepUpLanding`, in a window object of its own) reaches the
   * dialog only through the BroadcastChannel.
   */
  function landingWindow(search: string) {
    const doc = document.implementation.createHTMLDocument('landing');
    doc.body.innerHTML = '<div id="root"></div>';
    const hrefs: string[] = [];
    const location = {
      search,
      origin: window.location.origin,
      get href() { return hrefs[hrefs.length - 1] ?? ''; },
      set href(value: string) { hrefs.push(value); },
    };
    const landing = { location, opener: null, document: doc, localStorage: window.localStorage, close: vi.fn() };
    return { landing: landing as unknown as Window, hrefs, close: landing.close };
  }

  /** The cut, after the first start: nothing but the channel reaches the kept landing. */
  async function cutAfterFirstReuse() {
    await startFirst();
    (popup as unknown as { closed: boolean }).closed = true;
    openSpy.mockImplementation(() => null);
    const kept = landingWindow(`?step_up=refused&request=${REQUEST_ID}&code=SSO_STEP_UP_NOT_FRESH`);
    act(() => { expect(completeStepUpLanding(kept.landing)).toBe(true); });
    await screen.findByText(COUNTDOWN);
    return kept;
  }

  /** Every relaunch message posted on the channel, as the kept landing would hear it. */
  function listenToChannel() {
    const heard: Array<Record<string, unknown>> = [];
    const channel = new BroadcastChannel(STEP_UP_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      if (event.data?.type === STEP_UP_RELAUNCH_TYPE) heard.push(event.data);
    };
    return { heard, close: () => channel.close() };
  }

  test('THE CUT: with the kept window unreachable and window.open blocked, the countdown still ends in a NEW request and the landing moves itself, with no click', async () => {
    const { onToken } = renderDialog();
    const kept = await cutAfterFirstReuse();
    expect(kept.close).not.toHaveBeenCalled();
    expect(timerText()).toBe('Asking again in 35 seconds.');

    nextRequest(SECOND_REQUEST);
    replies.set('/auth/step-up/collect', { body: { success: true, stepUpToken: 'rhsu_after_cut', action: 'approval.decide', targetId: 'f655be10' } });
    await advance(35_000);
    // A NEW request (SU-16), asked for by the dialog itself.
    await waitFor(() => expect(startPosts()).toBe(2));
    // The kept landing navigated ITSELF to the new request's URL, once.
    await waitFor(() => expect(kept.hrefs).toEqual(['https://idp.example.test/authorize?r=2d2d']));
    // No click: only the person's first one ever opened a window; the cut
    // reference was not used; no "one click" notice and no refusal.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(popup.location.href).toBe('https://idp.example.test/authorize');
    await advance(RELAUNCH_ACK_MS);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/did not let this page open the sign-in window/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(kept.close).not.toHaveBeenCalled();
    await screen.findByText(/Finish signing in in the window that opened/);

    // The NEW request's landing also comes back through the channel only, and is collected.
    const done = landingWindow(`?step_up=complete&request=${SECOND_REQUEST}`);
    act(() => { completeStepUpLanding(done.landing); });
    await waitFor(() => expect(onToken).toHaveBeenCalledWith('rhsu_after_cut'));
    expect(collectedIds()).toEqual([SECOND_REQUEST]);
  });

  test('THE CUT, twice: a second reuse is kept and relaunched the same way, and the third is the normal message and releases its landing', async () => {
    renderDialog();
    const first = await cutAfterFirstReuse();
    nextRequest(SECOND_REQUEST);
    await advance(35_000);
    await waitFor(() => expect(first.hrefs).toEqual(['https://idp.example.test/authorize?r=2d2d']));

    const second = landingWindow(`?step_up=refused&request=${SECOND_REQUEST}&code=SSO_STEP_UP_NOT_FRESH`);
    act(() => { completeStepUpLanding(second.landing); });
    await waitFor(() => expect(timerText()).toBe('Asking again in 35 seconds.'));
    nextRequest(THIRD_REQUEST);
    await advance(35_000);
    await waitFor(() => expect(second.hrefs).toEqual(['https://idp.example.test/authorize?r=3c3c']));
    expect(startPosts()).toBe(3);

    const third = landingWindow(`?step_up=refused&request=${THIRD_REQUEST}&code=SSO_STEP_UP_NOT_FRESH`);
    act(() => { completeStepUpLanding(third.landing); });
    expect((await screen.findByRole('alert')).textContent).toBe(`${S6_PAST} ${S6B}`);
    // Past the bound the kept landing is told to close itself.
    await waitFor(() => expect(third.close).toHaveBeenCalled());
    expect(third.hrefs).toEqual([]);
    await advance(300_000);
    expect(startPosts()).toBe(3);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  test.each(['Cancel', 'unmount', 'a new binding'] as const)('THE CUT: %s releases the kept landing, which closes itself, and starts nothing', async (how) => {
    const onCancel = vi.fn();
    const { rerender, unmount } = render(
      <StepUpDialog action="approval.decide" targetId="f655be10" description="Approve the agent-mint request." onToken={vi.fn()} onCancel={onCancel} />,
    );
    const kept = await cutAfterFirstReuse();
    await advance(5_000);
    if (how === 'Cancel') await user.click(screen.getByRole('button', { name: 'Cancel' }));
    else if (how === 'unmount') unmount();
    else rerender(<StepUpDialog action="approval.decide" targetId="another-target" description="Approve the agent-mint request." onToken={vi.fn()} onCancel={onCancel} />);
    await waitFor(() => expect(kept.close).toHaveBeenCalledTimes(1));
    await advance(120_000);
    expect(startPosts()).toBe(1);
    expect(kept.hrefs).toEqual([]);
    expect(onCancel).toHaveBeenCalledTimes(how === 'Cancel' ? 1 : 0);
  });

  test(`one landing delivered on BOTH paths (channel and opener) counts once: the bound really is ${MAX_AUTOMATIC_RETRIES} automatic retries`, async () => {
    renderDialog();
    await startFirst();
    const ids = [REQUEST_ID, SECOND_REQUEST, THIRD_REQUEST];
    const channel = new BroadcastChannel(STEP_UP_CHANNEL);
    /** The landing's two deliveries, both arriving before the dialog re-renders. */
    const landTwice = async (requestId: string) => {
      const data = { type: STEP_UP_MESSAGE_TYPE, outcome: 'refused', requestId, code: 'SSO_STEP_UP_NOT_FRESH' };
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data }));
        channel.postMessage(data);
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
    };
    try {
      for (let reuse = 0; reuse < MAX_AUTOMATIC_RETRIES; reuse += 1) {
        await landTwice(ids[reuse]);
        // Still counting down: the double delivery did not use up the bound.
        expect(await screen.findByRole('timer')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        nextRequest(ids[reuse + 1]);
        await advance(35_000);
        await waitFor(() => expect(startPosts()).toBe(reuse + 2));
        await advance(RELAUNCH_ACK_MS);
        await screen.findByText(/Finish signing in/);
      }
      await landTwice(ids[MAX_AUTOMATIC_RETRIES]);
      expect((await screen.findByRole('alert')).textContent).toBe(`${S6_PAST} ${S6B}`);
      expect(startPosts()).toBe(MAX_AUTOMATIC_RETRIES + 1);
    } finally {
      channel.close();
    }
  });

  test('generation guard: Cancel while the person\'s own start waits for the board stores no window and no request', async () => {
    const onCancel = vi.fn();
    render(<StepUpDialog action="approval.decide" targetId="f655be10" description="Approve the agent-mint request." onToken={vi.fn()} onCancel={onCancel} />);
    const { authenticatedFetch } = await import('../../utils/auth');
    let answer: () => void = () => undefined;
    const start = await screen.findByRole('button', { name: 'Continue with single sign-on' });
    vi.mocked(authenticatedFetch).mockImplementationOnce(async (url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });
      await new Promise<void>((resolve) => { answer = resolve; });
      return { ok: true, status: 200, json: async () => ({ success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize?late=1', requestId: REQUEST_ID }) } as Response;
    });
    await user.click(start);
    await waitFor(() => expect(startPosts()).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await act(async () => { answer(); });
    // The blank window opened for that start is closed and never pointed anywhere.
    await waitFor(() => expect(popup.close).toHaveBeenCalled());
    expect(popup.location.href).toBe('');
    expect(screen.queryByText(/Finish signing in/)).not.toBeInTheDocument();
    // The landing of that request would not be collected either.
    land('complete', REQUEST_ID);
    expect(collectedIds()).toEqual([]);
  });

  test('generation guard: a switch while the automatic retry waits for the board stores nothing and relaunches nothing', async () => {
    replies.set('/auth/step-up/methods', { body: { success: true, methods: ['password', 'sso'], preferred: 'sso' } });
    renderDialog();
    const kept = await cutAfterFirstReuse();
    const listener = listenToChannel();
    const { authenticatedFetch } = await import('../../utils/auth');
    let answer: () => void = () => undefined;
    vi.mocked(authenticatedFetch).mockImplementationOnce(async (url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });
      await new Promise<void>((resolve) => { answer = resolve; });
      return { ok: true, status: 200, json: async () => ({ success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize?late=1', requestId: SECOND_REQUEST }) } as Response;
    });
    try {
      await advance(35_000);
      await waitFor(() => expect(startPosts()).toBe(2));
      await user.click(screen.getByRole('button', { name: 'Use password instead' }));
      await act(async () => { answer(); });
      await advance(RELAUNCH_ACK_MS * 2);
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      expect(screen.queryByText(/Finish signing in/)).not.toBeInTheDocument();
      // The switch released the kept landing; the late answer relaunched nothing.
      await waitFor(() => expect(kept.close).toHaveBeenCalledTimes(1));
      expect(kept.hrefs).toEqual([]);
      expect(listener.heard.map((message) => message.action)).toEqual(['release']);
      expect(openSpy).toHaveBeenCalledTimes(1);
    } finally {
      listener.close();
    }
  });

  test('the countdown has no motion to reduce: nothing in it animates or transitions', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/access/StepUpDialog.css'), 'utf8');
    expect(css).not.toMatch(/animation|transition|@keyframes/);
  });
});

describe('an Account with both proofs, and one with neither', () => {
  test('both: the preferred method shows first and the other is one click away', async () => {
    replies.set('/auth/step-up/methods', { body: { success: true, methods: ['password', 'sso'], preferred: 'sso' } });
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Use password instead' }));
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use single sign-on instead' }));
    expect(screen.getByRole('button', { name: 'Continue with single sign-on' })).toBeInTheDocument();
  });

  test('neither: the dialog says so instead of asking for a password', async () => {
    replies.set('/auth/step-up/methods', { body: { success: true, methods: [], preferred: null } });
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent('no password and no linked Identity provider');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});

describe('card f5a70765: every challenge renders the methods the board names for THAT challenge', () => {
  const methodsReads = () => fetchCalls.filter((call) => call.url.endsWith('/auth/step-up/methods'));
  const props = () => ({ description: 'Confirm the act.', onToken: vi.fn(), onCancel: vi.fn() });

  test('the methods are read without the browser cache', async () => {
    replies.set('/auth/step-up/methods', { body: { success: true, methods: ['sso'], preferred: 'sso' } });
    renderDialog();
    await screen.findByRole('button', { name: 'Continue with single sign-on' });
    expect(methodsReads()).toHaveLength(1);
    expect(methodsReads()[0].options?.cache).toBe('no-store');
  });

  test('a mounted dialog handed a NEW binding asks the board again and shows its new answer, not the first one', async () => {
    replies.set('/auth/step-up/methods', { body: { success: true, methods: ['sso'], preferred: 'sso' } });
    const shared = props();
    const { rerender } = render(<StepUpDialog action="knowledge.shared-writer.add" targetId="first-account" {...shared} />);
    await screen.findByRole('button', { name: 'Continue with single sign-on' });

    replies.set('/auth/step-up/methods', { body: { success: true, methods: ['password'], preferred: 'password' } });
    rerender(<StepUpDialog action="knowledge.shared-writer.add" targetId="second-account" {...shared} />);
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /single sign-on/i })).not.toBeInTheDocument();
    expect(methodsReads()).toHaveLength(2);
  });

  test('a reused provider sign-in counted for one binding is not carried into the next (E444: nor its countdown)', async () => {
    replies.set('/auth/step-up/methods', { body: { success: true, methods: ['sso'], preferred: 'sso' } });
    replies.set('/auth/step-up', { body: { success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize', requestId: REQUEST_ID } });
    const shared = props();
    const { rerender } = render(<StepUpDialog action="approval.decide" targetId="first" {...shared} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
    await screen.findByText(/Finish signing in/);
    land('refused', REQUEST_ID, 'SSO_STEP_UP_NOT_FRESH');
    expect(await screen.findByRole('timer')).toBeInTheDocument();
    rerender(<StepUpDialog action="approval.decide" targetId="second" {...shared} />);
    expect(await screen.findByRole('button', { name: 'Continue with single sign-on' })).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The window kept for the first binding's retry is let go.
    expect(popup.close).toHaveBeenCalled();
  });

  test('the methods a step-up challenge advertised are what a failed read falls back to', async () => {
    replies.set('/auth/step-up/methods', { status: 429, body: { error: 'Too Many Requests' } });
    render(<StepUpDialog action="approval.decide" targetId="f655be10" advertisedMethods={['sso']} {...props()} />);
    expect(await screen.findByRole('button', { name: 'Continue with single sign-on' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByText(/could not check how your account confirms/)).toBeInTheDocument();
  });

  test('the waiting state and the failed-read state are axe-clean', async () => {
    let release: () => void = () => undefined;
    const { authenticatedFetch } = await import('../../utils/auth');
    vi.mocked(authenticatedFetch).mockImplementationOnce(() => new Promise<Response>((resolve) => {
      release = () => resolve({ ok: false, status: 503, json: async () => ({}) } as Response);
    }));
    const { container } = render(<StepUpDialog action="approval.decide" targetId="f655be10" {...props()} />);
    expect(await screen.findByText(/Checking how your account confirms/)).toBeInTheDocument();
    const audit = async () => (await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] }))
      .violations.map((violation) => violation.id);
    expect(await audit()).toEqual([]);
    await act(async () => { release(); });
    expect(await screen.findByText(/could not check how your account confirms/)).toBeInTheDocument();
    expect(await audit()).toEqual([]);
  });
});
