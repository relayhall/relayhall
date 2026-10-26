// @vitest-environment jsdom
/**
 * axe-core over the surfaces lane L1 adds (card b1e3b16d): the bell in the
 * account row and in the closed mobile bar, its open panel, the dashboard's
 * decision notice in both of its visible states, the approvals hub with an
 * item's drawer open, and the notification centre's tabs — three since owner
 * E84 (card e2dd52b8 Part A), the third the hub itself. Hub lanes L2 and
 * L4 add: the history with its filters, Load more, its empty and error states;
 * the bell's panel with approval and skill rows; the grouped hub with its item
 * cards (who asked, what, when, who decides) and a skill version in review; the
 * drawer with its token links; and the Access-manager-mounted grant detail.
 * Review round 2 adds a verification request waiting on its verifier, expanded.
 * The universal change request's slice S3 (card 502fb19e) adds: a change item
 * expanded with its "Before and after" region and its narrowing controls, the
 * "Request a change" button and dialog, and the "My requests" tab.
 *
 * Slice B of the Notifications and Timeline design (card 5854f0d6) replaces
 * the history with "Needs your action" and the Timeline: the bell's pinned
 * popover with every action kind, the action list (grouped, capped), the
 * Timeline with filters, day groups, the "new since your last visit" divider
 * and its Load more fallback, its 503 and empty states, the dashboard card and
 * the Activity widget — each at desktop width and at 375 px.
 *
 * Owner rulings E453 and E455 add, each at desktop width and at 375 px: the
 * Action Center's left-menu entry, its five tabs with Agent sessions as the
 * fifth, the Timeline's folded filter bar with its search box and chips and
 * the unfolded filter groups, and the seen mark (Mark seen per item, Mark all
 * seen, seen rows) on the action list and in the bell's popover.
 *
 * Every surface is rendered POPULATED — an empty list audits no rows — and
 * the same audit is first shown to fail on markup it must fail on.
 *
 * HONEST SCOPE, inherited from a11y.smoke.test.tsx: jsdom has no layout
 * engine, so colour contrast is not judged here; every colour these surfaces
 * use is a Theme token (`hubThemeTokens.test.ts`), and the Themes' pairings are
 * enforced by scripts/check-design-contrast.py. What this file covers is
 * structure: roles, names, labels, landmarks, headings, ids, ARIA validity.
 */
import axe from 'axe-core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const useMyPrincipal = vi.fn();
vi.mock('./hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => ({ principals: [] }),
}));
vi.mock('./contexts/PluginContext', () => ({
  usePlugins: () => ({ plugins: [], pluginSidebarItems: [], pluginRoutes: [], loading: false }),
}));
vi.mock('./utils/browserSession', () => ({ useBrowserSession: () => undefined }));

