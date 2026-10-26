// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();
vi.mock('../../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

const calls: Array<{ url: string; options?: RequestInit }> = [];
let approvals: unknown[] = [];
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    const body = url.includes('/auth/step-up')
      ? { success: true, stepUpToken: 'rhsu_edit_token' }
      : url.includes('/approvals?')
        ? { success: true, approvals, viewer: { isRoot: true, isAdministrator: true } }
        : { success: true, approval: approvals[0], events: [] };
    return { ok: true, status: 200, json: async () => body };
  }),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

import { ApprovalsPage } from '../../pages/ApprovalsPage';
import { formatInstantUtc } from '../../utils/dateFormat';

const ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TASK = '44444444-4444-4444-8444-444444444444';
const request = {
  id: ID, kind: 'authority-edit', status: 'pending', requesterPrincipalId: 'connector-id',
  requesterHandle: 'connector-editor', targetTaskId: null, targetTaskTitle: null,
  requestedScopes: [], requestedRules: [], approvedScopes: null, approvedRules: null,
  lapseReason: null, denialReason: null, requestedAt: '2026-10-12T10:00:00.000Z',
  pendingExpiresAt: '2026-10-19T10:00:00.000Z', collectExpiresAt: null, decidable: true,
  accessRequest: {
    granteePrincipalId: 'account-id', granteeHandle: 'owner', reason: 'Expand the connector for its task.',
    requestedExpiresAt: null, approvedExpiresAt: null, relatedTaskId: TASK, relatedTaskTitle: 'Phase work',
    relatedPhaseId: null, relatedPhaseName: null, relatedProjectId: null, relatedProjectTitle: null,
    createdGrantIds: [],
  },
  authorityEdit: {
    objectType: 'credential', objectKindLabel: 'Connector configuration', objectId: 'credential-id',
    diff: [{ field: 'scopes', before: ['tasks:read'], after: ['tasks:read', 'phases:write'] }],
    lifetime: null,
  },
};

beforeEach(() => {
  approvals = [request];
  useMyPrincipal.mockReturnValue({ me: { id: 'root-id', role: 'orchestrator', handle: 'root' }, scopes: ['root'], loading: false });
  usePrincipals.mockReturnValue({ principals: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); calls.length = 0; });

test('authority edit names its object and diff, requires a lifetime before step-up, and sends it on approval', async () => {
  render(<MemoryRouter initialEntries={['/approvals?kind=authority-edit']}><ApprovalsPage /></MemoryRouter>);
  const row = (await screen.findByText('connector-editor')).closest('li') as HTMLElement;
  expect(within(row).getByText('Connector configuration')).toBeInTheDocument();
  await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
  expect(within(row).getByText('scopes')).toBeInTheDocument();
  expect(within(row).getByText(/\["tasks:read"\] → \["tasks:read","phases:write"\]/)).toBeInTheDocument();
  const approve = within(row).getByRole('button', { name: 'Approve' });
  expect(approve).toBeDisabled();
  expect(calls.some(({ url }) => url.includes('/auth/step-up'))).toBe(false);
  await userEvent.selectOptions(within(row).getByLabelText('Lifetime for this edit'), 'until-task');
  expect(approve).toBeEnabled();
  await userEvent.click(approve);
  await userEvent.type(await screen.findByLabelText('Password'), 'test-password');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(calls.some(({ url }) => url.includes(`/approvals/${ID}/approve`))).toBe(true));
  const sent = calls.find(({ url }) => url.includes(`/approvals/${ID}/approve`));
  expect(JSON.parse(String(sent?.options?.body))).toEqual({
    stepUpToken: 'rhsu_edit_token', lifetime: { choice: 'until-task', taskId: TASK },
  });
});

/** A whole-minute UTC instant `hours` ahead, as the hub's "(UTC)" datetime input takes it. */
function utcInput(hours: number): string {
  return new Date(Math.ceil((Date.now() + hours * 3_600_000) / 60_000) * 60_000).toISOString().slice(0, 16);
}

async function approveWith(row: HTMLElement, choose: () => Promise<void>): Promise<unknown> {
  await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
  await choose();
  await userEvent.click(within(row).getByRole('button', { name: 'Approve' }));
  await userEvent.type(await screen.findByLabelText('Password'), 'test-password');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(calls.some(({ url }) => url.includes(`/approvals/${ID}/approve`))).toBe(true));
  return JSON.parse(String(calls.find(({ url }) => url.includes(`/approvals/${ID}/approve`))?.options?.body));
}

