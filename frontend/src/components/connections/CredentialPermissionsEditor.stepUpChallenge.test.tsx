// @vitest-environment jsdom
/**
 * The credential permissions edit answers the step-up challenge - card
 * 72b8fb97 (design SU-33).
 *
 * A widening edit carries a single-use token bound to (credential.edit, id).
 * If it no longer counts when the PATCH arrives, the board answers `403
 * STEP_UP_REQUIRED` with the SU-14 `stepUp` object. These pin, through the
 * real dialog: it opens again for exactly that binding, and the PATCH is sent
 * ONE more time with the same body and the new token; a cancelled second
 * dialog sends nothing more.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CredentialPermissionsEditor } from './CredentialPermissionsEditor';
import { STEP_UP_RETRY_DESCRIPTION } from '../access/useStepUpRetry';
import type { ConnectionCredential } from '../../types/connections';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const credential: ConnectionCredential = { id: 'credential-1', keyId: 'public-key', label: null, scopes: ['tasks:read'], transport: 'mcp', createdAt: null, expiresAt: null, revokedAt: null, lastUsedAt: null, graceUntil: null, revealCount: 0, revealable: true, state: 'live' };
type Reply = { status: number; body: unknown };
const CHALLENGE: Reply = {
  status: 403,
  body: {
    error: 'Refused', code: 'STEP_UP_REQUIRED', message: 'This act requires a live single-use step-up token',
    stepUp: { error: 'insufficient_user_authentication', action: 'credential.edit', targetId: credential.id, max_age: 0, methods: ['password'] },
  },
};
let patchReplies: Reply[] = [];
let minted = 0;
const onChanged = vi.fn();

beforeEach(() => {
  patchReplies = [];
  minted = 0;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const reply = (value: Reply) => ({ ok: value.status < 400, status: value.status, json: async () => value.body });
    if (url.endsWith('/auth/step-up/methods')) return reply({ status: 200, body: { success: true, methods: ['password'], preferred: 'password' } });
    if (url.endsWith('/auth/step-up')) {
      minted += 1;
      return reply({ status: 200, body: { success: true, stepUpToken: `rhsu_token_${minted}` } });
    }
    if (options?.method === 'PATCH') return reply(patchReplies.shift() ?? { status: 200, body: { success: true } });
    return reply({ status: 200, body: { success: true } });
  });
});
afterEach(() => { cleanup(); fetchMock.mockReset(); onChanged.mockReset(); });

const patches = () => fetchMock.mock.calls
  .filter(([, options]) => (options as RequestInit | undefined)?.method === 'PATCH')
  .map(([url, options]) => ({ url: String(url), body: JSON.parse(String((options as RequestInit).body)) }));
const proofs = () => fetchMock.mock.calls
  .filter(([url]) => String(url).endsWith('/auth/step-up'))
  .map(([, options]) => JSON.parse(String((options as RequestInit).body)));

async function confirmInDialog() {
  const dialog = within(await screen.findByRole('dialog'));
  fireEvent.change(await dialog.findByLabelText('Password'), { target: { value: 'test-password' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Continue' }));
}

async function widenAndConfirm() {
  render(<CredentialPermissionsEditor credential={credential} delegableScopes={['tasks:read', 'tasks:write']} mayLoosenTransport={false} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'tasks:write' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }));
  await confirmInDialog();
}

test('STEP_UP_REQUIRED reopens the dialog for (credential.edit, this credential) and the PATCH is sent once more: same body, new token', async () => {
  patchReplies = [CHALLENGE];
  await widenAndConfirm();
  expect(await screen.findByText(STEP_UP_RETRY_DESCRIPTION)).toBeInTheDocument();
  expect(patches()).toHaveLength(1);
  await confirmInDialog();
  expect(await screen.findByText('Permissions saved on the existing credential.')).toBeInTheDocument();
  expect(onChanged).toHaveBeenCalledTimes(1);
  const [first, second] = patches();
  expect(patches()).toHaveLength(2);
  expect(second.url).toBe('/api/credentials/credential-1');
  expect(first.body).toMatchObject({ scopes: ['tasks:read', 'tasks:write'], transport: 'mcp', stepUpToken: 'rhsu_token_1', lifetime: { choice: 'keep' } });
  expect(second.body).toEqual({ ...first.body, stepUpToken: 'rhsu_token_2' });
  expect(proofs()[1]).toMatchObject({ action: 'credential.edit', targetId: credential.id });
});

test('cancelling the second dialog sends nothing more and shows the refusal', async () => {
  patchReplies = [CHALLENGE];
  await widenAndConfirm();
  // The FIRST dialog is still closing when the answer arrives: wait for the
  // second ask by its own sentence, then act inside it.
  await screen.findByText(STEP_UP_RETRY_DESCRIPTION);
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This act requires a live single-use step-up token'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(patches()).toHaveLength(1);
  expect(onChanged).not.toHaveBeenCalled();
});
