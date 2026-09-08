// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BlueprintSetup } from './BlueprintSetup';
import { authenticatedFetch } from '../../utils/auth';
vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
const fetcher = vi.mocked(authenticatedFetch);
const warrant = '11111111-1111-4111-8111-111111111111';
const plan = { instantiationId: 'instance', projectId: 'project', warrantId: warrant,
  tasks: [{ id: 'task', revision: 'a'.repeat(32), title: 'Investigate', phaseId: 'phase', executionProfile: { serviceId: 'service', descriptorVersion: 2, options: { title: '<script>literal</script>' } } }],
  allParked: true, assignmentOnly: true, confirmationHash: 'b'.repeat(64) };
const receipt = { instantiationId: 'instance', taskIds: ['task'], warrantId: warrant, assigned: true, armed: false };
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body } as Response);
const random = vi.fn();
let apply: (options?: RequestInit) => Promise<Response>;
beforeEach(() => {
  vi.clearAllMocks(); random.mockReturnValue('setup-confirmation-0000001'); vi.stubGlobal('crypto', { randomUUID: random });
  apply = async () => json(receipt);
  fetcher.mockImplementation(async (url, options) => String(url).endsWith('/preview') ? json({ plan }) : apply(options));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function preview() {
  render(<BlueprintSetup instantiationId="instance" />);
  fireEvent.change(screen.getByLabelText('Existing Warrant ID'), { target: { value: warrant } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview execution setup' }));
  await screen.findByRole('button', { name: 'Confirm execution setup' });
}
const writes = () => fetcher.mock.calls.filter(([url]) => !String(url).endsWith('/preview'));
test('only explicit confirmation submits the displayed fixed set and never arms work', async () => {
  await preview(); expect(random).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  expect(screen.getByText('<script>literal</script>')).toBeTruthy(); expect(document.querySelector('script')).toBeNull();
  const button = screen.getByRole('button', { name: 'Confirm execution setup' });
  fireEvent.click(button); fireEvent.click(button);
  await screen.findByText('Execution was assigned. No Tasks were armed.');
  expect(writes()).toHaveLength(1); expect(random).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ warrantId: warrant, tasks: [{ id: 'task', revision: 'a'.repeat(32) }], confirmationHash: 'b'.repeat(64) });
  expect(writes()[0][1]?.headers).toEqual({ 'Content-Type': 'application/json', 'Idempotency-Key': 'setup-confirmation-0000001' });
});
test('uncertain setup blocks edits and retries byte-identical body and key', async () => {
  let count = 0; apply = async () => { if (++count === 1) throw new Error('lost'); return json(receipt); };
  await preview(); fireEvent.click(screen.getByRole('button', { name: 'Confirm execution setup' }));
  await screen.findByText(/Setup may have committed/);
  expect(screen.queryByRole('button', { name: 'Change Warrant' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Preview setup again' })).toBeNull();
  expect(screen.getByRole('alert')).toBe(document.activeElement);
  fireEvent.click(screen.getByRole('button', { name: 'Retry same setup' }));
  await screen.findByText('Execution was assigned. No Tasks were armed.');
  expect(writes()).toHaveLength(2); expect(writes()[1][1]).toEqual(writes()[0][1]); expect(random).toHaveBeenCalledTimes(1);
});
test('definite revision refusal requires a fresh preview and confirmation before a new request', async () => {
  apply = async () => json({ code: 'BLUEPRINT_SETUP_CHANGED', error: 'Review setup again' }, 409);
  await preview(); fireEvent.click(screen.getByRole('button', { name: 'Confirm execution setup' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Preview setup again' }));
  expect(screen.queryByRole('button', { name: 'Confirm execution setup' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Preview execution setup' })).toBeTruthy();
  expect(writes()).toHaveLength(1);
});
test('changing the Warrant invalidates the prior displayed confirmation', async () => {
  await preview(); fireEvent.click(screen.getByRole('button', { name: 'Change Warrant' }));
  expect(screen.queryByRole('heading', { name: 'Confirm this exact Task set' })).toBeNull();
  expect(writes()).toHaveLength(0); expect(random).not.toHaveBeenCalled();
});
test('preview failure exposes a focused refusal and no confirmation', async () => {
  fetcher.mockResolvedValue(json({ code: 'BLUEPRINT_SETUP_NOT_FOUND', error: 'Workflow setup not found' }, 404));
  render(<BlueprintSetup instantiationId="instance" />);
  fireEvent.change(screen.getByLabelText('Existing Warrant ID'), { target: { value: warrant } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview execution setup' }));
  await screen.findByRole('alert'); await waitFor(() => expect(screen.getByRole('alert')).toBe(document.activeElement));
  expect(screen.queryByRole('button', { name: 'Confirm execution setup' })).toBeNull(); expect(random).not.toHaveBeenCalled();
});
test('a late preview after unmount cannot create a confirmation in another instance', async () => {
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = render(<BlueprintSetup instantiationId="old" />);
  fireEvent.change(screen.getByLabelText('Existing Warrant ID'), { target: { value: warrant } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview execution setup' })); old.unmount();
  render(<BlueprintSetup instantiationId="new" />); finish(json({ plan }));
  await waitFor(() => expect(screen.getByLabelText('Existing Warrant ID')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Confirm execution setup' })).toBeNull(); expect(writes()).toHaveLength(0);
});
