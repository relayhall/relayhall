// @vitest-environment jsdom
/**
 * axe-core over the surfaces RH-LENSES-d adds (card 4e159741; design
 * 96f0bd3d s8.4, "the catalog UI, per-lens navigation, designed empty states,
 * a11y"): the Sidebar's Administration group, the Directory page populated
 * (with the Use this group form open) and in its first-week empty state, and
 * the Groups page populated and empty.
 *
 * Every surface is audited POPULATED as well as empty - an empty list audits
 * no rows - and the audit is first shown to fail on markup it must fail on.
 *
 * HONEST SCOPE, inherited from a11y.smoke.test.tsx: jsdom has no layout
 * engine, so colour contrast is not judged here; every colour these pages use
 * is a Theme token, and the Themes' pairings are enforced by
 * scripts/check-design-contrast.py. What this covers is structure: roles,
 * names, labels, landmarks, headings, ids, ARIA validity.
 */
import axe from 'axe-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

let replies: Record<string, unknown> = {};

const useMyPrincipal = vi.fn(() => ({ me: { id: 'p0', role: 'admin', handle: 'root-person' }, scopes: ['root'], loading: false }));
vi.mock('./hooks/usePrincipals', () => ({ useMyPrincipal: () => useMyPrincipal() }));
vi.mock('./contexts/PluginContext', () => ({
  usePlugins: () => ({ plugins: [], pluginSidebarItems: [], loading: false }),
}));
vi.mock('./utils/browserSession', () => ({ useBrowserSession: () => undefined }));
vi.mock('./utils/auth', () => ({
  auth: { getToken: () => 't', clearToken: () => {}, isAuthenticated: () => true, logout: () => {} },
  authenticatedFetch: vi.fn(async (url: string) => {
    const path = String(url).replace(/^\/api/, '');
    if (path in replies) return { ok: true, status: 200, json: async () => replies[path] };
    return { ok: true, status: 200, json: async () => ({}) };
  }),
}));

import { Sidebar } from './components/Sidebar';
import { DirectoryPage } from './pages/DirectoryPage';
import { GroupsPage } from './pages/GroupsPage';

const RULES_JSDOM_CANNOT_JUDGE = { 'color-contrast': { enabled: false } } as const;
async function auditOf(root: Element): Promise<axe.Result[]> {
  const results = await axe.run(root, { rules: RULES_JSDOM_CANNOT_JUDGE, resultTypes: ['violations'] });
  return results.violations;
}
function describeViolations(violations: axe.Result[]): string {
  return violations
    .map((violation) => `${violation.id} (${violation.impact}): ${violation.help}\n      ${violation.nodes.map((node) => node.html).join('\n      ')}`)
    .join('\n');
}

const ADMIN = { lenses: ['member', 'admin'], admin: true };
const POPULATED = {
  '/principals/me/lenses': ADMIN,
  '/identity-providers': { success: true, identityProviders: [{ id: 'idp-1', name: 'Company SSO', status: 'active' }] },
  '/groups/directory-sync': { success: true, providers: [{ provider: 'idp-1', lastSuccessAt: null, lastErrorPresent: true, stalenessThresholdHours: 24, stale: true }] },
  '/directory-group-references': { success: true, references: [
    { id: '11111111-1111-4111-8111-111111111111', identityProviderId: 'idp-1', externalGroupRef: 'cn=engineering', displayName: 'Engineering',
      memberCount: 12, sources: ['claim'], lastSeenAt: '2026-10-19T10:00:00.000Z', boundGroupId: null, boundGroupName: null },
    { id: '22222222-2222-4222-8222-222222222222', identityProviderId: 'idp-1', externalGroupRef: 'cn=design', displayName: null,
      memberCount: 3, sources: ['scim'], lastSeenAt: '2026-10-19T10:00:00.000Z', boundGroupId: 'g-1', boundGroupName: 'Design team' },
  ] },
  '/groups': { success: true, groups: [
    { id: 'g-1', name: 'Design team', description: 'Bound', memberCount: 3, identityProviderId: 'idp-1', externalGroupRef: 'cn=design', featured: true },
    { id: 'g-2', name: 'Reviewers', description: '', memberCount: 2, identityProviderId: null, externalGroupRef: null, featured: false },
  ] },
};
const EMPTY = {
  '/principals/me/lenses': ADMIN,
  '/identity-providers': { success: true, identityProviders: [] },
  '/groups/directory-sync': { success: true, providers: [] },
  '/directory-group-references': { success: true, references: [] },
  '/groups': { success: true, groups: [] },
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the audit itself', () => {
  test('fails on markup it should fail on', async () => {
    const { container } = render(<div><button /><input type="text" /></div>);
    expect((await auditOf(container)).map((violation) => violation.id).sort()).toEqual(['button-name', 'label']);
  });
});

describe('the lens surfaces are accessible', () => {
  test('the Sidebar with the Administration group drawn', async () => {
    replies = POPULATED;
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
    const { container } = render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Directory' })).toBeInTheDocument();
    const violations = await auditOf(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  test('the Directory page, populated, with the Use this group form open', async () => {
    replies = POPULATED;
    const { container } = render(<MemoryRouter><DirectoryPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Use the directory group Engineering' }));
    expect(screen.getByLabelText('Group name')).toBeInTheDocument();
    const violations = await auditOf(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  test('the Directory page in its first-week empty state', async () => {
    replies = EMPTY;
    const { container } = render(<MemoryRouter><DirectoryPage /></MemoryRouter>);
    expect(await screen.findByText('No Identity provider is connected yet.')).toBeInTheDocument();
    const violations = await auditOf(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  test('the Groups page, populated and empty', async () => {
    replies = POPULATED;
    const populated = render(<MemoryRouter><GroupsPage /></MemoryRouter>);
    expect(await screen.findByRole('table', { name: 'Every board group' })).toBeInTheDocument();
    let violations = await auditOf(populated.container);
    expect(violations, describeViolations(violations)).toEqual([]);
    cleanup();
    replies = EMPTY;
    const empty = render(<MemoryRouter><GroupsPage /></MemoryRouter>);
    expect(await screen.findByText('No groups yet.')).toBeInTheDocument();
    violations = await auditOf(empty.container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