const APPROVAL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const approval = (id: string, handle: string, title: string) => ({
  id, status: 'pending', requesterPrincipalId: `p-${handle}`, requesterHandle: handle, targetTaskId: `t-${id}`,
  targetTaskTitle: title, requestedScopes: ['tasks:read'], requestedRules: [], approvedScopes: null,
  lapseReason: null, denialReason: null, requestedAt: new Date(Date.now() - 3600_000 * 3).toISOString(),
  pendingExpiresAt: new Date(Date.now() + 3600_000 * 5).toISOString(), collectExpiresAt: null,
});
const APPROVALS = [approval(APPROVAL_ID, 'conn-alpha', 'Fix the flux'), approval('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'conn-beta', 'Tune the relay')];
const since = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const ACTIONS = [
  { key: 'decision:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', kind: 'decision', reasons: ['agent-mint'], since: since(30),
    object: { type: 'approval', id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', title: 'Fix the flux' }, project: { id: 'pr-1', name: 'Relay project' },
    href: '/notifications?tab=approvals&approval=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', detail: { approvalKind: 'agent-mint', requesterHandle: 'conn-alpha' } },
  { key: 'decision:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'decision', reasons: ['grant'], since: since(3),
    object: { type: 'approval', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Tune the relay' }, project: null,
    href: '/notifications?tab=approvals&approval=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', detail: { approvalKind: 'grant', requesterHandle: 'conn-beta' } },
  { key: 'verify:t-verify', kind: 'verify', reasons: ['verifier', 'no-verifier'], since: since(5),
    object: { type: 'task', id: 't-verify', title: 'Verify the relay' }, project: { id: 'pr-1', name: 'Relay project' }, href: '/tasks/t-verify', detail: {} },
  { key: 'stuck:t1', kind: 'stuck', reasons: ['episode'], since: since(1),
    object: { type: 'task', id: 't1', title: 'Stuck fixture task' }, project: null, href: '/tasks/t1', detail: { reason: 'status_stale' } },
  { key: 'skill:sk-1', kind: 'skill', reasons: ['skill-publish'], since: since(26),
    object: { type: 'skill', id: 'sk-1', title: 'terraform-review' }, project: null, href: '/skills?skill=sk-1',
    detail: { versionId: 'v3', version: 3, requesterHandle: 'editor-one' } },
];
const actionsBody = (items: typeof ACTIONS, capped = false) => ({
  success: true, items,
  counts: {
    decision: items.filter((i) => i.kind === 'decision').length, verify: items.filter((i) => i.kind === 'verify').length,
    stuck: items.filter((i) => i.kind === 'stuck').length, skill: items.filter((i) => i.kind === 'skill').length, total: items.length,
  },
  capped: { decision: false, verify: false, stuck: capped, skill: false },
});
const tlAt = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().replace('Z', '000Z');
const TIMELINE = [
  { key: 'feed:41', at: tlAt(2), kind: 'status', label: 'Status moved', object: { type: 'task', id: 't2', title: 'Moved fixture task' },
    project: { id: 'pr-1', name: 'Relay project' }, actor: { handle: 'owner-one' }, detail: { name: 'task.updated', from: 'todo', to: 'review', fields: ['status'] } },
  { key: 'feed:40', at: tlAt(20), kind: 'report', label: 'Report', object: { type: 'report', id: 'r1', title: 'Night report' },
    project: null, actor: { handle: 'agent-one' }, detail: { name: 'report.created', handover: true } },
  { key: 'approval-event:cccccccc-cccc-4ccc-8ccc-cccccccccccc', at: tlAt(30), kind: 'approval', label: 'Approval',
    object: { type: 'approval', id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', title: null }, project: null, actor: { handle: null },
    detail: { action: 'approval.denied', approvalKind: 'grant', approvalStatus: 'denied', taskId: null } },
  { key: 'feed:39', at: tlAt(3000), kind: 'stuck', label: 'Stuck', object: { type: 'task', id: 't1', title: 'Stuck fixture task' },
    project: null, actor: { handle: null }, detail: { name: 'task.stuck', reason: 'lease_expired' } },
  { key: 'skill-event:dddddddd-dddd-4ddd-8ddd-dddddddddddd', at: tlAt(3100), kind: 'skill-version', label: 'Skill version decided',
    object: { type: 'skill', id: 'sk-1', title: 'terraform-review' }, project: null, actor: { handle: 'root' },
    detail: { version: 3, decision: 'published', from: 'review', to: 'published' } },
];

const HUB_ITEMS = [
  { ...approval(APPROVAL_ID, 'conn-alpha', 'Fix the flux'), kind: 'agent-mint',
    refs: { task: { id: `t-${APPROVAL_ID}`, title: 'Fix the flux' }, phase: null, project: { id: 'pr-1', title: 'Relay project' } },
    ownership: { class: 'group', groups: [{ id: 'g1', name: 'Alpha team' }, { id: 'g2', name: 'Zulu team' }], ownerHandle: null, ownerIsViewer: false },
    deciders: { rule: 'Root, or the Account that owns the requesting connector, with step-up.', stepUp: true },
    decidable: true, decideVia: {} },
  { ...approval('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'conn-beta', 'Tune the relay'), kind: 'grant', targetTaskId: null, targetTaskTitle: null,
    refs: { task: { id: 't-rel', title: null }, phase: null, project: null },
    ownership: { class: 'private', groups: [], ownerHandle: null, ownerIsViewer: false },
    deciders: { rule: 'Root, or an administrator signed in to the dashboard, with step-up.', stepUp: true },
    decidable: false, decideVia: {},
    accessRequest: { granteePrincipalId: 'p-acct', granteeHandle: 'acct', reason: 'The run needs this card to finish its handover.',
      requestedExpiresAt: new Date(Date.now() + 86400000 * 14).toISOString(), approvedExpiresAt: null, relatedTaskId: 't-rel',
      relatedTaskTitle: 'Related task', relatedPhaseId: null, relatedPhaseName: null, relatedProjectId: 'pr-1', relatedProjectTitle: 'Relay project',
      createdGrantIds: [], ruleViews: [{ resourceType: 'task', selectorForm: 'exact', verbs: ['read'], objects: [{ id: 't-x', title: 'Asked task' }], allOfType: null }] } },
  { ...approval('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'editor-one', 'unused'), kind: 'skill-publish', targetTaskId: null, targetTaskTitle: null,
    pendingExpiresAt: null, refs: { task: null, phase: null, project: null },
    ownership: { class: 'board', groups: [], ownerHandle: null, ownerIsViewer: false },
    deciders: { rule: 'A person holding skills:admin who did not write this version. Publishing takes no step-up.', stepUp: false },
    decidable: true, decideVia: {},
    skill: { id: 'sk-1', name: 'terraform-review', version: 3, description: 'Reviews Terraform plans.', provenance: 'agent-drafted' } },
  { ...approval('cccccccc-0000-4ccc-8ccc-cccccccccccc', 'shepherd-one', 'Verify the relay'), kind: 'native-review', requestedScopes: [],
    refs: { task: { id: 't-verify', title: 'Verify the relay' }, phase: null, project: { id: 'pr-1', title: 'Relay project' } },
    ownership: { class: 'private', groups: [], ownerHandle: 'owner-account', ownerIsViewer: true },
    deciders: { rule: 'verifier-bot through Native verifier records the verdict on the task. Nothing is decided on this page.', stepUp: false },
    decidable: false, decideVia: {},
    verification: { state: 'leased', serviceId: 'svc-1', serviceName: 'Native verifier', descriptorVersion: 1,
      verifierPrincipalId: 'p-verifier', verifierHandle: 'verifier-bot',
      requestExpiresAt: new Date(Date.now() + 3600_000 * 20).toISOString(), leaseExpiresAt: new Date(Date.now() + 3600_000).toISOString() } },
];
const NO_HEAD = { feed: null, approvals: null, skills: null };
const CHANGE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CHANGE_PROJECT = '99999999-9999-4999-8999-999999999999';
const changeItem = (view: 'decider' | 'requester') => ({
  ...approval(CHANGE_ID, 'owner-account', 'unused'), kind: 'change', targetTaskId: null, targetTaskTitle: null, requestedScopes: [],
  requesterPrincipalId: 'p1',
  refs: { task: null, phase: null, project: null },
  ownership: { class: 'board', groups: [], ownerHandle: null, ownerIsViewer: false },
  deciders: { rule: 'Root, an administrator signed in to the dashboard, or the owner of every object it names (a person, or a Group owner), with step-up.', stepUp: true },
  decidable: view === 'decider', decideVia: {}, view,
  decisionRefusal: view === 'decider' ? null : { code: 'SELF_DECISION_REFUSED', message: 'you are the requester' },
  change: {
    targetType: 'knowledge.compartment', targetId: null, targetObjects: [{ type: 'project', id: CHANGE_PROJECT }],
    granteeType: 'principal', granteePrincipalId: 'p-reader', granteeHandle: 'reader-one', reason: 'My assistant needs my project notes.',
    spec: { type: 'knowledge.compartment', before: { rows: [] },
      requested: { sourceId: 'src-1', operation: 'read', subject: { type: 'user', id: 'p-reader' }, projectIds: [CHANGE_PROJECT], expiresAt: new Date(Date.now() + 86400000 * 14).toISOString() },
      approved: null, diff: null },
    appliedAt: null, appliedEffect: null, deciderStanding: null, relatedTaskId: null, relatedPhaseId: null,
  },
  fieldDiff: [{ field: 'projectIds', before: null, after: [CHANGE_PROJECT] }, { field: 'operation', before: null, after: 'read' }],
  relationships: view === 'decider' ? { summary: '1 principal gains read on 1 object; nothing is removed', edges: [
    { principal: { type: 'principal', id: 'p-reader' }, object: `compartment:${CHANGE_PROJECT}`, action: 'read', before: false, after: true, via: 'knowledge', state: 'added' },
  ] } : null,
});
let changeFixtures = false;
let hubFixtures = false;
let actionsStatus = 200;
let actionRows: typeof ACTIONS = [];
let actionsCapped = false;
let timelineStatus: { status: number; code: string } | null = null;
let timelineRows: unknown[] = [];

let approvalsStatus = 200;
vi.mock('./utils/auth', () => ({
  auth: { isAuthenticated: () => true, getToken: () => 'token', logout: vi.fn(), clearToken: vi.fn() },
  authenticatedFetch: vi.fn(async (input: string) => {
    const url = String(input);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (changeFixtures) {
      if (url.includes('/approvals/requests/preview')) {
        return ok({ success: true, requestable: [{ targetType: 'grant.rows', grantees: 'any', fields: ['rules', 'expiresAt'],
          bound: { verbs: ['read', 'write'] }, deciders: [{ standing: 'root', rule: 'Root, with step-up.' }], before: { rows: [] } }], refused: [] });
      }
      if (url.includes('/knowledge-sources')) return ok({ success: true, sources: [] });
      if (url.includes('/projects')) return ok({ success: true, projects: [{ id: CHANGE_PROJECT, name: 'Garden notes' }] });
      if (url.includes('/approvals?view=hub')) return ok({ success: true, view: 'hub', approvals: [changeItem(url.includes('kind=change') ? 'requester' : 'decider')] });
    }
    if (url.endsWith(`/approvals/${APPROVAL_ID}`)) {
      return ok({ success: true, approval: APPROVALS[0], events: [
        { id: 2, occurredAt: new Date().toISOString(), action: 'approval.approved', actorPrincipalId: 'p-root', actorHandle: 'root', metadata: { editedScopes: ['tasks:read'] } },
        { id: 1, occurredAt: new Date().toISOString(), action: 'approval.requested', actorPrincipalId: 'p-conn-alpha', actorHandle: 'conn-alpha', metadata: {} },
      ] });
    }
    if (url.includes('/approvals')) {
      if (approvalsStatus !== 200) return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: approvalsStatus });
      if (!hubFixtures) return ok({ success: true, approvals: APPROVALS });
      // The default list carries no hub field, no skill version and no verification
      // request: exactly what GET /approvals answers.
      return ok({ success: true, approvals: url.includes('view=hub') ? HUB_ITEMS : HUB_ITEMS
        .filter((item) => item.kind !== 'skill-publish' && item.kind !== 'native-review')
        .map(({ refs: _r, ownership: _o, deciders: _d, decidable: _c, decideVia: _v, ...plain }) => plain) });
    }
    if (url.includes('/notifications/actions')) {
      if (actionsStatus !== 200) return new Response(JSON.stringify({ code: 'NOTIFICATION_ACTIONS_READ_FAILED' }), { status: actionsStatus });
      return ok(actionsBody(actionRows, actionsCapped));
    }
    if (url.includes('/notifications/actions/seen')) return ok({ ...actionsBody(actionRows), marked: 1 });
    if (url.includes('/telemetry/presence')) return ok({ success: true, sources: [] });
    if (url.includes('/telemetry/sessions')) return ok({ success: true, sessions: [], total: 0, hiddenCount: 0, shortCount: 0, nextOffset: null });
    if (url.includes('/notifications/timeline/seen')) return ok({ success: true, lastSeen: '41' });
    if (url.includes('/notifications/timeline')) {
      if (timelineStatus) return new Response(JSON.stringify({ code: timelineStatus.code }), { status: timelineStatus.status });
      return ok({ success: true, items: timelineRows, nextCursor: timelineRows.length > 0 ? 'next' : null, hasMore: timelineRows.length > 0,
        headCursor: timelineRows.length > 0 ? { feed: '41', approvals: tlAt(30), skills: tlAt(3100) } : NO_HEAD, lastSeen: '40' });
    }
    return ok({ success: true });
  }),
}));

import { Sidebar } from './components/Sidebar';
import { DecisionNotice } from './components/approvals/DecisionNotice';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { AccessManagerPage } from './pages/AccessManagerPage';
import { NotificationBell } from './components/notifications/NotificationBell';
import { KnowledgePage } from './pages/KnowledgePage';
import { RequestChangeDialog } from './components/approvals/RequestChangeDialog';
import { NotificationsCard } from './components/dashboard/NotificationsCard';
import { ActivityFeed } from './components/dashboard/ActivityFeed';

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

beforeEach(() => {
  approvalsStatus = 200;
  changeFixtures = false;
  hubFixtures = false;
  actionsStatus = 200;
  actionRows = ACTIONS;
  actionsCapped = false;
  timelineStatus = null;
  timelineRows = TIMELINE;
  useMyPrincipal.mockReturnValue({ me: { id: 'p1', role: 'user', handle: 'river' }, scopes: ['tasks:read'], loading: false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the audit itself', () => {
  test('fails on markup it should fail on', async () => {
    const { container } = render(<div><button /><input type="text" /></div>);
    expect((await auditOf(container)).map((violation) => violation.id).sort()).toEqual(['button-name', 'label']);
  });
});

describe('lane L1 surfaces are axe-clean', () => {
  test('the account row with its bell, and the bell\'s open panel', async () => {
    render(<MemoryRouter><Sidebar connected /><main><h1>Dashboard</h1></main></MemoryRouter>);
    const bell = await screen.findByRole('button', { name: 'Notifications: 5 need your action' });
    expect(describeViolations(await auditOf(document.body))).toBe('');
    await userEvent.click(bell);
    expect(screen.getByRole('dialog', { name: 'Needs your action' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix the flux' })).toBeInTheDocument();
    expect(describeViolations(await auditOf(document.body))).toBe('');
  });

  test('the closed mobile bar: chip and bell', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
    const { container } = render(<MemoryRouter><Sidebar connected /><main><h1>Dashboard</h1></main></MemoryRouter>);
    await screen.findByRole('button', { name: 'Notifications: 5 need your action' });
    expect(container.querySelector('.sidebar-mobile-bell--in-chip')).toBeInTheDocument();
    expect(describeViolations(await auditOf(container))).toBe('');
  });

  test('the decision notice with decisions waiting', async () => {
    const { container } = render(<MemoryRouter><main><h1>Dashboard</h1><DecisionNotice /></main></MemoryRouter>);
    await screen.findByText('2 decisions need you');
    expect(describeViolations(await auditOf(container))).toBe('');
  });

  test('the decision notice in its error state', async () => {
    approvalsStatus = 500;
    const { container } = render(<MemoryRouter><main><h1>Dashboard</h1><DecisionNotice /></main></MemoryRouter>);
    await screen.findByText(/Couldn.t check pending decisions/);
    expect(describeViolations(await auditOf(container))).toBe('');
  });

  test('the approvals hub with an item\'s drawer open', async () => {
    render(<MemoryRouter initialEntries={[`/approvals?approval=${APPROVAL_ID}`]}><main><ApprovalsPage /></main></MemoryRouter>);
    await screen.findByText('conn-beta');
    const drawer = await screen.findByRole('dialog', { name: 'Approval history' });
    await waitFor(() => expect(drawer).toHaveTextContent('Who did what'));
    expect(describeViolations(await auditOf(document.body))).toBe('');
  });

  test('the Action Center, its tabs: the Approvals tab populated, with an item\'s drawer open', async () => {
    hubFixtures = true;
    const { container } = render(<MemoryRouter initialEntries={['/action-center']}><main><NotificationsPage /></main></MemoryRouter>);
    await screen.findByText('Verify the relay');
    // Five tabs: "My requests" since slice S3 of the change requests (card 502fb19e), Agent sessions since E453.
    expect(within(screen.getByRole('tablist', { name: 'Action Center view' })).getAllByRole('tab')).toHaveLength(5);
    expect(describeViolations(await auditOf(container))).toBe('');
    await userEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    await screen.findByRole('region', { name: 'Timeline' });
    await screen.findByRole('link', { name: 'Moved fixture task' });
    expect(describeViolations(await auditOf(container))).toBe('');
    await userEvent.click(screen.getByRole('tab', { name: 'Approvals' }));
    const panel = screen.getByRole('tabpanel', { name: 'Approvals' });
    await within(panel).findByText('conn-beta');
    expect(within(panel).getByRole('heading', { name: /Group: Alpha team/ })).toBeInTheDocument();
    expect(describeViolations(await auditOf(container))).toBe('');
    await userEvent.click(within(panel).getByRole('button', { name: /^History: conn-alpha/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Approval history' });
    await waitFor(() => expect(drawer).toHaveTextContent('Who did what'));
    expect(describeViolations(await auditOf(container))).toBe('');
  });
});

describe('hub lanes L2 and L4 surfaces are axe-clean', () => {
  beforeEach(() => { hubFixtures = true; });

  test('the bell\'s pinned popover with every action kind', async () => {
    render(<MemoryRouter><main><h1>Dashboard</h1><NotificationBell /></main></MemoryRouter>);
    const bell = await screen.findByRole('button', { name: 'Notifications: 5 need your action' });
    await userEvent.click(bell);
    const panel = screen.getByRole('dialog', { name: 'Needs your action' });
    expect(within(panel).getAllByRole('heading', { level: 3 })).toHaveLength(4);
    expect(within(panel).getByRole('navigation', { name: 'Notification views' })).toBeInTheDocument();
    expect(describeViolations(await auditOf(document.body))).toBe('');
  });

  test('the grouped hub with item cards, a decidable and a not-decidable item expanded, and a skill version in review', async () => {
    const { container } = render(<MemoryRouter initialEntries={['/approvals']}><main><ApprovalsPage /></main></MemoryRouter>);
    await screen.findByText('conn-beta');
    expect(screen.getByRole('heading', { name: /Group: Alpha team/ })).toBeInTheDocument();
    for (const name of ['conn-alpha', 'conn-beta', 'editor-one']) {
      const row = screen.getByText(name).closest('li')!;
      await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    }
    expect(screen.getAllByText('You can decide this')).toHaveLength(2);
    expect(screen.getByText('Waiting on someone else')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open terraform-review/ })).toBeInTheDocument();
    expect(describeViolations(await auditOf(container))).toBe('');
  });

  test('a verification request waiting on its verifier, expanded: read-only, with its task link', async () => {
    const { container } = render(<MemoryRouter initialEntries={['/approvals']}><main><ApprovalsPage /></main></MemoryRouter>);
    const row = (await screen.findByText('shepherd-one')).closest('li')!;
    expect(within(row).getByText('Waiting on the verifier')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    expect(within(row).getByRole('link', { name: 'Open the task under review' })).toHaveClass('approvals-queue-link');
    expect(within(row).queryByRole('button', { name: /Approve|Deny|History/ })).not.toBeInTheDocument();
    expect(screen.getByText(/1 waiting on a verifier\./)).toBeInTheDocument();
    expect(describeViolations(await auditOf(container))).toBe('');
  });

  test('the hub drawer, with its token links', async () => {
    render(<MemoryRouter initialEntries={[`/approvals?approval=${APPROVAL_ID}`]}><main><ApprovalsPage /></main></MemoryRouter>);
    const drawer = await screen.findByRole('dialog', { name: 'Approval history' });
    await waitFor(() => expect(drawer).toHaveTextContent('Who did what'));
    expect(within(drawer).getByRole('link', { name: 'Fix the flux' })).toHaveClass('approval-drawer-link');
    expect(within(drawer).getByText('Approved')).toBeInTheDocument();
    expect(describeViolations(await auditOf(document.body))).toBe('');
  });

  test('the Access manager\'s pending panel with a grant request expanded (card 6dc53ea0)', async () => {
    useMyPrincipal.mockReturnValue({ me: { id: 'p-root', role: 'admin', handle: 'root' }, scopes: ['root'], loading: false });
    const { container } = render(<MemoryRouter initialEntries={['/settings/access-manager']}><main><AccessManagerPage /></main></MemoryRouter>);
    const row = (await screen.findByText('conn-beta')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    const links = within(row.querySelector('.axm-item-detail') as HTMLElement).getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveClass('approvals-queue-link');
    expect(describeViolations(await auditOf(container))).toBe('');
  });
});

/** A viewport of `width` for the surfaces below: the window width and the media queries the sheets use. */
function atWidth(width: number): () => void {
  const restore = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.split(',').some((part) => part.trim().split(/\s+and\s+/i).every((feature) => {
      const size = /\((max|min)-width:\s*(\d+)px\)/.exec(feature);
      return size ? (size[1] === 'max' ? width <= Number(size[2]) : width >= Number(size[2])) : false;
    })),
    media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  return () => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: restore }); };
}

describe('Notifications and Timeline Slice B surfaces are axe-clean (card 5854f0d6)', () => {
  test.each([1280, 375])('the action list, every kind, with a capped kind, at %ipx', async (width) => {
    const restore = atWidth(width);
    try {
      actionsCapped = true;
      const { container } = render(<MemoryRouter initialEntries={['/notifications']}><main><NotificationsPage /></main></MemoryRouter>);
      await screen.findByText('terraform-review');
      expect(screen.getByRole('region', { name: 'Stuck (1+)' })).toBeInTheDocument();
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally { restore(); }
  });

  test.each([1280, 375])('the action list\'s empty and error states at %ipx', async (width) => {
    const restore = atWidth(width);
    try {
      actionRows = [];
      const empty = render(<MemoryRouter initialEntries={['/notifications']}><main><NotificationsPage /></main></MemoryRouter>);
      await screen.findByText(/Nothing needs your action\./);
      expect(describeViolations(await auditOf(empty.container))).toBe('');
      cleanup();
      actionsStatus = 500;
      const failed = render(<MemoryRouter initialEntries={['/notifications']}><main><NotificationsPage /></main></MemoryRouter>);
      await screen.findByText(/Couldn.t check what needs your action/);
      expect(describeViolations(await auditOf(failed.container))).toBe('');
    } finally { restore(); }
  });

  test.each([1280, 375])('the Timeline with filters set, day groups, the divider, the type list open and Load more, at %ipx', async (width) => {
    const restore = atWidth(width);
    try {
      const { container } = render(<MemoryRouter initialEntries={['/notifications?tab=timeline&type=status,report,approval,stuck,skill-version&scope=mine&acl=1&since=2026-01-01']}><main><NotificationsPage /></main></MemoryRouter>);
      await screen.findByRole('link', { name: 'Moved fixture task' });
      expect(screen.getByText('Above this line: new since your last visit')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
      expect(screen.getByText('Handover')).toBeInTheDocument();
      expect(describeViolations(await auditOf(container))).toBe('');
      await userEvent.click(screen.getByRole('button', { name: /^Filters/ }));
      expect(screen.getByRole('group', { name: 'Type: 5 types' })).toBeInTheDocument();
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally { restore(); }
  });

  test.each([1280, 375])('the Timeline\'s 503 TIMELINE_READ_TIMEOUT and empty states at %ipx', async (width) => {
    const restore = atWidth(width);
    try {
      timelineStatus = { status: 503, code: 'TIMELINE_READ_TIMEOUT' };
      const slow = render(<MemoryRouter initialEntries={['/notifications?tab=timeline']}><main><NotificationsPage /></main></MemoryRouter>);
      await screen.findByText(/took too long to read/);
      expect(describeViolations(await auditOf(slow.container))).toBe('');
      cleanup();
      timelineStatus = null;
      timelineRows = [];
      const empty = render(<MemoryRouter initialEntries={['/notifications?tab=timeline&type=phase']}><main><NotificationsPage /></main></MemoryRouter>);
      await screen.findByText('Nothing on the timeline matches these filters.');
      expect(describeViolations(await auditOf(empty.container))).toBe('');
    } finally { restore(); }
  });

  test.each([1280, 375])('the open bell popover, every kind and an Other row, at %ipx (card 5854f0d6 review)', async (width) => {
    const restore = atWidth(width);
    try {
      actionRows = [...ACTIONS, { ...ACTIONS[2], key: 'handover:t-other', kind: 'handover', object: { ...ACTIONS[2].object, id: 't-other', title: 'Hand over the relay' } }];
      render(<MemoryRouter><main><h1>Dashboard</h1><NotificationBell /></main></MemoryRouter>);
      const bell = await screen.findByRole('button', { name: 'Notifications: 6 need your action' });
      await userEvent.click(bell);
      const panel = screen.getByRole('dialog', { name: 'Needs your action' });
      expect(within(panel).getAllByRole('heading', { level: 3 })).toHaveLength(5);
      expect(within(panel).getByRole('heading', { level: 3, name: 'Other (1)' })).toBeInTheDocument();
      expect(within(panel).getAllByRole('listitem')).toHaveLength(6);
      expect(describeViolations(await auditOf(document.body))).toBe('');
    } finally { restore(); }
  });

  test.each([1280, 375])('the dashboard card and the Activity widget, populated, at %ipx', async (width) => {
    const restore = atWidth(width);
    try {
      const { container } = render(<MemoryRouter><main><h1>Dashboard</h1><NotificationsCard /><ActivityFeed /></main></MemoryRouter>);
      await screen.findByRole('link', { name: 'Fix the flux' });
      await screen.findByRole('link', { name: 'Night report' });
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally { restore(); }
  });
});

describe('change requests slice S3 surfaces are axe-clean (card 502fb19e)', () => {
  beforeEach(() => { changeFixtures = true; });

  test('a change item expanded for its decider: the Before and after region with its tables, and the narrowing controls', async () => {
    const { container } = render(<MemoryRouter initialEntries={['/approvals']}><main><ApprovalsPage /></main></MemoryRouter>);
    const row = (await screen.findByText('owner-account')).closest('li')!;
    expect(within(row).getByText('You can decide this')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    const region = within(row).getByRole('region', { name: 'Before and after' });
    expect(within(region).getByRole('table', { name: 'Fields' })).toBeInTheDocument();
    expect(within(region).getByRole('table', { name: 'Relationships' })).toBeInTheDocument();
    expect(within(region).getByText('1 principal gains read on 1 object; nothing is removed')).toBeInTheDocument();
    expect(await within(row).findByRole('checkbox', { name: /Garden notes/ })).toBeChecked();
    expect(within(row).getByRole('button', { name: 'Approve as requested' })).toBeInTheDocument();
    expect(describeViolations(await auditOf(container))).toBe('');
  });

  test('the Request a change button and its dialog, from the Knowledge page with no source', async () => {
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Request a change' }));
    const dialog = screen.getByRole('dialog', { name: 'Request a change' });
    expect(within(dialog).getByLabelText(/Knowledge Service id/)).toBeInTheDocument();
    expect(describeViolations(await auditOf(document.body))).toBe('');
  });

  test('the Request a change dialog on a Project, populated from the preview', async () => {
    render(<MemoryRouter><main><h1>Project</h1>
      <RequestChangeDialog target={{ kind: 'project', projectId: CHANGE_PROJECT, projectName: 'Garden notes' }} onClose={() => undefined} />
    </main></MemoryRouter>);
    const dialog = screen.getByRole('dialog', { name: 'Request a change' });
    expect(await within(dialog).findByRole('checkbox', { name: 'read' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('For')).toBeInTheDocument();
    expect(describeViolations(await auditOf(document.body))).toBe('');
  });

  test('the My requests tab, populated: the requester sees the field diff and no decider', async () => {
    const { container } = render(<MemoryRouter initialEntries={['/notifications?tab=requests']}><main><NotificationsPage /></main></MemoryRouter>);
    const panel = screen.getByRole('tabpanel', { name: 'My requests' });
    await within(panel).findByText('Knowledge compartment');
    expect(within(panel).getByRole('region', { name: 'Before and after' })).toBeInTheDocument();
    expect(within(panel).queryByRole('table', { name: 'Relationships' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /^Withdraw: Knowledge compartment/ })).toBeInTheDocument();
    expect(describeViolations(await auditOf(container))).toBe('');
  });
});

describe('Action Center surfaces are axe-clean (owner rulings E453 and E455)', () => {
  const withQueries = (ui: ReactElement) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
  );

  test('the left menu with its Action Center entry under Dashboard', async () => {
    const { container } = render(<MemoryRouter initialEntries={['/action-center']}><Sidebar connected /><main><h1>Action Center</h1></main></MemoryRouter>);
    const entry = await screen.findByRole('link', { name: 'Action Center' });
    expect(entry).toHaveAttribute('href', '/action-center');
    expect(screen.queryByRole('link', { name: 'Agent sessions' })).not.toBeInTheDocument();
    expect(describeViolations(await auditOf(container))).toBe('');
  });

  test.each([1280, 375])('the Timeline folded, with a search and every filter as a chip, then unfolded, at %ipx', async (width) => {
    const restore = atWidth(width);
    try {
      const { container } = render(<MemoryRouter initialEntries={['/action-center?tab=timeline&type=status,report&scope=mine&acl=1&since=2026-01-01&until=2026-12-31&q=relay']}><main><NotificationsPage /></main></MemoryRouter>);
      await screen.findByRole('link', { name: 'Moved fixture task' });
      expect(screen.getByRole('searchbox', { name: 'Search the timeline' })).toHaveValue('relay');
      expect(within(screen.getByRole('list', { name: 'Applied filters' })).getAllByRole('button').length).toBeGreaterThanOrEqual(7);
      expect(screen.queryByRole('group')).not.toBeInTheDocument();
      expect(describeViolations(await auditOf(container))).toBe('');
      await userEvent.click(screen.getByRole('button', { name: /^Filters/ }));
      expect(screen.getAllByRole('group').length).toBeGreaterThanOrEqual(6);
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally { restore(); }
  });

  test.each([1280, 375])('the action list with seen and unseen items, Mark seen and Mark all seen, at %ipx', async (width) => {
    const restore = atWidth(width);
    try {
      actionRows = ACTIONS.map((item, index) => ({ ...item, seen: index % 2 === 0 }));
      const { container } = render(<MemoryRouter initialEntries={['/action-center']}><main><NotificationsPage /></main></MemoryRouter>);
      await screen.findByText('terraform-review');
      expect(screen.getByRole('button', { name: 'Mark all seen' })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /^Mark seen: / })).toHaveLength(2);
      expect(screen.getAllByText('Seen')).toHaveLength(3);
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally { restore(); }
  });

  test.each([1280, 375])('the bell\'s popover with seen rows and Mark all seen, at %ipx', async (width) => {
    const restore = atWidth(width);
    try {
      actionRows = ACTIONS.map((item, index) => ({ ...item, seen: index === 0 }));
      render(<MemoryRouter><main><h1>Dashboard</h1><NotificationBell /></main></MemoryRouter>);
      await userEvent.click(await screen.findByRole('button', { name: /^Notifications: 5 need your action/ }));
      const panel = screen.getByRole('dialog', { name: 'Needs your action' });
      expect(within(panel).getByRole('button', { name: 'Mark all seen' })).toBeInTheDocument();
      expect(describeViolations(await auditOf(document.body))).toBe('');
    } finally { restore(); }
  });

  test.each([1280, 375])('the Agent sessions tab, at %ipx', async (width) => {
    const restore = atWidth(width);
    try {
      const { container } = render(withQueries(<MemoryRouter initialEntries={['/action-center?tab=sessions']}><main><NotificationsPage /></main></MemoryRouter>));
      const panel = screen.getByRole('tabpanel', { name: 'Agent sessions' });
      await within(panel).findByText('No reported sessions.');
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally { restore(); }
  });
});
