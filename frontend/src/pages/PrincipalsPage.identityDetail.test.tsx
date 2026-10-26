// @vitest-environment jsdom
/**
 * THE IDENTITY DETAIL PAGE (card caea70ef, epic F11).
 *
 * An identity opens from the Identities list and reads its own facts: kind,
 * role, status, its connectors and their credentials with scopes, the grants
 * it holds, the Warrants it holds and the last audit rows about it or by it.
 * For an administrator the role change is an action on the same page: the
 * beta.61 confirmation with the role catalogue entry, posted to the same act
 * as the Access manager's Roles panel.
 *
 * What is load-bearing here:
 *  - every fact on the page is the API's answer, read through a route that
 *    already exists, and there is no single-identity read the page invents;
 *  - a refused read says so in its own section and the others still render;
 *  - a non-administrator is offered no role action at all, and an
 *    administrator is offered none on the rows the route refuses by name;
 *  - the role action posts only the role, asks for a step-up only when the
 *    board answers with the step-up challenge, and then uses the existing
 *    step-up dialog for exactly the challenged binding;
 *  - the page is axe-clean and keeps wrapping at a phone's width.
 */
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import axe from 'axe-core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import catalogueFixture from '../components/access/roleCatalogue.generated.json';

const ADA = '0a0a0a0a-0000-4000-8000-00000000a0a0';
const TESSA = '1b1b1b1b-0000-4000-8000-00000000b1b1';
const LAPTOP = '2c2c2c2c-0000-4000-8000-00000000c2c2';
const LAPTOP_AGENT = '3d3d3d3d-0000-4000-8000-00000000d3d3';
const SYSTEM = '4e4e4e4e-0000-4000-8000-00000000e4e4';
const OWNER = '5f5f5f5f-0000-4000-8000-00000000f5f5';
const PROJECT = '6a6a6a6a-0000-4000-8000-00000000a6a6';

const DIRECTORY = [
  { id: ADA, kind: 'human', handle: 'ada', displayName: 'Ada', status: 'active', role: 'admin', parentPrincipalId: null, harness: null, lastSeenAt: null, provenance: 'managed' },
  { id: TESSA, kind: 'human', handle: 'tessa', displayName: 'Tessa Quinn', status: 'active', role: 'viewer', parentPrincipalId: null, harness: null, lastSeenAt: null, provenance: 'managed' },
  { id: LAPTOP, kind: 'service', handle: 'tessa-laptop', displayName: null, status: 'active', role: null, parentPrincipalId: TESSA, harness: 'claude-code', lastSeenAt: null, provenance: 'managed' },
  { id: LAPTOP_AGENT, kind: 'agent', handle: 'tessa-laptop-agent', displayName: null, status: 'disabled', role: null, parentPrincipalId: LAPTOP, harness: null, lastSeenAt: null, provenance: 'managed' },
  { id: SYSTEM, kind: 'service', handle: 'system', displayName: 'System', status: 'active', role: 'admin', parentPrincipalId: null, harness: null, lastSeenAt: null, provenance: 'bootstrap' },
  { id: OWNER, kind: 'human', handle: 'dashboard_user', displayName: 'Owner', status: 'active', role: 'orchestrator', parentPrincipalId: null, harness: null, lastSeenAt: null, provenance: 'bootstrap' },
];

const LAPTOP_CREDENTIALS = [
  {
    id: 'cred-live', keyId: 'k1livekey', label: 'laptop key', scopes: ['tasks:read', 'tasks:write'],
    credentialType: 'api_key', createdAt: '2026-10-01T08:00:00.000Z', expiresAt: null, revokedAt: null,
    lastUsedAt: '2026-10-19T09:30:00.000Z', revealCount: 0, graceUntil: null, transport: 'mcp', revealable: true,
  },
  {
    id: 'cred-old', keyId: 'k0oldkey', label: null, scopes: ['reports:read'],
    credentialType: 'api_key', createdAt: '2026-09-01T08:00:00.000Z', expiresAt: null, revokedAt: '2026-09-20T10:00:00.000Z',
    lastUsedAt: null, revealCount: 1, graceUntil: null, transport: 'any', revealable: false,
  },
];

