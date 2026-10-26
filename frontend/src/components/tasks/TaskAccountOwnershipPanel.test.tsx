// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskAccountOwnershipPanel } from './TaskAccountOwnershipPanel';
import { authenticatedFetch } from '../../utils/auth';
vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../principals/principalDirectory', () => ({
  usePrincipalDirectory: () => ({ loading: false, directory: new Map([
    ['new-human', {id: 'new-human', kind: 'human', status: 'active', handle: 'river', displayName: 'River'}],
    ['agent', {id: 'agent', kind: 'agent', status: 'active', handle: 'agent'}],
  ]) }),
  PrincipalName: ({id}: {id: string}) => <span>{id}</span>,
}));
const request = vi.mocked(authenticatedFetch);
const revision = '2026-10-08 04:01:02.123456+00';
const snapshot = {taskId: 'task-one', accountOwnerPrincipalId: null, explicitAccountOwnerPrincipalId: null, updatedAt: revision};
function response(data: unknown, status = 200) { return {ok: status < 400, status, json: async () => data} as Response; }
async function fill() {
  fireEvent.click(screen.getByRole('button', {name: 'Load current account owner'}));
  await screen.findByText('Current account owner:', {exact: false});
  fireEvent.change(screen.getByLabelText('New account owner'), {target: {value: 'new-human'}});
  fireEvent.change(screen.getByLabelText('Reason for ownership change'), {target: {value: 'Restore verified ownership'}});
}
afterEach(cleanup);
beforeEach(() => { request.mockReset(); });
describe('Task account ownership', () => {
  it('sends the exact read revision and null owner, then keeps the transfer receipt without requiring continued Task access', async () => {
    request.mockResolvedValueOnce(response({success: true, ownership: snapshot})).mockResolvedValueOnce(response({success: true, ownership: {...snapshot, accountOwnerPrincipalId: 'new-human', changed: true}}));
    render(<TaskAccountOwnershipPanel taskId="task-one" />);
    await fill();
    expect(screen.queryByRole('option', {name: 'agent (agent)'})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Change account owner'}));
    await screen.findByText(/Account ownership changed to/);
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({accountOwnerPrincipalId: 'new-human', expectedAccountOwnerPrincipalId: null, expectedUpdatedAt: revision, reason: 'Restore verified ownership'});
    expect(screen.queryByRole('button', {name: 'Change account owner'})).toBeNull();
  });
  it('names a Group owner from the server\'s ownerDisplayName, never from the person directory (AZ-A12 clause 12)', async () => {
    request.mockResolvedValueOnce(response({success: true, ownership: {...snapshot, accountOwnerPrincipalId: 'group-one',
      ownerKind: 'group', ownerDisplayName: 'Platform team'}}));
    render(<TaskAccountOwnershipPanel taskId="task-one" />);
    fireEvent.click(screen.getByRole('button', {name: 'Load current account owner'}));
    const line = await screen.findByText('Current account owner:', {exact: false});
    expect(line.textContent).toBe('Current account owner: Platform team (Group) (inherited from Project)');
  });
  it.each([403, 412, 503])('does not retry status %s or refresh preconditions automatically', async status => {
    request.mockResolvedValueOnce(response({success: true, ownership: snapshot})).mockResolvedValueOnce(response({success: false, message: 'Read current state'}, status));
    render(<TaskAccountOwnershipPanel taskId="task-one" />); await fill();
    fireEvent.click(screen.getByRole('button', {name: 'Change account owner'}));
    await screen.findByRole('alert');
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', {name: 'Change account owner'})).toBeNull();
  });
  it('does not carry a pending snapshot across a keyed Task navigation', async () => {
    let resolve!: (response: Response) => void;
    request.mockReturnValueOnce(new Promise(r => {resolve = r;}));
    const view = render(<TaskAccountOwnershipPanel key="one" taskId="task-one" />);
    fireEvent.click(screen.getByRole('button', {name: 'Load current account owner'}));
    view.rerender(<TaskAccountOwnershipPanel key="two" taskId="task-two" />);
    resolve(response({success: true, ownership: snapshot}));
    await waitFor(() => expect(screen.queryByLabelText('New account owner')).toBeNull());
    expect(request).toHaveBeenCalledTimes(1);
  });
});
