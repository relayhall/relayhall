// @vitest-environment jsdom
/**
 * axe-core over the Services page (card 08792425, member N6): the knowledge
 * source registration panel with a pasted bundle previewed and a registered
 * source waiting for the operator, and its first-run empty state, at desktop
 * width and at 375 px.
 *
 * HONEST SCOPE, inherited from a11y.smoke.test.tsx: jsdom has no layout
 * engine, so colour contrast is not judged here and the 375 px run measures
 * structure under the narrow media queries, not geometry; every colour the
 * page uses is a Theme token, and the Themes' pairings are enforced by
 * scripts/check-design-contrast.py. What this covers is structure: roles,
 * names, labels, landmarks, headings, ids, ARIA validity.
 */
import axe from 'axe-core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const SERVICE_ID = '11111111-2222-4333-8444-555555555555';
const FINGERPRINT = '0123456789abcdef'.repeat(4);
let registrations: unknown[] = [];

vi.mock('./utils/auth', () => ({
  auth: { getToken: () => 't', clearToken: () => {}, isAuthenticated: () => true, logout: () => {} },
  authenticatedFetch: vi.fn(async (url: string) => {
    const path = String(url).replace(/^\/api/, '');
    if (path === '/knowledge-source-registrations') return new Response(JSON.stringify({ success: true, registrations }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }),
}));

import { ServicesPage } from './pages/ServicesPage';

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

const WAITING = {
  schemaVersion: 'rh.knowledge-source.registration-state/1',
  service: { id: SERVICE_ID, slug: 'team-knowledge', name: 'Team knowledge', status: 'published', currentDescriptorVersion: 1 },
  endpoints: { query: 'https://knowledge.example.org/knowledge/search', get: null, write: null, allowedNetworks: ['100.64.0.0/24'] },
  fingerprint: { sha256: FINGERPRINT, display: (FINGERPRINT.toUpperCase().match(/.{2}/g) ?? []).join(':'), confirmation: 'checked', confirmedBy: 'p1', confirmedAt: '2026-10-21T12:00:00.000Z' },
  channel: { credentialReference: 'knowledge-source/team-knowledge', environmentVariable: 'RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS', resolves: false, dial: 'refused', refusal: 'unavailable:transport' },
  operatorSteps: [
    { id: 'place-channel-bearer', done: false, text: 'On the core host, as root: add an entry named "knowledge-source/team-knowledge" to the JSON in RELAYHALL_KNOWLEDGE_SOURCE_CREDENTIALS.' },
    { id: 'restart-core', done: false, text: 'Restart the core so it reads the new environment.' },
  ],
  lifecycleExport: { configured: false, keyRecorded: false },
  assertionKeysConfigured: true,
  grantsForApproval: { scope: 'knowledge-contents:read', targetType: 'grant.rows', decidedOn: '/approvals', change: { rules: [] } },
};
const BUNDLE = {
  schema: 'rh.knowledge-source.registration/1', name: 'Second source', endpoint: 'https://second.example.org/knowledge/search',
  descriptor: { options: [], knowledgeSource: { classes: [{ key: 'notes', content: 'docs' }], compartments: [], protocol_version: 2, compartment_mode: 'dynamic-opaque', categories: ['note'] } },
  certificateSha256: 'ab'.repeat(32),
};

function atWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    const matches = (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
    return { matches, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} };
  });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the audit itself', () => {
  test('fails on markup it should fail on', async () => {
    const { container } = render(<div><button /><input type="text" /></div>);
    expect((await auditOf(container)).map((violation) => violation.id).sort()).toEqual(['button-name', 'label']);
  });
});

describe.each([1280, 375])('the Services page is accessible at %ipx', (width) => {
  test('populated: a registered source waiting for the operator, and a pasted bundle previewed', async () => {
    atWidth(width);
    registrations = [WAITING];
    const { container } = render(<MemoryRouter><ServicesPage /></MemoryRouter>);
    expect(await screen.findByRole('article', { name: 'Team knowledge' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Registration bundle/), { target: { value: JSON.stringify(BUNDLE) } });
    expect(screen.getByLabelText(/I compared this fingerprint/)).toBeInTheDocument();
    const violations = await auditOf(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  test('empty: no source registered yet', async () => {
    atWidth(width);
    registrations = [];
    const { container } = render(<MemoryRouter><ServicesPage /></MemoryRouter>);
    expect(await screen.findByText('No knowledge source has been registered from a bundle yet.')).toBeInTheDocument();
    const violations = await auditOf(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