const TESSA_GRANTS = [
  { id: 'g1', granteeType: 'principal', granteeId: TESSA, resourceType: 'project', resourceId: PROJECT, verb: 'write', grantedByPrincipalId: ADA, expiresAt: '2026-12-01T00:00:00.000Z', createdAt: '2026-10-02T00:00:00.000Z', origin: 'manual' },
  { id: 'g2', granteeType: 'principal', granteeId: TESSA, resourceType: 'skill', resourceId: null, verb: 'read', grantedByPrincipalId: ADA, expiresAt: null, createdAt: '2026-10-03T00:00:00.000Z', origin: 'manual' },
];

const WARRANTS = [
  {
    id: 'w-tessa', name: 'Nightly builds', description: '', holderPrincipalId: TESSA, status: 'active',
    ceilingProfileName: 'builder', ceilingProfileVersionNumber: 2, ceilingRules: null, ceilingScopes: null,
    expiresAt: null, transportPin: 'mcp', maxConcurrent: 2, maxTotal: null, mintedTotal: 3, liveMinted: 1,
    suspendedReason: null, anchors: [],
  },
  {
    id: 'w-ada', name: 'Release train', description: '', holderPrincipalId: ADA, status: 'active',
    ceilingProfileName: 'release', ceilingProfileVersionNumber: 1, ceilingRules: null, ceilingScopes: null,
    expiresAt: null, transportPin: 'any', maxConcurrent: null, maxTotal: null, mintedTotal: 0, liveMinted: 0,
    suspendedReason: null, anchors: [],
  },
];

const AUDIT_ABOUT = [
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000001', occurredAt: '2026-10-18T12:00:00.000Z', action: 'principal.role.changed',
    outcome: 'success', actorPrincipalId: ADA, actorHandle: 'ada', authMethod: 'session', credentialId: null,
    resourceType: 'principal', resourceId: TESSA, metadata: {},
  },
];
const AUDIT_BY = [
  {
    id: 'aaaaaaaa-0000-4000-8000-000000000002', occurredAt: '2026-10-19T08:00:00.000Z', action: 'task.update',
    outcome: 'denied', actorPrincipalId: TESSA, actorHandle: 'tessa', authMethod: 'session', credentialId: null,
    resourceType: 'task', resourceId: PROJECT, metadata: {},
  },
];

type Scripted = { ok: boolean; status: number; body: unknown };
const calls: Array<{ url: string; method: string; body: unknown }> = [];
const state = {
  me: DIRECTORY[0] as Record<string, unknown>,
  scopes: ['root'] as string[],
  grants: null as null | Scripted,
  roleAnswers: [] as Scripted[],
};

const ok = (body: unknown): Scripted => ({ ok: true, status: 200, body });

vi.mock('../utils/auth', () => ({
  auth: { getToken: () => 't', clearToken: () => {}, isAuthenticated: () => true },
  authenticatedFetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = ((): Scripted => {
      if (url.endsWith('/principals/me')) return ok({ success: true, principal: state.me, scopes: state.scopes });
      if (url.endsWith('/principals/roles')) return ok({ success: true, roles: catalogueFixture.roles });
      if (url.endsWith('/principals')) return ok({ success: true, principals: DIRECTORY });
      if (url.endsWith(`/principals/${TESSA}/role`) && method === 'POST') {
        return state.roleAnswers.shift() ?? ok({
          success: true, principal: { ...DIRECTORY[1], role: 'editor' }, previousRole: 'viewer',
          effectiveFrom: 'next-request', note: 'tessa carries the role editor from their next request; no re-login is required.',
        });
      }
      if (url.endsWith(`/principals/${LAPTOP}/credentials`)) return ok({ success: true, credentials: LAPTOP_CREDENTIALS });
      if (/\/principals\/[^/]+\/credentials$/.test(url)) return ok({ success: true, credentials: [] });
      if (url.endsWith(`/principals/${TESSA}/grants`)) return state.grants ?? ok({ success: true, grants: TESSA_GRANTS });
      if (/\/principals\/[^/]+\/grants$/.test(url)) return ok({ success: true, grants: [] });
      if (url.endsWith('/warrants')) return ok({ success: true, warrants: WARRANTS });
      if (url.includes('/audit?') && url.includes(`resourceId=${TESSA}`)) return ok({ success: true, events: AUDIT_ABOUT, nextCursor: null });
      if (url.includes('/audit?') && url.includes(`actorPrincipalId=${TESSA}`)) return ok({ success: true, events: AUDIT_BY, nextCursor: null });
      if (url.includes('/audit?')) return ok({ success: true, events: [], nextCursor: null });
      if (url.endsWith('/auth/step-up/methods')) return ok({ success: true, methods: ['password'], preferred: 'password' });
      if (url.endsWith('/auth/step-up') && method === 'POST') return ok({ success: true, stepUpToken: 'su-token-1', expiresAt: '2026-10-20T06:05:00.000Z' });
      return { ok: false, status: 404, body: { error: 'Not Found' } };
    })();
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }),
}));

