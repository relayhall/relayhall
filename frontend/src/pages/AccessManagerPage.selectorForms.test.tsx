// @vitest-environment jsdom
/**
 * RH-AZ.PROJ-b (card 95572530) — the FOURTH selector form, as the Access
 * manager says it out loud.
 *
 * `ruleSummary` turns one object rule into the sentence an approver reads
 * before ticking a box that grants authority. Until this card it ended in a
 * bare `else` meaning `exact`, so a form the backend admitted and this page had
 * not learned would have been LABELLED as a pinned id list — the narrowest
 * reading — while the authority it actually carried was future-inclusive. An
 * approver deciding from that label decides from a false one.
 *
 * These tests render the REAL page and read the REAL chip text, through the
 * approvals card's `requestedRules` — the one surface that calls `ruleSummary`.
 * A test that called the function directly would prove nothing about what an
 * approver sees.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

const useMyPrincipal = vi.fn();
const usePrincipals = vi.fn();
vi.mock('../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => usePrincipals(),
}));

const routes = new Map<string, unknown>();
vi.mock('../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string) => {
    for (const [prefix, body] of routes) {
      if (url.includes(prefix)) return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

import { AccessManagerPage } from './AccessManagerPage';

const APPROVAL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PROJECT_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROJECT_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function seed(requestedRules: unknown[]): void {
  routes.clear();
  routes.set('/approvals', {
    success: true,
    approvals: [{
      id: APPROVAL_ID,
      // DECIDED, not pending: a decided approval renders each rule as a plain
      // chip rather than a checkbox, which is the read-only reading path and
      // keeps this file away from the step-up dialog the sibling suite pins.
      status: 'approved',
      requesterPrincipalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      requesterHandle: 'conn-alpha',
      targetTaskId: TASK,
      targetTaskTitle: 'Fix the flux',
      requestedScopes: ['tasks:read'],
      requestedRules,
      approvedScopes: ['tasks:read'],
      lapseReason: null, denialReason: null,
      requestedAt: new Date().toISOString(),
      pendingExpiresAt: null, collectExpiresAt: null,
    }],
  });
  routes.set('/warrants', { success: true, warrants: [] });
  routes.set('/access-profiles', { success: true, profiles: [] });
  routes.set('/principals/remediation-queue', { success: true, queue: [] });
  routes.set('/groups/directory-sync', { success: true, providers: [] });
}

function renderExpanded(): void {
  useMyPrincipal.mockReturnValue({ me: { id: 'root-id', role: 'orchestrator' }, scopes: ['root'], loading: false });
  usePrincipals.mockReturnValue({ principals: [] });
  render(
    <MemoryRouter initialEntries={[`/settings/access-manager?approval=${APPROVAL_ID}`]}>
      <AccessManagerPage />
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the Access manager names the fourth selector form', () => {
  test('a project-bounded rule reads as every, in N projects — never as a pinned list', async () => {
    seed([{ resourceType: 'task', selectorForm: 'all-in-project', selectorIds: [PROJECT_A, PROJECT_B], verbs: ['read'] }]);
    renderExpanded();
    await waitFor(() => {
      expect(screen.getByText('read on every (in 2 projects) task')).toBeInTheDocument();
    });
    // THE DEFECT THIS ASSERTION EXISTS FOR: the old trailing `:` branch would
    // have rendered "read on 2 exact task" — a future-inclusive perimeter
    // described to the approver as two pinned ids.
    expect(screen.queryByText('read on 2 exact task')).not.toBeInTheDocument();
  });

  test('one project reads as one project, not "1 projects"', async () => {
    seed([{ resourceType: 'phase', selectorForm: 'all-in-project', selectorIds: [PROJECT_A], verbs: ['read', 'write'] }]);
    renderExpanded();
    await waitFor(() => {
      expect(screen.getByText('read/write on every (in 1 project) phase')).toBeInTheDocument();
    });
  });

  test('the three ratified forms read exactly as they did', async () => {
    seed([
      { resourceType: 'task', selectorForm: 'all-of-type', selectorIds: [], verbs: ['read'] },
      { resourceType: 'task', selectorForm: 'all-except', selectorIds: [TASK], verbs: ['read'] },
      { resourceType: 'report', selectorForm: 'exact', selectorIds: [TASK], verbs: ['read'] },
    ]);
    renderExpanded();
    await waitFor(() => {
      expect(screen.getByText('read on every task')).toBeInTheDocument();
    });
    expect(screen.getByText('read on all except 1 task')).toBeInTheDocument();
    expect(screen.getByText('read on 1 exact report')).toBeInTheDocument();
  });

  test('a form this page has not learned reads as UNRECOGNISED, never as a pinned list', async () => {
    // The property that outlives this card. The backend and this page ship
    // separately; the day a fifth form lands, an approver must see that the
    // page cannot describe it rather than a confident wrong sentence.
    seed([{ resourceType: 'task', selectorForm: 'all-in-phase', selectorIds: [TASK], verbs: ['read'] }]);
    renderExpanded();
    await waitFor(() => {
      expect(screen.getByText(/unrecognised selector \(all-in-phase\)/)).toBeInTheDocument();
    });
    expect(screen.queryByText('read on 1 exact task')).not.toBeInTheDocument();
  });
});
