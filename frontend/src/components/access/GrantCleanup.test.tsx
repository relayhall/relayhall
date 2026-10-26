// @vitest-environment jsdom
/**
 * Owner ruling E413: "Clean up redundant grants" on the Access page. These pin,
 * through the real component and the real step-up dialog: the ids are read
 * from the CURRENT filter one list page at a time and dry-run at most 500 per
 * call (nothing written); the counts by verdict and a sample are shown before
 * anything is revoked; every real batch asks its OWN step-up, bound to
 * ('grant.bulk_revoke', the hash the dry run answered for exactly the ids that
 * batch revokes), and sends only those ids; a rolled-back batch says so; a
 * failure stops with no automatic retry; a cancelled step-up runs nothing.
 *
 * Owner ruling E444, at the place it was met: step-up stays per batch, and
 * when batch 2's Identity provider reuses batch 1's sign-in the dialog counts
 * down and asks again by itself, and the batch runs with the fresh token.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GrantCleanup } from './GrantCleanup';
import { STEP_UP_MESSAGE_TYPE } from '../../utils/stepUpLanding';

const authenticatedFetch = vi.fn();
vi.mock('../../utils/auth', () => ({ authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args) }));

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => id(from + i));
type Reply = { status: number; body: unknown };
const reply = (value: Reply) => Promise.resolve({ ok: value.status < 400, status: value.status, json: () => Promise.resolve(value.body) });

/** Three list pages: 200, 200 and 150 ids. */
const PAGES: Record<string, { ids: string[]; next: string | null }> = {
  first: { ids: range(1, 200), next: 'gc1.p2' },
  'gc1.p2': { ids: range(201, 200), next: 'gc1.p3' },
  'gc1.p3': { ids: range(401, 150), next: null },
};
/** Every id whose number ends in 0 is redundant; 5s are effective; the rest assignment. */
const verdictOf = (value: string) => (value.slice(7, 8) === '0' ? 'redundant' : value.slice(7, 8) === '5' ? 'effective' : 'assignment');
let realReplies: Reply[] = [];
let minted = 0;
const pageUrl = vi.fn((cursor: string | null, limit: number) => `/api/grants?limit=${limit}&made=all&verb=read${cursor ? `&cursor=${cursor}` : ''}`);
const onFinished = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  realReplies = [];
  minted = 0;
  authenticatedFetch.mockImplementation((url: string, options?: RequestInit) => {
    if (url.endsWith('/auth/step-up/methods')) return reply({ status: 200, body: { success: true, methods: ['password'], preferred: 'password' } });
    if (url.endsWith('/auth/step-up')) { minted += 1; return reply({ status: 200, body: { success: true, stepUpToken: `rhsu_bulk_${minted}` } }); }
    if (url.startsWith('/api/grants?')) {
      const cursor = new URL(url, 'http://x').searchParams.get('cursor') ?? 'first';
      const page = PAGES[cursor];
      return reply({ status: 200, body: { success: true, grants: page.ids.map((value) => ({ id: value })), pagination: { nextCursor: page.next } } });
    }
    if (url === '/api/grants/bulk-revoke') {
      const body = JSON.parse(String(options?.body));
      if (body.dryRun === false) return reply(realReplies.shift() ?? { status: 200, body: { success: true, removed: body.ids.length, rolledBack: false, results: body.ids.map((value: string) => ({ id: value, verdict: 'redundant', removed: true })) } });
      const results = body.ids.map((value: string) => ({ id: value, verdict: verdictOf(value), reason: `reason ${value}`, grant: { granteeId: id(9999), resourceType: 'task', resourceId: value, verb: 'read' } }));
      const redundant = results.filter((r: { verdict: string }) => r.verdict === 'redundant').map((r: { id: string }) => r.id);
      return reply({ status: 200, body: { success: true, dryRun: true, results, removed: 0, redundantIdSetHash: `hash-of-${redundant.length}-${redundant[0]}` } });
    }
    return reply({ status: 404, body: { success: false } });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const posts = (dryRun: boolean) => authenticatedFetch.mock.calls
  .filter(([url]) => url === '/api/grants/bulk-revoke')
  .map(([, options]) => JSON.parse(String((options as RequestInit).body)))
  .filter((body) => body.dryRun === dryRun);
const mints = () => authenticatedFetch.mock.calls
  .filter(([url]) => String(url).endsWith('/auth/step-up'))
  .map(([, options]) => JSON.parse(String((options as RequestInit).body)));

async function confirmInDialog() {
  const dialog = within(await screen.findByRole('dialog'));
  fireEvent.change(await dialog.findByLabelText('Password'), { target: { value: 'test-password' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Continue' }));
}

async function checkView() {
  render(<GrantCleanup pageUrl={pageUrl} onFinished={onFinished} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check this view (dry run)' }));
  await screen.findByRole('heading', { name: 'Dry run: 550 grants checked' });
}

test('reads the current filter page by page and dry-runs at most 500 ids per call, before anything is revoked', async () => {
  await checkView();
  expect(pageUrl.mock.calls).toEqual([[null, 200], ['gc1.p2', 200], ['gc1.p3', 200]]);
  const dry = posts(true);
  expect(dry.map((body) => body.ids.length)).toEqual([500, 50]);
  expect(dry.flatMap((body) => body.ids)).toEqual([...range(1, 200), ...range(201, 200), ...range(401, 150)]);
  expect(posts(false)).toEqual([]);
  expect(mints()).toEqual([]);
  // The counts by verdict and a sample.
  const counts = screen.getByText('Change nobody’s access (will be revoked)').closest('div') as HTMLElement;
  expect(within(counts).getByText('55')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Sample of grants to revoke' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Revoke batch 1 of 2 (50 grants)' })).toBeInTheDocument();
});

test('each real batch asks its own step-up bound to its id-set hash and sends only its redundant ids', async () => {
  await checkView();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke batch 1 of 2 (50 grants)' }));
  await confirmInDialog();
  await screen.findByText('Batch 1: 50 revoked, 0 kept after the live re-check');
  expect(onFinished).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke batch 2 of 2 (5 grants)' }));
  await confirmInDialog();
  await screen.findByText('Batch 2: 5 revoked, 0 kept after the live re-check');
  const real = posts(false);
  expect(real.map((body) => [body.ids.length, body.stepUpToken])).toEqual([[50, 'rhsu_bulk_1'], [5, 'rhsu_bulk_2']]);
  expect(real.flatMap((body) => body.ids).every((value: string) => verdictOf(value) === 'redundant')).toBe(true);
  expect(mints().map((body) => [body.action, body.targetId])).toEqual([
    ['grant.bulk_revoke', `hash-of-50-${id(10)}`], ['grant.bulk_revoke', `hash-of-5-${id(510)}`],
  ]);
  expect(onFinished).toHaveBeenCalledTimes(1);
});

test('a rolled-back batch says so, and a failed batch stops with no automatic retry', async () => {
  realReplies = [
    { status: 200, body: { success: true, removed: 0, rolledBack: true, results: [] } },
    { status: 500, body: { success: false, code: 'INTERNAL_ERROR', message: 'Failed to run the bulk grant revoke; nothing was revoked' } },
  ];
  await checkView();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke batch 1 of 2 (50 grants)' }));
  await confirmInDialog();
  expect(await screen.findByText(/Batch 1: rolled back/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke batch 2 of 2 (5 grants)' }));
  await confirmInDialog();
  expect(await screen.findByRole('alert')).toHaveTextContent('INTERNAL_ERROR');
  await waitFor(() => expect(posts(false)).toHaveLength(2));
  expect(onFinished).not.toHaveBeenCalled();
});

test('a cancelled step-up runs nothing', async () => {
  await checkView();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke batch 1 of 2 (50 grants)' }));
  const dialog = within(await screen.findByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(posts(false)).toEqual([]);
});

test('E444: batch 2\'s reused provider sign-in counts down, asks again by itself, and the batch runs with the fresh token', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const popup = { location: { href: '' }, close: vi.fn(), focus: vi.fn() };
    const open = vi.spyOn(window, 'open').mockImplementation(() => popup as unknown as Window);
    const requestIdOf = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    const bindings = new Map<string, { action: string; targetId: string }>();
    let started = 0;
    const board = authenticatedFetch.getMockImplementation()!;
    authenticatedFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url.endsWith('/auth/step-up/methods')) return reply({ status: 200, body: { success: true, methods: ['sso'], preferred: 'sso' } });
      if (url.endsWith('/auth/step-up/collect')) {
        const { requestId } = JSON.parse(String(options?.body));
        const binding = bindings.get(requestId)!;
        return reply({ status: 200, body: { success: true, stepUpToken: `rhsu_sso_${requestId.slice(0, 8)}`, ...binding } });
      }
      if (url.endsWith('/auth/step-up')) {
        started += 1;
        const { action, targetId } = JSON.parse(String(options?.body));
        bindings.set(requestIdOf(started), { action, targetId });
        return reply({ status: 200, body: { success: true, method: 'sso', authorizeUrl: 'https://idp.example.test/authorize', requestId: requestIdOf(started) } });
      }
      return board(url, options);
    });
    const land = (requestId: string, outcome: 'complete' | 'refused', code: string | null = null) => act(() => {
      window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { type: STEP_UP_MESSAGE_TYPE, outcome, requestId, code } }));
    });

    await checkView();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke batch 1 of 2 (50 grants)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
    await screen.findByText(/Finish signing in in the window that opened/);
    land(requestIdOf(1), 'complete');
    await screen.findByText('Batch 1: 50 revoked, 0 kept after the live re-check');

    fireEvent.click(screen.getByRole('button', { name: 'Revoke batch 2 of 2 (5 grants)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with single sign-on' }));
    await screen.findByText(/Finish signing in in the window that opened/);
    land(requestIdOf(2), 'refused', 'SSO_STEP_UP_NOT_FRESH');
    expect(await screen.findByRole('timer')).toHaveTextContent('Asking again in 35 seconds.');
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(35_000); });
    await waitFor(() => expect(started).toBe(3));
    await screen.findByText(/Finish signing in in the window that opened/);
    land(requestIdOf(3), 'complete');
    await screen.findByText('Batch 2: 5 revoked, 0 kept after the live re-check');

    expect(posts(false).map((body) => [body.ids.length, body.stepUpToken])).toEqual([[50, 'rhsu_sso_00000001'], [5, 'rhsu_sso_00000003']]);
    // Each batch's step-up is bound to that batch; the retry is bound to batch 2.
    expect([...bindings.values()].map((binding) => binding.targetId)).toEqual([
      `hash-of-50-${id(10)}`, `hash-of-5-${id(510)}`, `hash-of-5-${id(510)}`,
    ]);
    expect(onFinished).toHaveBeenCalledTimes(1);
    // One window per batch dialog, opened by the click; the retry reused batch 2's.
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