import { PrincipalsPage } from './PrincipalsPage';

const CATALOGUE = catalogueFixture.roles;
const entryOf = (role: string) => CATALOGUE.find((entry) => entry.role === role)!;

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/settings/principals${search}`]}>
      <Routes>
        <Route path="/settings/principals" element={<PrincipalsPage />} />
        <Route path="/audit" element={<p>the audit log page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const openTessa = async () => {
  const view = renderAt(`?identity=${TESSA}`);
  await screen.findByRole('heading', { level: 1, name: 'tessa' });
  return view;
};
const section = (name: RegExp) => screen.getByRole('heading', { level: 2, name }).closest('section')!;
const gets = () => calls.filter((call) => call.method === 'GET').map((call) => call.url.replace(/^.*?\/principals/, '/principals').replace(/^.*?\/(warrants|audit)/, '/$1'));

beforeEach(() => {
  state.me = DIRECTORY[0];
  state.scopes = ['root'];
  state.grants = null;
  state.roleAnswers = [];
});
afterEach(() => { cleanup(); calls.length = 0; });

describe('the list opens an identity', () => {
  test('each row links to its identity, and the link opens the detail page', async () => {
    renderAt('');
    const link = await screen.findByRole('link', { name: 'Open tessa' });
    await userEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'tessa' })).toBeInTheDocument();
    // The way back is a link to the list itself.
    await userEvent.click(screen.getByRole('link', { name: 'Back to Identities' }));
    expect(await screen.findByRole('link', { name: 'Open tessa' })).toBeInTheDocument();
  });

  test('an identity the directory does not hold is named as absent, not guessed at', async () => {
    renderAt('?identity=9f9f9f9f-0000-4000-8000-000000009f9f');
    expect(await screen.findByText(/not in the directory this session can read/)).toBeInTheDocument();
    // Nothing is asked about an identity the page could not find.
    expect(gets().some((url) => url.includes('9f9f9f9f'))).toBe(false);
  });
});

describe('the page renders each fact from the API', () => {
  test('kind, role, status and the directory facts', async () => {
    await openTessa();
    const facts = section(/^Identity$/);
    expect(within(facts).getByText('Tessa Quinn')).toBeInTheDocument();
    expect(within(facts).getByText('human')).toBeInTheDocument();
    expect(within(facts).getByText('active')).toBeInTheDocument();
    expect(within(facts).getByText('managed')).toBeInTheDocument();
    expect(within(facts).getByText(TESSA)).toBeInTheDocument();
    // The role is explained by the board's own catalogue entry.
    const role = section(/^Role$/);
    expect(within(role).getByText(/carries the role/)).toHaveTextContent('tessa carries the role viewer.');
    expect(await within(role).findByText(entryOf('viewer').mayReach)).toBeInTheDocument();
  });

  test('connectors and their credentials with scopes', async () => {
    await openTessa();
    const connectors = section(/^Connectors$/);
    expect(within(connectors).getByRole('link', { name: 'tessa-laptop' })).toBeInTheDocument();
    expect(await within(connectors).findByText('k1livekey')).toBeInTheDocument();
    expect(within(connectors).getByText('tasks:read')).toBeInTheDocument();
    expect(within(connectors).getByText('tasks:write')).toBeInTheDocument();
    expect(within(connectors).getByText('laptop key')).toBeInTheDocument();
    // A revoked credential is listed as revoked, never as live.
    const old = within(connectors).getByText('k0oldkey').closest('li')!;
    expect(within(old).getByText(/^revoked/)).toBeInTheDocument();
    // An Account is keyless: its own credential read answers empty, and says so.
    expect(await within(section(/^Credentials$/)).findByText(/holds no credentials/)).toBeInTheDocument();
  });

  test('grants held, Warrants held, and the last audit rows', async () => {
    await openTessa();
    const grants = section(/^Grants held$/);
    expect(await within(grants).findByText(/write on project/)).toBeInTheDocument();
    expect(within(grants).getByText(/read on every skill/)).toBeInTheDocument();

    const warrants = section(/^Warrants$/);
    expect(await within(warrants).findByText('Nightly builds')).toBeInTheDocument();
    // Only the Warrants THIS identity holds.
    expect(within(warrants).queryByText('Release train')).not.toBeInTheDocument();

    const audit = section(/^Recent audit$/);
    expect(await within(audit).findByText('principal.role.changed')).toBeInTheDocument();
    expect(within(audit).getByText('task.update')).toBeInTheDocument();
    // Newest first, across both reads.
    const actions = within(audit).getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(actions[0]).toContain('task.update');
    expect(actions[1]).toContain('principal.role.changed');
    const more = within(audit).getByRole('link', { name: /Open in the audit log/ });
    expect(more.getAttribute('href')).toBe(`/audit?resourceType=principal&resourceId=${TESSA}`);
  });

  test('every read is a route that already exists, and there is no single-identity read', async () => {
    await openTessa();
    await within(section(/^Recent audit$/)).findByText('task.update');
    await within(section(/^Connectors$/)).findByText('k1livekey');
    const urls = gets();
    expect(urls).toContain('/principals');
    expect(urls).toContain(`/principals/${TESSA}/credentials`);
    expect(urls).toContain(`/principals/${LAPTOP}/credentials`);
    expect(urls).toContain(`/principals/${TESSA}/grants`);
    expect(urls).toContain('/warrants');
    expect(urls).toContain(`/audit?resourceType=principal&resourceId=${TESSA}&limit=10`);
    expect(urls).toContain(`/audit?actorPrincipalId=${TESSA}&limit=10`);
    expect(urls).not.toContain(`/principals/${TESSA}`);
  });

  test('a refused read says so in its own section, and the others still render', async () => {
    state.grants = { ok: false, status: 403, body: { error: 'Forbidden', message: 'principals:admin is required' } };
    await openTessa();
    const grants = section(/^Grants held$/);
    expect(await within(grants).findByText(/principals:admin is required/)).toBeInTheDocument();
    expect(await within(section(/^Warrants$/)).findByText('Nightly builds')).toBeInTheDocument();
  });

  test('a Connector lists its Agents under the same heading rule, and links back to its Account', async () => {
    renderAt(`?identity=${LAPTOP}`);
    await screen.findByRole('heading', { level: 1, name: 'tessa-laptop' });
    expect(within(section(/^Identity$/)).getByRole('link', { name: 'tessa' })).toBeInTheDocument();
    const agents = section(/^Agents$/);
    expect(within(agents).getByRole('link', { name: 'tessa-laptop-agent' })).toBeInTheDocument();
    expect(await within(section(/^Credentials$/)).findByText('k1livekey')).toBeInTheDocument();
  });
});

describe('who is offered the role action', () => {
  test('a non-administrator sees no role action', async () => {
    state.me = { ...DIRECTORY[1], id: '7a7a7a7a-0000-4000-8000-00000000a7a7', handle: 'ulrich', role: 'user' };
    state.scopes = ['principals:read', 'tasks:read'];
    await openTessa();
    const role = section(/^Role$/);
    expect(within(role).queryByRole('button', { name: 'Change role' })).not.toBeInTheDocument();
    expect(within(role).queryByLabelText(/New role/)).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /Change this role/ })).not.toBeInTheDocument();
  });

  test('an administrator is offered it, bounded by their own role', async () => {
    state.me = { ...DIRECTORY[0], handle: 'olive', role: 'operator' };
    state.scopes = ['principals:admin'];
    await openTessa();
    const select = within(section(/^Role$/)).getByLabelText(/New role/);
    const values = Array.from(select.querySelectorAll('option')).map((option) => option.getAttribute('value')).filter(Boolean);
    expect(values).toContain('editor');
    expect(values).not.toContain('admin');
    expect(values).not.toContain('orchestrator');
  });

  test.each([
    ['your own row', ADA, 'ada'],
    ['the internal system actor', SYSTEM, 'system'],
    ['the break-glass identity', OWNER, 'dashboard_user'],
  ])('no role action on %s, and the reason is given', async (_label, id, handle) => {
    renderAt(`?identity=${id}`);
    await screen.findByRole('heading', { level: 1, name: handle });
    const role = section(/^Role$/);
    expect(within(role).queryByRole('button', { name: 'Change role' })).not.toBeInTheDocument();
    expect(within(role).getByText(/route refuses/)).toBeInTheDocument();
  });
});

describe('what the role action does', () => {
  async function confirmEditor() {
    await openTessa();
    const role = section(/^Role$/);
    await userEvent.selectOptions(within(role).getByLabelText(/New role/), 'editor');
    // The chosen role is explained under the selector before anything is sent.
    expect(await within(role).findByText(entryOf('editor').purpose)).toBeInTheDocument();
    await userEvent.click(within(role).getByRole('button', { name: 'Change role' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change role?' });
    expect(within(dialog).getByText(entryOf('editor').mayReach)).toBeInTheDocument();
    expect(within(dialog).getByText(/carries the role viewer now/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change role' }));
  }

  test('confirms with the catalogue entry, posts only the role, and says what the server said', async () => {
    await confirmEditor();
    expect(await screen.findByText(/no re-login is required/)).toBeInTheDocument();
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => call.url.replace(/^.*\/principals/, '/principals'))).toEqual([`/principals/${TESSA}/role`]);
    expect(posts[0].body).toEqual({ role: 'editor' });
    // The board asked for no step-up, so none was minted.
    expect(calls.some((call) => call.url.includes('/auth/step-up'))).toBe(false);
    // The directory is read again, so the page shows the role the board now holds.
    await waitFor(() => expect(gets().filter((url) => url === '/principals').length).toBeGreaterThanOrEqual(2));
  });

  test('a server refusal is surfaced verbatim', async () => {
    state.roleAnswers = [{ ok: false, status: 403, body: { error: 'Forbidden', code: 'ROLE_ACT_REQUIRES_SESSION', message: 'Changing a role is a login-session act.' } }];
    await confirmEditor();
    expect(await screen.findByRole('alert')).toHaveTextContent('Changing a role is a login-session act.');
  });

  test('uses the existing step-up flow when the board answers with the step-up challenge', async () => {
    state.roleAnswers = [{
      ok: false, status: 403,
      body: {
        error: 'Forbidden', code: 'STEP_UP_REQUIRED', message: 'Confirm it is you',
        stepUp: { error: 'insufficient_user_authentication', action: 'principal.role', targetId: TESSA, max_age: 0, methods: ['password'] },
      },
    }];
    await confirmEditor();
    const stepUp = await screen.findByRole('dialog', { name: /Confirm it.s you/ });
    await userEvent.type(await within(stepUp).findByLabelText('Password'), 'correct horse');
    await userEvent.click(within(stepUp).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/no re-login is required/)).toBeInTheDocument();

    const mint = calls.find((call) => call.method === 'POST' && call.url.endsWith('/auth/step-up'))!;
    expect(mint.body).toEqual({ password: 'correct horse', action: 'principal.role', targetId: TESSA });
    const roleCalls = calls.filter((call) => call.method === 'POST' && call.url.endsWith(`/principals/${TESSA}/role`));
    expect(roleCalls.map((call) => call.body)).toEqual([
      { role: 'editor' },
      { role: 'editor', stepUpToken: 'su-token-1' },
    ]);
  });

  test('a challenge bound to another identity is not answered', async () => {
    state.roleAnswers = [{
      ok: false, status: 403,
      body: {
        error: 'Forbidden', code: 'STEP_UP_REQUIRED', message: 'Confirm it is you',
        stepUp: { error: 'insufficient_user_authentication', action: 'principal.role', targetId: ADA, max_age: 0 },
      },
    }];
    await confirmEditor();
    expect(await screen.findByRole('alert')).toHaveTextContent('Confirm it is you');
    expect(screen.queryByRole('dialog', { name: /Confirm it.s you/ })).not.toBeInTheDocument();
    expect(calls.some((call) => call.url.endsWith('/auth/step-up'))).toBe(false);
  });
});

describe('the page is reachable', () => {
  test('axe finds no structural violation, with the role action open', async () => {
    const { container } = await openTessa();
    await within(section(/^Recent audit$/)).findByText('task.update');
    await within(section(/^Connectors$/)).findByText('k1livekey');
    await userEvent.selectOptions(within(section(/^Role$/)).getByLabelText(/New role/), 'editor');
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
      resultTypes: ['violations'],
    });
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.html).join(' | ')}`)).toEqual([]);
  });

  test('the heading takes focus when the page opens, so a screen reader lands on it', async () => {
    await openTessa();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'tessa' })));
  });
});

