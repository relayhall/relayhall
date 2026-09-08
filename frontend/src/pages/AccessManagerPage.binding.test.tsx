// @vitest-environment jsdom
/**
 * AccessManagerPage — the SS-12 Group directory binding surface (RH-P5.SSO.W3).
 *
 * Added after review R3 finding B1 against candidate `be42278`: the wave built
 * the backend binding contract and the login-gate editor but no GUI control
 * that could set or clear a Group's `(identityProviderId, externalGroupRef)`
 * pair, so the SS-12 surface the run packet required was unreachable.
 *
 * What these pin:
 *  - the section is ROOT-ONLY, matching `/groups` mutation in the scope map;
 *  - **Bind sends BOTH columns and Unbind sends BOTH as null** — the binding is
 *    one value, the schema forbids a half-set pair, and a surface that could
 *    send one alone would produce a refusal the operator did not ask for;
 *  - the external reference reaches the route **byte for byte**: it is an
 *    opaque value (a directory identifier, a `/path` or a bare name are all
 *    legitimate), and a surface that trimmed or case-folded it would bind the
 *    wrong Group or none at all — shape class 3 is the reason;
 *  - a bound Group shows what it is bound TO, so an operator can audit the
 *    mapping without reading the database.
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
    // The URL's ENDING decides, then length. Neither insertion order nor
    // longest-match is right on its own: the allowed-groups URL is
    // `/identity-providers/{id}/login-groups`, which CONTAINS the longer string
    // '/identity-providers', so a longest-match rule serves the Identity provider
    // list to
    // the login-groups read and the editor silently believes it has loaded.
    // Both wrong matchers made these tests fail for reasons that had nothing to
    // do with the product, which is its own small lesson about test doubles.
    const entries = [...routes.entries()];
    const match = entries.filter(([prefix]) => url.endsWith(prefix))
      .sort((a, b) => b[0].length - a[0].length)[0]
      ?? entries.filter(([prefix]) => url.includes(prefix))
        .sort((a, b) => b[0].length - a[0].length)[0];
    if (match) {
      const body = match[1];
      // A route may be seeded with a PROMISE to model a pending or failing
      // read — the states R3 B2's repair has to distinguish from "empty".
      if (body instanceof Promise) return body as never;
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

import { AccessManagerPage } from './AccessManagerPage';

const PROVIDER = {
  id: '11111111-0000-4000-8000-000000000001',
  name: 'Estate authentik',
  issuer: 'https://idp.example.test/application/o/relayhall',
  status: 'active',
  provisioningMode: 'invited',
  clientAuthMethod: 'client_secret_basic',
  hasClientSecret: true,
  subjectImmutable: true,
};

const UNBOUND = {
  id: '33333333-0000-4000-8000-000000000003',
  name: 'Engineering',
  identityProviderId: null,
  externalGroupRef: null,
};

const BOUND = {
  id: '44444444-0000-4000-8000-000000000004',
  name: 'Owners',
  identityProviderId: PROVIDER.id,
  // A `/path`-shaped value on purpose: the surface must show it unchanged.
  externalGroupRef: '/engineering/platform',
};

function seed(groups: unknown[]) {
  routes.clear();
  fetchCalls.length = 0;
  // Longest prefix first: '/identity-providers' must not be served the groups body.
  routes.set('/identity-providers', { identityProviders: [PROVIDER] });
  routes.set('/groups', { groups });
  usePrincipals.mockReturnValue({ principals: [] });
}

function asRoot() {
  useMyPrincipal.mockReturnValue({
    me: { id: 'p-root', handle: 'owner', kind: 'human', role: 'orchestrator' },
    scopes: ['root'],
    loading: false,
  });
}

function asNonRoot() {
  useMyPrincipal.mockReturnValue({
    me: { id: 'p-user', handle: 'casey', kind: 'human', role: 'user' },
    scopes: ['tasks:read'],
    loading: false,
  });
}

const renderPage = () => render(<MemoryRouter><AccessManagerPage /></MemoryRouter>);

const patchBodies = () => fetchCalls
  .filter((call) => call.options?.method === 'PATCH' && call.url.includes('/groups/'))
  .map((call) => JSON.parse(String(call.options?.body)));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

/**
 * Review R3 finding B2: the login-gate editor rendered an UNREAD allowed-Group
 * list as an EMPTY one — printing "every federated sign-in is refused" while
 * the board had simply not answered, with the mutation controls live beside the
 * claim. Unknown is not empty. These two pin that the editor asserts nothing,
 * and offers nothing to click, until it knows.
 */
