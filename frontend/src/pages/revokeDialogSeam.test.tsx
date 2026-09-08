// @vitest-environment jsdom
/**
 * revokeDialogSeam.test.tsx — review `99ba9444` finding B2 and controls
 * finding 3.
 *
 * WHY THIS FILE EXISTS AND `revokeDialogCounts.test.tsx` IS NOT ENOUGH.
 * That file asserts nine properties of the exported helpers. The verdict
 * showed what that leaves open, in its own words: "An incorrect production
 * implementation that changes confirmLabel back to
 * revokeTarget.dependents.tasks.length, or changes the details-panel decision
 * back to the visible array, satisfies all nine assertions." A classification
 * cannot check itself, and a direct call to a helper proves nothing about the
 * seam that feeds it.
 *
 * So every assertion below crosses the seam: `AccessManagerPage` is RENDERED,
 * the warrant routes answer through the mocked `authenticatedFetch` the page
 * really calls, and what is asserted is the text on screen and the state of
 * the acknowledgement control. The defect these pin is a TRANSIENT one - the
 * false claim was on screen between the click and the response - so the
 * pending case is driven by a route that never settles, which is the only
 * honest way to hold that instant still.
 *
 * The four mutations these are written to redden, each a DIFFERENT assertion:
 *  1. panel reads an absent linkage entry as zero  -> "counts while pending";
 *  2. panel keeps reading zero after a failed read -> "says so when the read fails";
 *  3. confirmLabel rebuilt from `tasks.length`     -> "the confirm carries the TOTAL";
 *  4. acknowledgement enabled before the count     -> "cannot be acknowledged while counting".
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

const fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
const routes = new Map<string, unknown>();
vi.mock('../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, options?: RequestInit) => {
    fetchCalls.push({ url, options });
    // The URL's ENDING decides, then length — the same matcher the sibling
    // AccessManagerPage suites use, for the same reason: `/warrants` is a
    // suffix of nothing else here, but `/warrants/{id}` contains `/warrants`.
    const entries = [...routes.entries()];
    const match = entries.filter(([suffix]) => url.endsWith(suffix))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (match) {
      const body = match[1];
      // A route may be seeded with a PROMISE to model a read that is still in
      // flight or has failed — the two states this repair has to distinguish
      // from "there are none".
      if (body instanceof Promise) return body as never;
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

import { AccessManagerPage } from './AccessManagerPage';

const WARRANT = {
  id: '55555555-0000-4000-8000-000000000005',
  name: 'Nightly ingest',
  description: '',
  holderPrincipalId: 'p-holder',
  status: 'active' as const,
  ceilingProfileName: 'Ingest',
  ceilingProfileVersionNumber: 2,
  ceilingRules: null,
  ceilingScopes: ['tasks:read'],
  expiresAt: null,
  transportPin: 'any',
  maxConcurrent: null,
  maxTotal: null,
  mintedTotal: 1,
  liveMinted: 0,
  suspendedReason: null,
  anchors: [],
};

/** A promise that never settles: the instant the defect lived in. */
const PENDING = new Promise(() => {});

/** A promise that is already rejected, marked handled at creation — the page
 * awaits it later, and an unattended rejection in the gap is reported by the
 * runner as a suite error even though every assertion passes. */
function failing(message: string) {
  const rejected = Promise.reject(new Error(message));
  rejected.catch(() => undefined);
  return rejected;
}

function seed(overrides: Record<string, unknown>) {
  routes.clear();
  fetchCalls.length = 0;
  usePrincipals.mockReturnValue({ principals: [] });
  useMyPrincipal.mockReturnValue({
    me: { id: 'p-root', handle: 'owner', kind: 'human', role: 'orchestrator' },
    scopes: ['root'],
    loading: false,
  });
  routes.set('/warrants', { warrants: [WARRANT] });
  routes.set('/access-profiles', { profiles: [] });
  routes.set(`/warrants/${WARRANT.id}`, { mintedIdentities: [] });
  for (const [suffix, body] of Object.entries(overrides)) routes.set(suffix, body);
}

const renderPage = () => render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);

/** The warrant's own details panel, scoped: the revoke dialog renders the same
 * sentence, and an unscoped query would pass on whichever it found. */
async function openDetails() {
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: 'Details' }));
  const item = (await screen.findByText(WARRANT.name)).closest('li');
  return within(item as HTMLElement);
}

async function openRevokeDialog() {
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: 'Details' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
  return within(await screen.findByRole('dialog'));
}

