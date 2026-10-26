// @vitest-environment jsdom
/**
 * Workflow setup with a new Warrant answers the step-up challenge - card
 * 72b8fb97 (design SU-33).
 *
 * Confirming a setup that creates a Warrant carries a single-use token bound
 * to (warrant.create, holder). If it no longer counts when the setup arrives,
 * the board answers `403 STEP_UP_REQUIRED` with the SU-14 `stepUp` object
 * and nothing was committed (the setup rolls back). These pin, through the
 * real dialog: it opens again for exactly that binding, and the setup is sent
 * ONE more time with the same Idempotency-Key and the same body but the new
 * token; a cancelled second dialog sends nothing more.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BlueprintSetup } from './BlueprintSetup';
import { STEP_UP_RETRY_DESCRIPTION } from '../access/useStepUpRetry';

const fetchMock = vi.fn();
vi.mock('../../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const HOLDER = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const plan = {
  instantiationId: 'instance', projectId: 'project', warrantId: null, requiresStepUp: true,
  createWarrant: { holderPrincipalId: HOLDER, ceilingProfileId: PROFILE, expiresAt: '2026-11-01T12:00:00.000Z' },
  grants: [],
  tasks: [{ id: 'task', revision: 'a'.repeat(32), title: 'Investigate', phaseId: 'phase', executionProfile: { serviceId: 'service', descriptorVersion: 2, options: {} } }],
  allParked: true, assignmentOnly: true, confirmationHash: 'b'.repeat(64),
};
const receipt = { success: true, instantiationId: 'instance', taskIds: ['task'], warrantId: 'w', assigned: true, armed: false };
type Reply = { status: number; body: unknown };
const CHALLENGE: Reply = {
  status: 403,
  body: {
    success: false, code: 'STEP_UP_REQUIRED', error: 'This act requires a live single-use step-up token',
    stepUp: { error: 'insufficient_user_authentication', action: 'warrant.create', targetId: HOLDER, max_age: 0, methods: ['password'] },
  },
};
let setupReplies: Reply[] = [];
let minted = 0;

beforeEach(() => {
  setupReplies = [];
  minted = 0;
  vi.stubGlobal('crypto', { randomUUID: () => 'setup-confirmation-0000001' });
  fetchMock.mockImplementation(async (url: string) => {
    const reply = (value: Reply) => ({ ok: value.status < 400, status: value.status, json: async () => value.body });
    if (url.endsWith('/auth/step-up/methods')) return reply({ status: 200, body: { success: true, methods: ['password'], preferred: 'password' } });
    if (url.endsWith('/auth/step-up')) {
      minted += 1;
      return reply({ status: 200, body: { success: true, stepUpToken: `rhsu_token_${minted}` } });
    }
    if (url.endsWith('/access-profiles')) return reply({ status: 200, body: { success: true, profiles: [{ id: PROFILE, name: 'Reporter' }] } });
    if (url.endsWith('/principals')) return reply({ status: 200, body: { success: true, principals: [{ id: HOLDER, handle: 'workflow-connector', kind: 'service' }] } });
    if (url.endsWith('/setup/preview')) return reply({ status: 200, body: { success: true, plan } });
    if (url.endsWith('/setup')) return reply(setupReplies.shift() ?? { status: 200, body: receipt });
    return reply({ status: 200, body: { success: true } });
  });
});
afterEach(() => { cleanup(); fetchMock.mockReset(); vi.unstubAllGlobals(); });

const setups = () => fetchMock.mock.calls
  .filter(([url]) => String(url).endsWith('/setup'))
  .map(([, options]) => ({ headers: (options as RequestInit).headers, body: JSON.parse(String((options as RequestInit).body)) }));
const proofs = () => fetchMock.mock.calls
  .filter(([url]) => String(url).endsWith('/auth/step-up'))
  .map(([, options]) => JSON.parse(String((options as RequestInit).body)));

async function confirmInDialog() {
  const dialog = within(await screen.findByRole('dialog'));
  fireEvent.change(await dialog.findByLabelText('Password'), { target: { value: 'test-password' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Continue' }));
}

async function confirmNewWarrantSetup() {
  render(<BlueprintSetup instantiationId="instance" />);
  fireEvent.change(screen.getByLabelText('Workflow authority'), { target: { value: 'new' } });
  await screen.findByRole('option', { name: 'workflow-connector' });
  await screen.findByRole('option', { name: 'Reporter' });
  fireEvent.change(screen.getByLabelText('Workflow Connector or service Account'), { target: { value: HOLDER } });
  fireEvent.change(screen.getByLabelText('Published access profile'), { target: { value: PROFILE } });
  fireEvent.change(screen.getByLabelText('Warrant expiry (UTC)'), { target: { value: '2026-11-01T12:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview execution setup' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm execution setup' }));
  await confirmInDialog();
}

test('STEP_UP_REQUIRED reopens the dialog for (warrant.create, holder) and the setup is sent once more: same key, same body, new token', async () => {
  setupReplies = [CHALLENGE];
  await confirmNewWarrantSetup();
  expect(await screen.findByText(STEP_UP_RETRY_DESCRIPTION)).toBeInTheDocument();
  expect(setups()).toHaveLength(1);
  await confirmInDialog();
  expect(await screen.findByText('Execution was assigned. No Tasks were armed.')).toBeInTheDocument();
  const [first, second] = setups();
  expect(setups()).toHaveLength(2);
  expect(first.body).toMatchObject({ createWarrant: plan.createWarrant, stepUpToken: 'rhsu_token_1', confirmationHash: plan.confirmationHash });
  expect(second.body).toEqual({ ...first.body, stepUpToken: 'rhsu_token_2' });
  expect(second.headers).toEqual(first.headers);
  expect(first.headers).toEqual({ 'Content-Type': 'application/json', 'Idempotency-Key': 'setup-confirmation-0000001' });
  expect(proofs()[1]).toMatchObject({ action: 'warrant.create', targetId: HOLDER });
});

test('cancelling the second dialog sends nothing more and shows the refusal by name', async () => {
  setupReplies = [CHALLENGE];
  await confirmNewWarrantSetup();
  // The FIRST dialog is still closing when the answer arrives: wait for the
  // second ask by its own sentence, then act inside it.
  await screen.findByText(STEP_UP_RETRY_DESCRIPTION);
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('STEP_UP_REQUIRED'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(setups()).toHaveLength(1);
});
