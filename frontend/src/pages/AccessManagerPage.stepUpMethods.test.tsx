// @vitest-environment jsdom
/**
 * Two step-up acts on ONE mounted Access manager, no reload (card f5a70765).
 *
 * The owner added herself to the shared-area writer list and confirmed
 * through single sign-on; the SECOND add on the same page, without a reload,
 * showed "Confirm it's you" with only a Password field, and after a reload
 * the same act went through single sign-on again. Her Account holds no
 * password: the Password field was a way to confirm she could not use.
 *
 * What these pin, through the real page, panel and dialog:
 *  - every act asks the board which proofs THIS Account can give, afresh
 *    (never from the browser cache), and renders exactly that: the second
 *    act of an Identity-provider-only Account offers single sign-on, not a
 *    password;
 *  - while the board has not answered, no proof is offered yet (the dialog
 *    used to show its Password form as a placeholder, which is what a slow
 *    second answer looked like);
 *  - when the board cannot answer (a rate-limited or failed read), the
 *    person is told so and offered BOTH proofs plus "Check again", never a
 *    password alone; the board decides which one it accepts;
 *  - a password Account still gets the password path on every act, and no
 *    single sign-on control when the board names the password alone.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { STEP_UP_MESSAGE_TYPE } from '../utils/stepUpLanding';

const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

const OWNER = 'aaaaaaaa-0000-4000-8000-00000000000a';
const GRACE = 'bbbbbbbb-0000-4000-8000-00000000000b';
const SOURCE = { id: 'cccccccc-0000-4000-8000-00000000000c', slug: 'brain', name: 'Brain' };
const REQUEST_IDS = ['0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f01', '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f02'];

type Reply = { status: number; body: unknown };
/** One reply per `GET /auth/step-up/methods`, in order; a function is a reply that waits. */
let methodsReplies: Array<Reply | (() => Promise<Reply>)> = [];
let writers: Array<Record<string, unknown>> = [];
let ssoStarts = 0;
const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];

const json = (reply: Reply) => ({ ok: reply.status < 400, status: reply.status, json: async () => reply.body });

vi.mock('../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, options?: RequestInit) => {
    fetchCalls.push({ url, options });
    if (url.endsWith('/auth/step-up/methods')) {
      const next = methodsReplies.shift();
      if (!next) return json({ status: 500, body: { code: 'UNEXPECTED_METHODS_READ' } });
      return json(typeof next === 'function' ? await next() : next);
    }
    if (url.endsWith('/auth/step-up/collect')) {
      const { requestId } = JSON.parse(String(options?.body));
      const index = REQUEST_IDS.indexOf(requestId);
      const targetId = index === 0 ? OWNER : GRACE;
      return json({ status: 200, body: { success: true, method: 'sso', stepUpToken: `rhsu_sso_${index}`, action: 'knowledge.shared-writer.add', targetId } });
    }
    if (url.endsWith('/auth/step-up') && options?.method === 'POST') {
      const sent = JSON.parse(String(options.body));
      if (sent.method === 'sso') {
        const requestId = REQUEST_IDS[ssoStarts];
        ssoStarts += 1;
        return json({ status: 200, body: { success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize?prompt=login', requestId } });
      }
      return json({ status: 200, body: { success: true, stepUpToken: `rhsu_password_${sent.targetId}` } });
    }
    if (url.includes('/knowledge-shared-writers')) {
      if (options?.method === 'POST') {
        const sent = JSON.parse(String(options.body));
        writers = [...writers, {
          accountId: sent.accountId, label: sent.accountId === OWNER ? 'Owner' : 'Grace Hopper', active: true,
          addedBy: { id: OWNER, label: 'Owner' }, addedAt: '2026-10-18T10:25:00.000Z', reason: sent.reason,
          expiresAt: null, approvalId: null, origin: 'direct',
        }];
        return json({ status: 200, body: { success: true } });
      }
      return json({ status: 200, body: { success: true, source: SOURCE, scope: 'organisation', writers } });
    }
    return json({ status: 200, body: { success: true } });
  }),
  auth: { getToken: () => null, clearToken: () => {} },
}));

import { AccessManagerPage } from './AccessManagerPage';

const person = (id: string, handle: string, displayName: string) => ({
  id, handle, displayName, kind: 'human', status: 'active', role: 'user', parentPrincipalId: null,
});

let popup: { location: { href: string }; close: ReturnType<typeof vi.fn> };
let openSpy: MockInstance<Parameters<Window['open']>, ReturnType<Window['open']>>;

beforeEach(() => {
  methodsReplies = [];
  writers = [];
  ssoStarts = 0;
  fetchCalls.length = 0;
  useMyPrincipal.mockReturnValue({
    me: { id: OWNER, handle: 'owner', kind: 'human', role: 'orchestrator' },
    scopes: ['root'],
    loading: false,
  });
  usePrincipals.mockReturnValue({
    principals: [person(OWNER, 'owner', 'Owner'), person(GRACE, 'grace', 'Grace Hopper')],
    reload: vi.fn(),
  });
  popup = { location: { href: '' }, close: vi.fn() };
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => popup as unknown as Window);
});

afterEach(() => {
  cleanup();
  openSpy.mockRestore();
  vi.clearAllMocks();
});

const SSO_ONLY: Reply = { status: 200, body: { success: true, methods: ['sso'], preferred: 'sso' } };
const PASSWORD_ONLY: Reply = { status: 200, body: { success: true, methods: ['password'], preferred: 'password' } };