const NOTHING = /unassigns nothing|nothing is unassigned/i;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

/**
 * FINDING B2, the shipped path: "every first expansion transiently makes the
 * exact false-zero claim before the linkage response arrives".
 */
describe('the details panel never claims a revoke unassigns nothing while it does not know', () => {
  test('while the linkage read is PENDING it counts, it does not report a zero', async () => {
    seed({ '/linkage': PENDING });
    const panel = await openDetails();
    expect(await panel.findByText(/still counting/i)).toBeInTheDocument();
    expect(panel.queryByText(NOTHING)).not.toBeInTheDocument();
    expect(panel.queryByText(/^None\./)).not.toBeInTheDocument();
  });

  test('when the linkage read FAILS it says so, and keeps saying so', async () => {
    seed({ '/linkage': failing('Linkage could not be read') });
    const panel = await openDetails();
    expect(await panel.findByText(/could not count/i)).toBeInTheDocument();
    expect(panel.queryByText(NOTHING)).not.toBeInTheDocument();
    // The claim does not creep back in once the surrounding renders settle:
    // the old code left the entry ABSENT, and absent read as zero for ever.
    await waitFor(() => expect(panel.queryByText(NOTHING)).not.toBeInTheDocument());
  });

  test('a warrant carrying only CONCEALED Tasks reports the whole count', async () => {
    // The mirror of the reported case, through the shipped panel rather than
    // through the helper: nothing nameable, two Tasks riding it.
    seed({ '/linkage': { carriedTasks: [], carriedTotal: 2, carriedConcealed: 2 } });
    const panel = await openDetails();
    expect(await panel.findByText(/2 not-yet-terminal Tasks ride this warrant/i)).toBeInTheDocument();
    expect(panel.queryByText(NOTHING)).not.toBeInTheDocument();
  });

  test('an IMPOSSIBLE count is refused rather than narrated', async () => {
    // The reviewer probe, at the shipped call site: `{total: 3, concealed: 4}`
    // used to print "3 ... Tasks ... 4 of them cannot be named here".
    seed({ '/linkage': { carriedTasks: [], carriedTotal: 3, carriedConcealed: 4 } });
    const panel = await openDetails();
    expect(await panel.findByText(/could not count/i)).toBeInTheDocument();
    expect(panel.queryByText(/4 of them cannot be named/i)).not.toBeInTheDocument();
    expect(panel.queryByText(NOTHING)).not.toBeInTheDocument();
  });

  test('the count does not wait on the unrelated warrant-detail read', async () => {
    // ROUND 1 FINDING T3/P3. The two reads used to be SERIALIZED: the linkage
    // request was not issued until the warrant-detail read had settled, so a
    // hung `GET /warrants/:id` left the count COUNTING for ever. Separate
    // `try` blocks isolate rejection, not non-settlement.
    //
    // Here the warrant-detail route never settles and the linkage route
    // answers. The count must arrive anyway — which it can only do if its
    // request was STARTED before the other was awaited.
    seed({ '/linkage': { carriedTasks: [], carriedTotal: 2, carriedConcealed: 2 } });
    routes.set(`/warrants/${WARRANT.id}`, PENDING);
    const panel = await openDetails();
    expect(await panel.findByText(/2 not-yet-terminal Tasks ride this warrant/i)).toBeInTheDocument();
    // And the request really was made, rather than the count arriving from
    // somewhere else.
    expect(fetchCalls.filter((call) => call.url.endsWith('/linkage'))).toHaveLength(1);
  });

  test('a genuine zero still reads as a genuine zero', async () => {
    // The negative control. A repair that simply never says "nothing" would
    // satisfy every assertion above and lie in the other direction.
    seed({ '/linkage': { carriedTasks: [], carriedTotal: 0, carriedConcealed: 0 } });
    const panel = await openDetails();
    expect(await panel.findByText(NOTHING)).toBeInTheDocument();
  });

  test('the named Tasks are listed when there are any', async () => {
    seed({
      '/linkage': {
        carriedTasks: [{ id: 'aaaaaaaa-0000-4000-8000-00000000000a', title: 'Ingest run', status: 'in_progress' }],
        carriedTotal: 2,
        carriedConcealed: 1,
      },
    });
    const panel = await openDetails();
    expect(await panel.findByText(/2 not-yet-terminal Tasks ride this warrant/i)).toBeInTheDocument();
    expect(panel.getByText(/Ingest run/)).toBeInTheDocument();
    expect(panel.getByText(/1 of them cannot be named/i)).toBeInTheDocument();
  });
});