/* ── Narrow widths ─────────────────────────────────────────────────────── */

/** Only max/min-width conditions are modelled; anything else throws. */
function mediaMatches(list: string, width: number): boolean {
  return list.split(',').some((query) => query.trim().split(/\s+and\s+/i).every((raw) => {
    const feature = raw.trim();
    const size = /^\(\s*(max|min)-width:\s*(\d+)px\s*\)$/.exec(feature);
    if (size) return size[1] === 'max' ? width <= Number(size[2]) : width >= Number(size[2]);
    throw new Error(`unmodelled media condition: ${feature}`);
  }));
}

/** The page's own sheets with every @media block resolved at `width`. */
function stylesAt(width: number): string {
  const out: string[] = [];
  for (const name of ['IdentityDetailPage.css', 'PrincipalsPage.css']) {
    const parse = document.createElement('style');
    parse.textContent = readFileSync(resolvePath(__dirname, name), 'utf8');
    document.head.appendChild(parse);
    try {
      for (const rule of Array.from(parse.sheet?.cssRules ?? [])) {
        if (rule instanceof CSSMediaRule) {
          if (mediaMatches(rule.media.mediaText, width)) out.push(...Array.from(rule.cssRules, (inner) => inner.cssText));
        } else {
          out.push(rule.cssText);
        }
      }
    } finally {
      parse.remove();
    }
  }
  return out.join('\n');
}