const UNRELATED = { ...request, accessRequest: { ...request.accessRequest, relatedTaskId: null, relatedTaskTitle: null } };

// Card 0e07c0c7: clause 6j offers EVERY decider both lifetimes. A request with
// no related task offered "Keep" alone, so the shortest lifetime the hub
// offered was keep, stored as {choice: keep, revertAt: null}.
test('card 0e07c0c7 shortest: without a related task the hub offers "Until a date" first and sends exactly that revertAt', async () => {
  approvals = [UNRELATED];
  render(<MemoryRouter initialEntries={['/approvals?kind=authority-edit']}><ApprovalsPage /></MemoryRouter>);
  const row = (await screen.findByText('connector-editor')).closest('li') as HTMLElement;
  const at = utcInput(1);
  const body = await approveWith(row, async () => {
    const select = within(row).getByLabelText('Lifetime for this edit') as HTMLSelectElement;
    expect([...select.options].map((option) => [option.value, option.text])).toEqual([
      ['', 'Choose a lifetime'], ['until-task', 'Until a date'], ['keep', 'Keep (until narrowed)'],
    ]);
    await userEvent.selectOptions(select, 'until-task');
    // The date is required when no task is related: nothing to approve without it.
    expect(within(row).getByRole('button', { name: 'Approve' })).toBeDisabled();
    fireEvent.change(within(row).getByLabelText(/Revert at \(UTC\)/), { target: { value: at } });
    expect(within(row).getByRole('button', { name: 'Approve' })).toBeEnabled();
  });
  expect(body).toEqual({ stepUpToken: 'rhsu_edit_token', lifetime: { choice: 'until-task', revertAt: new Date(`${at}Z`).toISOString() } });
});

test('card 0e07c0c7: a past revert date is refused before step-up', async () => {
  approvals = [UNRELATED];
  render(<MemoryRouter initialEntries={['/approvals?kind=authority-edit']}><ApprovalsPage /></MemoryRouter>);
  const row = (await screen.findByText('connector-editor')).closest('li') as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
  await userEvent.selectOptions(within(row).getByLabelText('Lifetime for this edit'), 'until-task');
  fireEvent.change(within(row).getByLabelText(/Revert at \(UTC\)/), { target: { value: utcInput(-1) } });
  expect(within(row).getByRole('button', { name: 'Approve' })).toBeDisabled();
  expect(within(row).getByRole('alert')).toHaveTextContent(/future/);
  expect(within(row).getByLabelText(/Revert at \(UTC\)/)).toHaveAttribute('aria-invalid', 'true');
  expect(calls.some(({ url }) => url.includes('/auth/step-up'))).toBe(false);
});

test('card 0e07c0c7 middle: with a related task, until-task with a date sends the task and the date', async () => {
  render(<MemoryRouter initialEntries={['/approvals?kind=authority-edit']}><ApprovalsPage /></MemoryRouter>);
  const row = (await screen.findByText('connector-editor')).closest('li') as HTMLElement;
  const at = utcInput(24);
  const body = await approveWith(row, async () => {
    const select = within(row).getByLabelText('Lifetime for this edit') as HTMLSelectElement;
    expect([...select.options].map((option) => option.text)).toEqual([
      'Choose a lifetime', 'Until this task ends, or a date', 'Keep (until narrowed)',
    ]);
    await userEvent.selectOptions(select, 'until-task');
    fireEvent.change(within(row).getByLabelText(/Revert at \(UTC\)/), { target: { value: at } });
  });
  expect(body).toEqual({ stepUpToken: 'rhsu_edit_token',
    lifetime: { choice: 'until-task', taskId: TASK, revertAt: new Date(`${at}Z`).toISOString() } });
});

test('card 0e07c0c7 keep: "Keep (until narrowed)" is offered as such and sends keep', async () => {
  approvals = [UNRELATED];
  render(<MemoryRouter initialEntries={['/approvals?kind=authority-edit']}><ApprovalsPage /></MemoryRouter>);
  const row = (await screen.findByText('connector-editor')).closest('li') as HTMLElement;
  const body = await approveWith(row, async () => {
    await userEvent.selectOptions(within(row).getByLabelText('Lifetime for this edit'), 'keep');
    expect(within(row).queryByLabelText(/Revert at \(UTC\)/)).toBeNull();
  });
  expect(body).toEqual({ stepUpToken: 'rhsu_edit_token', lifetime: { choice: 'keep' } });
});