/**
 * CONTROLS FINDING 3: the confirm label and the acknowledgement, asserted
 * where an operator meets them.
 */
describe('the revoke acknowledgement is an acknowledgement OF a number', () => {
  test('the confirm carries the TOTAL, not the length of what can be named', async () => {
    // Three ride it, none nameable. A label rebuilt from `tasks.length` —
    // the mutation the verdict named — reads "Revoke" here.
    seed({
      '/linkage': { carriedTasks: [], carriedTotal: 3, carriedConcealed: 3 },
      '/dependent-tasks': { tasks: [], total: 3, concealed: 3 },
    });
    const dialog = await openRevokeDialog();
    const confirm = await dialog.findByRole('button', { name: 'Revoke and unassign 3' });
    expect(confirm).toBeEnabled();
    expect(dialog.queryByText(NOTHING)).not.toBeInTheDocument();
  });

  test('while the count is PENDING the dialog cannot be acknowledged', async () => {
    seed({
      '/linkage': { carriedTasks: [], carriedTotal: 3, carriedConcealed: 3 },
      '/dependent-tasks': PENDING,
    });
    const dialog = await openRevokeDialog();
    // Scoped past the button: the disabled confirm is ALSO labelled 'Still
    // counting…', and an unscoped match would find two.
    expect(await dialog.findByText(/still counting what a revoke would unassign/i)).toBeInTheDocument();
    expect(dialog.queryByText(NOTHING)).not.toBeInTheDocument();
    // Whatever it is labelled, it does not act.
    for (const button of dialog.getAllByRole('button')) {
      if (/revoke|counting|cannot/i.test(button.textContent ?? '')) expect(button).toBeDisabled();
    }
    // And the acknowledgement never reached the estate.
    expect(fetchCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(0);
  });

  test('when the count FAILS the dialog says so and still cannot be acknowledged', async () => {
    seed({
      '/linkage': { carriedTasks: [], carriedTotal: 3, carriedConcealed: 3 },
      '/dependent-tasks': failing('Dependent tasks could not be read'),
    });
    const dialog = await openRevokeDialog();
    expect(await dialog.findByText(/could not count/i)).toBeInTheDocument();
    expect(dialog.queryByText(NOTHING)).not.toBeInTheDocument();
    const confirm = dialog.getByRole('button', { name: /cannot revoke/i });
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(fetchCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(0);
  });

  test('a counted ZERO is acknowledgeable, and says nothing is unassigned', async () => {
    // The negative control for the disabling rule: unknown must not be
    // coerced to zero, and zero must not be coerced to unknown.
    seed({
      '/linkage': { carriedTasks: [], carriedTotal: 0, carriedConcealed: 0 },
      '/dependent-tasks': { tasks: [], total: 0, concealed: 0 },
    });
    const dialog = await openRevokeDialog();
    expect(await dialog.findByText(NOTHING)).toBeInTheDocument();
    const confirm = dialog.getByRole('button', { name: 'Revoke' });
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(fetchCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(1));
  });

  test('a count that does not ADD UP cannot be acknowledged', async () => {
    // Round 1 finding P2, at the shipped seam: two named Tasks, a total of
    // three and two withheld is four classifications for three Tasks. The
    // one-sided predicate called this `counted` and enabled the confirm.
    const two = [
      { id: 'aaaaaaaa-0000-4000-8000-00000000000a', title: 'Ingest run', status: 'in_progress' },
      { id: 'bbbbbbbb-0000-4000-8000-00000000000b', title: 'Second run', status: 'in_progress' },
    ];
    seed({
      '/linkage': { carriedTasks: two, carriedTotal: 3, carriedConcealed: 2 },
      '/dependent-tasks': { tasks: two, total: 3, concealed: 2 },
    });
    const dialog = await openRevokeDialog();
    expect(await dialog.findByText(/could not count/i)).toBeInTheDocument();
    expect(dialog.queryByText(/2 of them cannot be named/i)).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: /cannot revoke/i })).toBeDisabled();
    expect(fetchCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(0);
  });

  test('an IMPOSSIBLE count cannot be acknowledged either', async () => {
    seed({
      '/linkage': { carriedTasks: [], carriedTotal: 3, carriedConcealed: 3 },
      '/dependent-tasks': { tasks: [], total: 3, concealed: 4 },
    });
    const dialog = await openRevokeDialog();
    expect(await dialog.findByText(/could not count/i)).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: /cannot revoke/i })).toBeDisabled();
    expect(fetchCalls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(0);
  });
});