describe('narrow widths', () => {
  test.each([320, 375])('nothing on the page refuses to wrap at %ipx', async (width) => {
    const style = document.createElement('style');
    style.textContent = stylesAt(width);
    document.head.appendChild(style);
    try {
      const { container } = await openTessa();
      await within(section(/^Connectors$/)).findByText('k1livekey');
      await within(section(/^Recent audit$/)).findByText('task.update');
      const page = container.querySelector<HTMLElement>('.idd-page')!;
      expect(page).not.toBeNull();
      const problems: string[] = [];
      for (const node of [page, ...Array.from(page.querySelectorAll<HTMLElement>('*'))]) {
        const computed = getComputedStyle(node);
        const name = `${node.tagName.toLowerCase()}${node.className && typeof node.className === 'string' ? `.${node.className.split(' ')[0]}` : ''}`;
        for (const prop of ['minWidth', 'width'] as const) {
          const px = /^(\d+(?:\.\d+)?)px$/.exec(computed[prop]);
          if (px && Number(px[1]) > width) problems.push(`${name} ${prop} is ${computed[prop]}`);
        }
        // A native select and its options carry the user agent's own `pre`;
        // the control itself is measured by its width above, not its text.
        const nativeControl = node.tagName === 'SELECT' || node.tagName === 'OPTION';
        if (!nativeControl && ['nowrap', 'pre'].includes(computed.whiteSpace)) problems.push(`${name} white-space is ${computed.whiteSpace}`);
      }
      // The long unbroken values — ids, key ids, scopes, actions — can break anywhere.
      for (const selector of ['.idd-id', '.idd-code', '.idd-scope', '.idd-audit-action']) {
        const nodes = Array.from(page.querySelectorAll<HTMLElement>(selector));
        expect(nodes.length, `${selector} is rendered`).toBeGreaterThan(0);
        for (const node of nodes) {
          if (getComputedStyle(node).overflowWrap !== 'anywhere') problems.push(`${selector} overflow-wrap is ${getComputedStyle(node).overflowWrap || 'unset'}`);
        }
      }
      // Every row of facts wraps rather than overflowing.
      for (const row of Array.from(page.querySelectorAll<HTMLElement>('.idd-row'))) {
        const computed = getComputedStyle(row);
        if (computed.display !== 'flex') problems.push(`.idd-row display is ${computed.display}`);
        if (computed.flexWrap !== 'wrap') problems.push(`.idd-row flex-wrap is ${computed.flexWrap}`);
      }
      expect(page.querySelectorAll('.idd-row').length).toBeGreaterThan(3);
      expect(problems).toEqual([]);
    } finally {
      style.remove();
    }
  });
});