function methodsReads(): Array<{ url: string; options?: RequestInit }> {
  return fetchCalls.filter((call) => call.url.endsWith('/auth/step-up/methods'));
}

/** Choose the Account, give a reason, press "Add with step-up"; returns the dialog. */
async function askToAdd(user: ReturnType<typeof userEvent.setup>, accountId: string): Promise<HTMLElement> {
  const form = await screen.findByRole('form', { name: 'Add a shared-area writer' });
  await user.selectOptions(within(form).getByLabelText('Account'), accountId);
  await user.type(within(form).getByLabelText('Why can this Account write the shared area?'), 'Keeps the shared runbooks current for everyone.');
  await user.click(within(form).getByRole('button', { name: 'Add with step-up' }));
  return screen.findByRole('dialog');
}

/** The add's outcome notice, naming the Account the way the panel labels it. */
async function added(name: string) {
  const sentence = new RegExp(`^${name}( \\(\\w+\\))? can now write the shared area of Brain\\.$`);
  expect((await screen.findAllByText(sentence)).length).toBeGreaterThan(0);
}

function land(requestId: string) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: STEP_UP_MESSAGE_TYPE, outcome: 'complete', requestId, code: null },
    }));
  });
}

/** Confirm the open dialog through single sign-on, end to end. */
async function confirmWithSso(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, requestId: string) {
  await user.click(await within(dialog).findByRole('button', { name: 'Continue with single sign-on' }));
  await within(dialog).findByText(/Finish signing in in the window that opened/);
  land(requestId);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('an Identity-provider-only Account, two acts on one mounted page', () => {
  test('the SECOND act offers single sign-on again, and reads the methods afresh for it', async () => {
    methodsReplies = [SSO_ONLY, SSO_ONLY];
    const user = userEvent.setup();
    render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);

    const first = await askToAdd(user, OWNER);
    await within(first).findByRole('button', { name: 'Continue with single sign-on' });
    expect(within(first).queryByLabelText('Password')).not.toBeInTheDocument();
    await confirmWithSso(user, first, REQUEST_IDS[0]);
    await added('Owner');

    const second = await askToAdd(user, GRACE);
    expect(await within(second).findByRole('button', { name: 'Continue with single sign-on' })).toBeInTheDocument();
    expect(within(second).queryByLabelText('Password')).not.toBeInTheDocument();
    // One read per act, each one bypassing the browser cache.
    expect(methodsReads()).toHaveLength(2);
    for (const read of methodsReads()) expect(read.options?.cache).toBe('no-store');
    await confirmWithSso(user, second, REQUEST_IDS[1]);
    await added('Grace Hopper');
  });

  test('a slow answer for the second act shows no Password field while it waits, then single sign-on', async () => {
    let release: (reply: Reply) => void = () => undefined;
    methodsReplies = [SSO_ONLY, () => new Promise<Reply>((resolve) => { release = resolve; })];
    const user = userEvent.setup();
    render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);

    await confirmWithSso(user, await askToAdd(user, OWNER), REQUEST_IDS[0]);
    await added('Owner');

    const second = await askToAdd(user, GRACE);
    await waitFor(() => expect(methodsReads()).toHaveLength(2));
    expect(within(second).getByText(/Checking how your account confirms/)).toBeInTheDocument();
    expect(within(second).queryByLabelText('Password')).not.toBeInTheDocument();
    await act(async () => { release(SSO_ONLY); });
    expect(await within(second).findByRole('button', { name: 'Continue with single sign-on' })).toBeInTheDocument();
    expect(within(second).queryByLabelText('Password')).not.toBeInTheDocument();
  });

  test.each([
    ['rate-limited', { status: 429, body: { error: 'Too Many Requests' } }],
    ['unavailable', { status: 503, body: { code: 'SESSION_AUTH_UNAVAILABLE' } }],
  ])('a second answer that is %s still offers single sign-on, says why, and can check again', async (_label, refusal) => {
    methodsReplies = [SSO_ONLY, refusal as Reply, SSO_ONLY];
    const user = userEvent.setup();
    render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);

    await confirmWithSso(user, await askToAdd(user, OWNER), REQUEST_IDS[0]);
    await added('Owner');

    const second = await askToAdd(user, GRACE);
    expect(await within(second).findByText(/could not check how your account confirms/)).toBeInTheDocument();
    expect(within(second).getByRole('button', { name: 'Use single sign-on instead' })).toBeInTheDocument();
    // "Check again" asks the board once more and then offers what it says.
    await user.click(within(second).getByRole('button', { name: 'Check again' }));
    expect(await within(second).findByRole('button', { name: 'Continue with single sign-on' })).toBeInTheDocument();
    expect(within(second).queryByLabelText('Password')).not.toBeInTheDocument();
    expect(methodsReads()).toHaveLength(3);
  });
});

describe('a password Account, two acts on one mounted page', () => {
  test('every act gets the password path and no single sign-on control', async () => {
    methodsReplies = [PASSWORD_ONLY, PASSWORD_ONLY];
    const user = userEvent.setup();
    render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);

    for (const [index, accountId] of [OWNER, GRACE].entries()) {
      const dialog = await askToAdd(user, accountId);
      const password = await within(dialog).findByLabelText('Password');
      await waitFor(() => expect(methodsReads()).toHaveLength(index + 1));
      expect(within(dialog).queryByRole('button', { name: /single sign-on/i })).not.toBeInTheDocument();
      await user.type(password, 'correct horse');
      await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
    await added('Grace Hopper');
    expect(openSpy).not.toHaveBeenCalled();
  });
});