describe('SSO-R4 · the login-gate editor never renders UNKNOWN as an empty list', () => {
  const ENABLED = { ...PROVIDER, loginGroupWhitelistEnabled: true };

  test('while the allowed-group read is PENDING it shows loading, not a lockout', async () => {
    asRoot();
    routes.clear();
    fetchCalls.length = 0;
    usePrincipals.mockReturnValue({ principals: [] });
    routes.set('/identity-providers', { identityProviders: [ENABLED] });
    // The login-groups read never settles during this test.
    routes.set('/login-groups', new Promise(() => {}));
    routes.set('/groups', { groups: [] });

    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Allowed groups' }));

    expect(await screen.findByText(/Loading the allowed groups/i)).toBeInTheDocument();
    // The factual lockout claim must NOT be on screen, and nothing is actionable.
    expect(screen.queryByText(/every federated sign-in is refused/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Allow a group')).not.toBeInTheDocument();
  });

  test('when the read FAILS it says the list is unknown and offers no controls', async () => {
    asRoot();
    routes.clear();
    fetchCalls.length = 0;
    usePrincipals.mockReturnValue({ principals: [] });
    routes.set('/identity-providers', { identityProviders: [ENABLED] });
    // Marked handled at creation: the component awaits it later, and an
    // unattended rejection in the gap is reported by the runner as a suite
    // error even though every assertion passes.
    const failing = Promise.reject(new Error('read failed'));
    failing.catch(() => undefined);
    routes.set('/login-groups', failing);
    routes.set('/groups', { groups: [] });

    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Allowed groups' }));

    expect(await screen.findByText(/could not be read, so this list is unknown/i)).toBeInTheDocument();
    expect(screen.queryByText(/every federated sign-in is refused/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('SS-12 · the Group directory binding surface', () => {
  test('renders for a root Account', async () => {
    asRoot();
    seed([UNBOUND, BOUND]);
    renderPage();
    expect(await screen.findByText('Group directory bindings')).toBeInTheDocument();
  });

  test('is ABSENT for a non-root Account, as /groups mutation is', async () => {
    asNonRoot();
    seed([UNBOUND, BOUND]);
    renderPage();
    await waitFor(() => expect(screen.queryByText('Group directory bindings')).not.toBeInTheDocument());
  });

  test('a bound Group shows the Identity provider and the reference UNCHANGED', async () => {
    asRoot();
    seed([BOUND]);
    renderPage();
    // Scoped to THIS table: the Identity provider's name also appears in the
    // Identity providers section above, and an unscoped query would pass on it.
    const table = await screen.findByRole('table', { name: 'Group directory bindings' });
    expect(within(table).getByText('Estate authentik')).toBeInTheDocument();
    // Byte-for-byte: not trimmed, not case-folded, not split on the slash.
    expect(within(table).getByText('/engineering/platform')).toBeInTheDocument();
  });

  test('Bind sends BOTH columns, with the reference byte-for-byte', async () => {
    asRoot();
    seed([UNBOUND]);
    renderPage();
    const field = await screen.findByLabelText('External group reference');
    // Mixed case and a trailing-looking shape that a "helpful" surface would
    // normalise. It must arrive exactly as typed.
    await userEvent.type(field, 'Platform-Engineers');
    await userEvent.click(screen.getByRole('button', { name: 'Bind' }));

    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toEqual({
      identityProviderId: PROVIDER.id,
      externalGroupRef: 'Platform-Engineers',
    });
  });

  test('Unbind sends BOTH columns as null — never one alone', async () => {
    asRoot();
    seed([BOUND]);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Unbind' }));

    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toEqual({ identityProviderId: null, externalGroupRef: null });
  });

  test('Bind stays disabled until BOTH halves are supplied', async () => {
    asRoot();
    seed([UNBOUND]);
    renderPage();
    const button = await screen.findByRole('button', { name: 'Bind' });
    // The Identity provider select defaults to the only one; the reference is
    // empty, so the control must refuse to send a half-set pair rather than let
    // the service refuse it.
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('External group reference'), 'x');
    await waitFor(() => expect(button).toBeEnabled());
  });
});

/**
 * Cards `98ae591c` / `a865f982` — the binding copy is a SENTENCE.
 *
 * The shipped paragraph read "…and it is matched byte for paste it unchanged.":
 * words had been lost mid-sentence, so the one explanation an operator gets of
 * WHY the reference must be copied rather than retyped said nothing. The suite
 * beside this one passed 8/8 throughout, because none of its assertions looked
 * at the explanatory copy — which is why the pin below is over the RENDERED
 * text of the whole paragraph rather than over a phrase. A partial assertion is
 * how a half-sentence survives a green suite.
 *
 * Pinning the full string also makes any future edit to operator-facing copy a
 * visible diff, which is what the two cards asked for: this is the sentence
 * that tells an operator the reference is opaque and matched byte for byte.
 */
describe('SS-12 · the binding copy an operator actually reads', () => {
  // Written as the operator reads it, one clause per line. `&apos;` renders as
  // U+0027, so these are straight apostrophes; the dashes are em dashes.
  const EXPECTED_INTRO = [
    "Bind a board Group to one group in an Identity provider's directory.",
    "On each federated sign-in the Identity provider's group values are matched against these",
    "bindings, as sent, and matching Groups become that person's directory membership.",
    'The reference is whatever the Identity provider emits — an identifier, a path or a name —',
    'and it is matched byte for byte, so copy and paste it unchanged rather than retyping it.',
    'Groups with no binding are local-only and no sync ever touches them.',
  ].join(' ');

  const introText = async (): Promise<string> => {
    const heading = await screen.findByRole('heading', { name: 'Group directory bindings' });
    const intro = heading.closest('section')?.querySelector('.axm-section-intro');
    if (!intro) throw new Error('the binding section rendered no intro paragraph');
    return (intro.textContent ?? '').replace(/\s+/g, ' ').trim();
  };

  test('the rendered paragraph is the corrected sentence, in full', async () => {
    asRoot();
    seed([UNBOUND, BOUND]);
    renderPage();
    expect(await introText()).toBe(EXPECTED_INTRO);
  });

  test('the malformed fragment is gone, and the words it lost are back', async () => {
    // Named separately from the pin above so a failure says WHICH defect
    // returned rather than printing two paragraphs side by side.
    asRoot();
    seed([UNBOUND]);
    renderPage();
    const copy = await introText();
    expect(copy).not.toContain('matched byte for paste');
    expect(copy).toContain('matched byte for byte');
    expect(copy).toContain('copy and paste it unchanged');
  });
});
