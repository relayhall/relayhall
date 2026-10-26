// @vitest-environment jsdom
/**
 * The grant edit answers the step-up challenge - card 72b8fb97 (design SU-33).
 *
 * A widening edit carries a single-use step-up token. If the token no longer
 * counts when the edit arrives, the board answers `403 STEP_UP_REQUIRED` with
 * `stepUp: { action: "grant.edit", targetId }`. These pin, through the real
 * page and the real dialog: the dialog opens again for exactly that binding,
 * and the edit is sent ONE more time with the same body and the new token; a
 * cancelled second dialog and a plain 403 send nothing more.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GrantsPage } from './GrantsPage';
import { STEP_UP_RETRY_DESCRIPTION } from '../components/access/useStepUpRetry';

const authenticatedFetch = vi.fn();
const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();
vi.mock('../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args) }));
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

const principal = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', handle: 'tester', displayName: 'Focused Tester', kind: 'human', status: 'active', role: 'viewer' };
const grant = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', granteeType: 'principal', granteeId: principal.id, resourceType: 'phase', resourceId: null, verb: 'read', grantedByPrincipalId: null, expiresAt: null, createdAt: '2026-08-13T12:00:00.000Z' };

type Reply = { status: number; body: unknown };
const CHALLENGE: Reply = {
  status: 403,
  body: {
    success: false, error: 'Refused', code: 'STEP_UP_REQUIRED', message: 'This act requires a live single-use step-up token',
    stepUp: { error: 'insufficient_user_authentication', action: 'grant.edit', targetId: grant.id, max_age: 0, methods: ['password'] },
  },
};
let patchReplies: Reply[] = [];
let minted = 0;

beforeEach(() => {
  vi.clearAllMocks();
  patchReplies = [];
  minted = 0;
  useMyPrincipal.mockReturnValue({ me: { role: 'orchestrator' }, scopes: ['root'], loading: false });
  usePrincipals.mockReturnValue({ principals: [principal], loading: false, failed: false, reload: vi.fn() });
  authenticatedFetch.mockImplementation(async (url: string, options?: RequestInit) => {
    const reply = (value: Reply) => ({ ok: value.status < 400, status: value.status, json: async () => value.body });
    if (url.endsWith('/auth/step-up/methods')) return reply({ status: 200, body: { success: true, methods: ['password'], preferred: 'password' } });
    if (url.endsWith('/auth/step-up')) {
      minted += 1;
      return reply({ status: 200, body: { success: true, stepUpToken: `rhsu_token_${minted}` } });
    }
    if (options?.method === 'PATCH') return reply(patchReplies.shift() ?? { status: 200, body: { success: true, edit: { direction: 'widening' } } });
    return reply({ status: 200, body: { success: true, grants: [grant] } });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const patches = () => authenticatedFetch.mock.calls
  .filter(([, options]) => (options as RequestInit | undefined)?.method === 'PATCH')
  .map(([url, options]) => ({ url: String(url), body: JSON.parse(String((options as RequestInit).body)) }));
const proofs = () => authenticatedFetch.mock.calls
  .filter(([url]) => String(url).endsWith('/auth/step-up'))
  .map(([, options]) => JSON.parse(String((options as RequestInit).body)));

async function confirmInDialog() {
  const dialog = within(await screen.findByRole('dialog'));
  fireEvent.change(await dialog.findByLabelText('Password'), { target: { value: 'test-password' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Continue' }));
}

async function widenAndConfirm() {
  render(<GrantsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Edit read phase grant/ }));
  fireEvent.change(screen.getByLabelText('Edit permission'), { target: { value: 'write' } });
  fireEvent.change(screen.getByLabelText('Lifetime for this edit'), { target: { value: 'keep' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save grant edit' }));
  await confirmInDialog();
}

test('STEP_UP_REQUIRED reopens the dialog for (grant.edit, this grant) and the edit is sent once more: same body, new token', async () => {
  patchReplies = [CHALLENGE];
  await widenAndConfirm();
  expect(await screen.findByText(STEP_UP_RETRY_DESCRIPTION)).toBeInTheDocument();
  expect(patches()).toHaveLength(1);
  await confirmInDialog();
  expect(await screen.findByText(/Grant edit applied \(widening\)/)).toBeInTheDocument();
  const [first, second] = patches();
  expect(patches()).toHaveLength(2);
  expect(second.url).toBe(first.url);
  expect(first.body.stepUpToken).toBe('rhsu_token_1');
  expect(second.body).toEqual({ ...first.body, stepUpToken: 'rhsu_token_2' });
  // The second proof is for exactly the challenge's binding.
  expect(proofs()).toHaveLength(2);
  expect(proofs()[1]).toMatchObject({ action: 'grant.edit', targetId: grant.id });
});

test('cancelling the second dialog sends nothing more and shows the refusal; a plain 403 is never retried', async () => {
  patchReplies = [CHALLENGE];
  await widenAndConfirm();
  // The FIRST dialog is still closing when the answer arrives: wait for the
  // second ask by its own sentence, then act inside it.
  await screen.findByText(STEP_UP_RETRY_DESCRIPTION);
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('STEP_UP_REQUIRED');
  expect(patches()).toHaveLength(1);
  cleanup();
  authenticatedFetch.mockClear();
  patchReplies = [{ status: 403, body: { success: false, code: 'STEP_UP_REQUIRED', message: 'no challenge' } }];
  await widenAndConfirm();
  expect(await screen.findByRole('alert')).toHaveTextContent('STEP_UP_REQUIRED');
  expect(screen.queryByText(STEP_UP_RETRY_DESCRIPTION)).not.toBeInTheDocument();
  expect(patches()).toHaveLength(1);
});