// Round-1 review B1: the hint says the authority stays until the date and is
// removed AT it; the step-up text keeps "with lifetime until <date>".
test('card 0e07c0c7 hint, no related task: the authority is removed at the chosen date, and step-up names it', async () => {
  approvals = [UNRELATED];
  render(<MemoryRouter initialEntries={['/approvals?kind=authority-edit']}><ApprovalsPage /></MemoryRouter>);
  const row = (await screen.findByText('connector-editor')).closest('li') as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
  await userEvent.selectOptions(within(row).getByLabelText('Lifetime for this edit'), 'until-task');
  const at = utcInput(2);
  const date = formatInstantUtc(new Date(`${at}Z`).toISOString());
  fireEvent.change(within(row).getByLabelText(/Revert at \(UTC\)/), { target: { value: at } });
  const hint = within(row).getByText(/^The added authority is removed/);
  expect(hint).toHaveTextContent(`The added authority is removed at ${date}.`);
  expect(hint).not.toHaveTextContent(/until/);
  expect(within(row).getByLabelText(/Revert at \(UTC\)/)).toHaveAttribute('aria-describedby', hint.id);
  await userEvent.click(within(row).getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText(/^Approve the edit to/)).toHaveTextContent(`with lifetime until ${date}.`);
});

test('card 0e07c0c7 hint, related task: removed when the task ends, or at the date, whichever comes first', async () => {
  render(<MemoryRouter initialEntries={['/approvals?kind=authority-edit']}><ApprovalsPage /></MemoryRouter>);
  const row = (await screen.findByText('connector-editor')).closest('li') as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
  await userEvent.selectOptions(within(row).getByLabelText('Lifetime for this edit'), 'until-task');
  expect(within(row).getByText(/^The added authority is removed/)).toHaveTextContent('The added authority is removed when this task ends.');
  const at = utcInput(24);
  const date = formatInstantUtc(new Date(`${at}Z`).toISOString());
  fireEvent.change(within(row).getByLabelText(/Revert at \(UTC\)/), { target: { value: at } });
  expect(within(row).getByText(/^The added authority is removed/)).toHaveTextContent(
    `The added authority is removed when this task ends or at ${date}, whichever comes first.`);
  await userEvent.click(within(row).getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText(/^Approve the edit to/)).toHaveTextContent(
    `with lifetime until this task ends or ${date}, whichever comes first.`);
});

test('card 0e07c0c7: the missing-date alert waits for the decider to leave the field, then is tied to the input', async () => {
  approvals = [UNRELATED];
  render(<MemoryRouter initialEntries={['/approvals?kind=authority-edit']}><ApprovalsPage /></MemoryRouter>);
  const row = (await screen.findByText('connector-editor')).closest('li') as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
  await userEvent.selectOptions(within(row).getByLabelText('Lifetime for this edit'), 'until-task');
  const input = within(row).getByLabelText(/Revert at \(UTC\)/);
  expect(within(row).queryByRole('alert')).toBeNull();
  expect(input).not.toHaveAttribute('aria-invalid');
  fireEvent.blur(input);
  const alert = within(row).getByRole('alert');
  expect(alert).toHaveTextContent('Set the date the added authority is removed.');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAttribute('aria-describedby', alert.id);
});

test('a decided authority edit shows the chosen lifetime with its revert date', async () => {
  approvals = [{ ...UNRELATED, status: 'approved',
    authorityEdit: { ...request.authorityEdit, lifetime: { choice: 'until-task', label: 'Until this task ends', taskId: null,
      revertAt: '2026-10-16T10:00:00.000Z', revertedAt: null, due: false } } }];
  render(<MemoryRouter initialEntries={['/approvals?status=decided']}><ApprovalsPage /></MemoryRouter>);
  const row = (await screen.findByText('connector-editor')).closest('li') as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
  expect(within(row).getByText(/Chosen lifetime: Until this task ends; reverts at .*2026.*10:00/)).toBeInTheDocument();
  expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull();
});

test('the reviewed authority edit diff and lifetime choice are accessible', async () => {
  const { container } = render(<MemoryRouter initialEntries={['/approvals?kind=authority-edit']}><ApprovalsPage /></MemoryRouter>);
  const row = (await screen.findByText('connector-editor')).closest('li') as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  expect(results.violations.map(({ id, nodes }) => `${id}: ${nodes.map(({ html }) => html).join(', ')}`)).toEqual([]);
});
