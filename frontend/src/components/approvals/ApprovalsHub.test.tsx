// @vitest-environment jsdom
/**
 * The approvals hub as a review-and-approve page (card b1e3b16d; design T9,
 * T10; owner rulings E15, E16, E44 Q2, E45), and the link polish of card
 * 6dc53ea0.
 *
 * Pinned here, each against the server's hub fields (never authority the page
 * works out for itself):
 *   - T9 grouping: one section per Group, Shared, Private (yours, then each
 *     other owner), Board-level, in that order; empty sections are not drawn;
 *     an item with several Groups lists ONCE, under its first, with "+n";
 *   - T10 facts: when, about what (titles only where the server sent them), who
 *     decides, and whether THIS session may — with the decide controls shown
 *     only where it may;
 *   - the skill-review adapter's items: no History, no Approve/Deny, a link to
 *     the Skill where versions are decided;
 *   - verification requests waiting on a verifier (review round 2): listed
 *     read-only, no History, no decision of any kind, a link to the task, and
 *     counted as "waiting on a verifier", never as a decision;
 *   - URL filters reach the server — every kind the select offers, the skill
 *     and verification kinds included; an unknown one is named, never applied;
 *   - ONE number: the dashboard notice, the bell and the hub's "waiting on you"
 *     say the same count on the same fixture;
 *   - the links inside an item carry the dashboard's token link class in BOTH
 *     mounts, and that class's rule paints the gated accent ink with hover and
 *     focus-visible states (jsdom cannot measure contrast; the pair is gated in
 *     every Theme by scripts/check-design-contrast.py);
 *   - owner E84 (card e2dd52b8 Part A): the notification centre's Approvals tab
 *     IS this hub — the same sections and items from the same fixture, the same
 *     decide flow reaching step-up, the same drawer by URL, the same one
 *     number — and the dashboard notice and the bell lead to it.
 */
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const useMyPrincipal = vi.fn();
vi.mock('../../hooks/usePrincipals', () => ({
  useMyPrincipal: () => useMyPrincipal(),
  usePrincipals: () => ({ principals: [] }),
}));

const calls: string[] = [];
let hubItems: any[];
let plainItems: any[];
vi.mock('../../utils/auth', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const text = String(url);
    calls.push(`${init?.method ?? 'GET'} ${text}`);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    // GET /notifications/actions, as the route derives it from the same hub list: Decisions are the
    // pending items this session may decide, minus skill reviews and native reviews; skill reviews are
    // their own kind (card 5854f0d6, Slice B).
    if (text.includes('/notifications/actions')) {
      const pending = hubItems.filter((entry) => entry.status === 'pending');
      const decisions = pending.filter((entry) => entry.decidable !== false && entry.kind !== 'skill-publish' && entry.kind !== 'native-review');
      const skills = pending.filter((entry) => entry.kind === 'skill-publish');
      const items = [
        ...decisions.map((entry) => ({ key: `decision:${entry.id}`, kind: 'decision', reasons: [entry.kind], since: entry.requestedAt,
          object: { type: 'approval', id: entry.id, title: entry.refs?.task?.title ?? entry.targetTaskTitle ?? null }, project: null,
          href: `/notifications?tab=approvals&approval=${entry.id}`, detail: { approvalKind: entry.kind, requesterHandle: entry.requesterHandle } })),
        ...skills.map((entry) => ({ key: `skill:${entry.id}`, kind: 'skill', reasons: ['skill-publish'], since: entry.requestedAt,
          object: { type: 'skill', id: entry.skill.id, title: entry.skill.name }, project: null,
          href: `/skills?skill=${entry.skill.id}`, detail: { version: entry.skill.version } })),
      ];
      return ok({ success: true, items,
        counts: { decision: decisions.length, verify: 0, stuck: 0, skill: skills.length, total: items.length },
        capped: { decision: false, verify: false, stuck: false, skill: false } });
    }
    if (text.includes('view=hub')) return ok({ success: true, view: 'hub', approvals: hubItems });
    if (/\/approvals(\?|$)/.test(text)) return ok({ success: true, approvals: plainItems });
    return ok({ success: true });
  }),
  auth: { getToken: () => 't', clearToken: () => {} },
}));

import { ApprovalsPage } from '../../pages/ApprovalsPage';
import { AccessManagerPage } from '../../pages/AccessManagerPage';
import { ActionCenterAlias, NotificationsPage } from '../../pages/NotificationsPage';
import { DecisionNotice } from './DecisionNotice';
import { NotificationBell } from '../notifications/NotificationBell';
import { groupHubItems } from './hubGrouping';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const NOW = Date.now();
const iso = (offsetHours: number) => new Date(NOW + offsetHours * 3600_000).toISOString();

function item(id: string, over: Record<string, unknown> = {}) {
  return {
    id, kind: 'agent-mint', status: 'pending', requesterPrincipalId: `p-${id}`, requesterHandle: `conn-${id}`,
    targetTaskId: `t-${id}`, targetTaskTitle: `Task ${id}`, requestedScopes: ['tasks:read'], requestedRules: [],
    approvedScopes: null, lapseReason: null, denialReason: null, requestedAt: iso(-2), pendingExpiresAt: iso(30),
    collectExpiresAt: null,
    refs: { task: { id: `t-${id}`, title: `Task ${id}` }, phase: null, project: { id: `pr-${id}`, title: `Project ${id}` } },
    ownership: { class: 'board', groups: [], ownerHandle: null, ownerIsViewer: false },
    deciders: { rule: 'Root, or the Account that owns the requesting connector, with step-up.', stepUp: true },
    decidable: true,
    decideVia: { approve: `/approvals/${id}/approve`, deny: `/approvals/${id}/deny`, stepUpAction: 'approval.decide' },
    ...over,
  };
}

const ALPHA = { id: '11111111-1111-4111-8111-111111111111', name: 'Alpha team' };
const ZULU = { id: '22222222-2222-4222-8222-222222222222', name: 'Zulu team' };

const GROUPED = [
  item('board1', { refs: { task: { id: 't-board1', title: 'Task board1' }, phase: null, project: null } }),
  item('zulu1', { ownership: { class: 'group', groups: [ZULU], ownerHandle: null, ownerIsViewer: false } }),
  item('mine1', { ownership: { class: 'private', groups: [], ownerHandle: 'owner-account', ownerIsViewer: true } }),
  item('alpha1', { ownership: { class: 'group', groups: [ALPHA, ZULU], ownerHandle: null, ownerIsViewer: false } }),
  item('bob1', { ownership: { class: 'private', groups: [], ownerHandle: 'bob', ownerIsViewer: false } }),
  item('shared1', { ownership: { class: 'shared', groups: [], ownerHandle: null, ownerIsViewer: false } }),
  item('hidden1', {
    kind: 'grant', decidable: false,
    deciders: { rule: 'Root, or an administrator signed in to the dashboard, with step-up.', stepUp: true },
    targetTaskId: null, targetTaskTitle: null,
    refs: { task: { id: 't-secret', title: null }, phase: null, project: { id: 'pr-secret', title: null } },
    accessRequest: {
      granteePrincipalId: 'p-acct', granteeHandle: 'acct', reason: 'Hub test: the run needs this to finish.',
      requestedExpiresAt: iso(300), approvedExpiresAt: null, relatedTaskId: 't-secret', relatedTaskTitle: null,
      relatedPhaseId: null, relatedPhaseName: null, relatedProjectId: 'pr-secret', relatedProjectTitle: null,
      createdGrantIds: [],
      ruleViews: [{ resourceType: 'task', selectorForm: 'exact', verbs: ['read'], objects: [{ id: 't-x', title: 'Asked task' }], allOfType: null }],
    },
    ownership: { class: 'private', groups: [], ownerHandle: null, ownerIsViewer: false },
  }),
  item('skill1', {
    kind: 'skill-publish', targetTaskId: null, targetTaskTitle: null, pendingExpiresAt: null,
    refs: { task: null, phase: null, project: null },
    skill: { id: 'sk-1', name: 'terraform-review', version: 3, description: 'Reviews Terraform plans.', provenance: 'agent-drafted' },
    deciders: { rule: 'A person holding skills:admin who did not write this version. Publishing takes no step-up.', stepUp: false },
    decideVia: { publish: '/skills/sk-1/versions/3/publish', reject: '/skills/sk-1/versions/3/reject', stepUpAction: null },
  }),
];

const VERIFY_RULE = 'verifier-bot through Native verifier records the verdict on the task. Nothing is decided on this page.';
const verification = (id: string, state: 'pending' | 'leased', over: Record<string, unknown> = {}) => item(id, {
  kind: 'native-review', decidable: false, requestedScopes: [], decideVia: {},
  pendingExpiresAt: state === 'pending' ? iso(20) : null,
  refs: { task: { id: `t-${id}`, title: `Task ${id}` }, phase: null, project: { id: `pr-${id}`, title: `Project ${id}` } },
  ownership: { class: 'private', groups: [], ownerHandle: 'owner-account', ownerIsViewer: true },
  deciders: { rule: VERIFY_RULE, stepUp: false },
  verification: {
    state, serviceId: 'svc-1', serviceName: 'Native verifier', descriptorVersion: 1,
    verifierPrincipalId: 'p-verifier', verifierHandle: 'verifier-bot',
    requestExpiresAt: iso(20), leaseExpiresAt: state === 'leased' ? iso(1) : null,
  },
  ...over,
});
const VERIFY = verification('verify1', 'pending');
const VERIFY_LEASED = verification('verify2', 'leased');

beforeEach(() => {
  calls.length = 0;
  hubItems = GROUPED;
  plainItems = [];
  useMyPrincipal.mockReturnValue({ me: { id: 'p-owner', role: 'admin', handle: 'owner-account' }, scopes: ['root'], loading: false });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const renderHub = (entry = '/approvals') => render(<MemoryRouter initialEntries={[entry]}><ApprovalsPage /></MemoryRouter>);
const sectionTitles = () => screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);

describe('T9: sections by whose the item is (E45)', () => {
  test('Groups by name, then Shared, Private (yours, then each owner), Board-level; no item twice', async () => {
    renderHub();
    await screen.findByText('conn-alpha1');
    expect(sectionTitles()).toEqual([
      'Group: Alpha team (1)', 'Group: Zulu team (1)', 'Shared projects (1)', 'Private: your projects (1)',
      'Private to bob (1)', 'Private to another Account (1)', 'Board-level (2)',
    ]);
    const zulu = screen.getByRole('region', { name: /Group: Zulu team/ });
    expect(within(zulu).getByText('conn-zulu1')).toBeInTheDocument();
    expect(within(zulu).queryByText('conn-alpha1')).not.toBeInTheDocument();
    const alpha = screen.getByRole('region', { name: /Group: Alpha team/ });
    expect(within(alpha).getByText('+1 group', { exact: false })).toHaveAttribute('title', 'Alpha team, Zulu team');
    expect(screen.getAllByText('conn-alpha1')).toHaveLength(1);
  });

  test('empty sections are not drawn', () => {
    const sections = groupHubItems([GROUPED[0], GROUPED[5]] as any);
    expect(sections.map((section) => section.title)).toEqual(['Shared projects', 'Board-level']);
  });

  test('AZ-A12 clause 12: "Owned by" the owning Group lists before "Shared with" a granted Group, and the owner decides the section', () => {
    const owned = item('owned1', { ownership: {
      class: 'group', basis: 'owner', ownerKind: 'group',
      groups: [{ ...ZULU, basis: 'owner' }, { ...ALPHA, basis: 'grant' }], ownerHandle: null, ownerIsViewer: false,
    } });
    const sharedWith = item('shared-with1', { ownership: {
      class: 'group', basis: 'grant', ownerKind: 'human', groups: [{ ...ALPHA, basis: 'grant' }], ownerHandle: null, ownerIsViewer: false,
    } });
    const concealedOwner = item('concealed1', { ownership: {
      class: 'group', basis: 'owner', ownerKind: 'group', groups: [], ownerHandle: null, ownerIsViewer: false,
    } });
    expect(groupHubItems([sharedWith, owned, concealedOwner] as any)
      .map((section) => [section.title, section.items.map((entry: any) => entry.id)])).toEqual([
      ['Owned by Zulu team', ['owned1']],
      ['Shared with Alpha team', ['shared-with1']],
      ['Owned by a Group', ['concealed1']],
    ]);
  });

  test('an item the server did not classify lists under All requests, never under a class it was not given', () => {
    const { ownership: _ownership, ...unclassified } = item('legacy');
    expect(groupHubItems([unclassified] as any).map((section) => section.title)).toEqual(['All requests']);
  });
});

describe('T10: who asked, what, when, about what, who decides', () => {
  test('each item says it, from the server\'s fields', async () => {
    renderHub();
    const row = (await screen.findByText('conn-zulu1')).closest('li')!;
    expect(within(row).getByText('wants an agent on “Task zulu1”')).toBeInTheDocument();
    expect(within(row).getByText(/^Asked /)).toHaveTextContent(/lapses/);
    expect(within(row).getByRole('link', { name: 'Task zulu1' })).toHaveAttribute('href', '/tasks/t-zulu1');
    expect(within(row).getByRole('link', { name: 'Project zulu1' })).toHaveAttribute('href', '/projects/pr-zulu1/charter');
    expect(within(row).getByText(/^Decided by: Root, or the Account that owns the requesting connector/)).toBeInTheDocument();
    expect(within(row).getByText('You can decide this')).toBeInTheDocument();
  });

  test('a concealed title stays concealed, and an item someone else decides offers no decision', async () => {
    renderHub();
    const row = (await screen.findByText('conn-hidden1')).closest('li')!;
    expect(within(row).getByText('a task you cannot read')).toBeInTheDocument();
    expect(within(row).getByText('a project you cannot read')).toBeInTheDocument();
    expect(within(row).getByText('Waiting on someone else')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    expect(within(row).getByText('Hub test: the run needs this to finish.')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
  });

  test('where this session may decide, Review offers the existing decide flow', async () => {
    renderHub();
    const row = (await screen.findByText('conn-mine1')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    expect(within(row).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Deny' })).toBeInTheDocument();
  });

  test('a skill version in review: no History, no Approve or Deny here, and a link to the Skill that decides it', async () => {
    renderHub();
    const row = (await screen.findByText('conn-skill1')).closest('li')!;
    expect(within(row).getByText('asks to publish terraform-review v3')).toBeInTheDocument();
    expect(within(row).getByText('Skill publish')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /^History/ })).not.toBeInTheDocument();
    expect(within(row).getByText(/waits until someone decides/)).toBeInTheDocument();
    expect(within(row).getByText(/Publishing takes no step-up/)).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    expect(within(row).getByText('Reviews Terraform plans.')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /Open terraform-review to publish or return it/ })).toHaveAttribute('href', '/skills?skill=sk-1');
    expect(within(row).queryByRole('button', { name: /Approve|Deny/ })).not.toBeInTheDocument();
  });
});

describe('verification requests waiting on a verifier (review round 2, blocker B1)', () => {
  test('listed read-only: who asked, which task, when, and the verifier; no History and no decision of any kind', async () => {
    hubItems = [...GROUPED, VERIFY, VERIFY_LEASED];
    renderHub();
    const row = (await screen.findByText('conn-verify1')).closest('li')!;
    expect(within(row).getByText('Verification request')).toBeInTheDocument();
    expect(within(row).getByText('asked verifier-bot to verify “Task verify1”')).toBeInTheDocument();
    expect(within(row).getByText(/^Asked /)).toHaveTextContent(/lapses/);
    expect(within(row).getByRole('link', { name: 'Task verify1' })).toHaveAttribute('href', '/tasks/t-verify1');
    expect(within(row).getByText(`Verified by: ${VERIFY_RULE}`, { exact: false })).toBeInTheDocument();
    expect(within(row).getByText('Waiting on the verifier')).toBeInTheDocument();
    expect(within(row).queryByText('You can decide this')).not.toBeInTheDocument();
    expect(within(row).queryByText(/^Decided by/)).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /^History/ })).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    expect(within(row).getByText(/^verifier-bot\s+through Native verifier/)).toBeInTheDocument();
    expect(within(row).getByText(/Not yet picked up by the verifier/)).toBeInTheDocument();
    expect(within(row).getByText(/Nothing is decided on this page: the verifier records its verdict on the task/)).toBeInTheDocument();
    const open = within(row).getByRole('link', { name: 'Open the task under review' });
    expect(open).toHaveAttribute('href', '/tasks/t-verify1');
    expect(open).toHaveClass('approvals-queue-link');
    expect(within(row).queryByRole('button', { name: /Approve|Deny/ })).not.toBeInTheDocument();
    expect(within(row).queryByRole('textbox')).not.toBeInTheDocument();
    // Nor the agent-mint detail: a verification request asks for no scopes or rules.
    expect(within(row).queryByText(/Requested scopes|Requested object rules/)).not.toBeInTheDocument();

    const leased = (await screen.findByText('conn-verify2')).closest('li')!;
    expect(within(leased).queryByText(/lapses/)).not.toBeInTheDocument();
    await userEvent.click(within(leased).getByRole('button', { name: 'Review' }));
    expect(within(leased).getByText(/The verifier has taken the request; its lease runs until/)).toBeInTheDocument();
  });

  test('never counted as a decision: the notice, the bell and the hub still say 7, and the hub says 2 waiting on a verifier', async () => {
    hubItems = [...GROUPED, VERIFY, VERIFY_LEASED];
    render(
      <MemoryRouter initialEntries={['/approvals']}>
        <DecisionNotice />
        <NotificationBell />
        <ApprovalsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('7 decisions need you')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Notifications/ }))
      .toHaveAccessibleName('Notifications: 7 need your action'));
    expect(screen.getByText(/^7 waiting on you\. 1 waiting on someone else\. 2 waiting on a verifier\.$/)).toBeInTheDocument();
  });

  test('the page says they are listed read-only, and why', async () => {
    renderHub();
    await screen.findByText('conn-zulu1');
    expect(screen.getByText(/Verification requests waiting on a task.s verifier are listed too, read-only: the verifier records its verdict on the task, so there is nothing to decide here\./))
      .toBeInTheDocument();
  });
});

describe('URL filters', () => {
  test.each([['skill-publish', 'Skill publish'], ['native-review', 'Verification request']])(
    '?kind=%s reaches the server, and the Kind select offers it as %s',
    async (kind, label) => {
      renderHub(`/approvals?kind=${kind}`);
      await screen.findByText('conn-zulu1');
      expect(calls).toContain(`GET /api/approvals?view=hub&status=pending&kind=${kind}`);
      const select = screen.getByRole('combobox', { name: 'Kind' });
      expect(select).toHaveValue(kind);
      expect(within(select).getByRole('option', { name: label })).toHaveValue(kind);
      // A kind the hub knows is applied, never named as ignored.
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    },
  );

  test('?kind= and ?group= reach the server with the hub view', async () => {
    renderHub(`/approvals?kind=grant&group=${ALPHA.id}`);
    await screen.findByText('conn-zulu1');
    expect(calls).toContain(`GET /api/approvals?view=hub&status=pending&kind=grant&group=${ALPHA.id}`);
    expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveValue('grant');
  });

  test('a kind or group the hub does not know is named and NOT applied', async () => {
    renderHub('/approvals?kind=charter&group=everyone');
    await screen.findByText('conn-zulu1');
    expect(screen.getByRole('note')).toHaveTextContent('This link also filters by kind “charter” and group “everyone”');
    expect(calls).toContain('GET /api/approvals?view=hub&status=pending');
    expect(calls.some((call) => call.includes('kind=charter') || call.includes('group=everyone'))).toBe(false);
  });

  test('choosing an owner writes ?group=', async () => {
    renderHub();
    await screen.findByText('conn-zulu1');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Owner' }), 'private');
    await waitFor(() => expect(calls).toContain('GET /api/approvals?view=hub&status=pending&group=private'));
  });
});

describe('one number on every surface', () => {
  test('the dashboard notice, the bell and the hub say the same "waiting on you"', async () => {
    render(
      <MemoryRouter initialEntries={['/approvals']}>
        <DecisionNotice />
        <NotificationBell />
        <ApprovalsPage />
      </MemoryRouter>,
    );
    // GROUPED: 8 pending, one of them (hidden1) decided by someone else.
    expect(await screen.findByText('7 decisions need you')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Notifications/ }))
      .toHaveAccessibleName('Notifications: 7 need your action'));
    expect(screen.getByText(/^7 waiting on you\. 1 waiting on someone else\./)).toBeInTheDocument();
  });
});

describe('the notification centre\'s Approvals tab is this hub (owner E84, card e2dd52b8 Part A)', () => {
  let location = '';
  function LocationProbe() {
    const current = useLocation();
    location = `${current.pathname}${current.search}`;
    return null;
  }
  const renderTab = (entry = '/notifications?tab=approvals') => render(
    <MemoryRouter initialEntries={[entry]}><NotificationsPage /><LocationProbe /></MemoryRouter>,
  );
  const itemTitles = (root: HTMLElement) => [...root.querySelectorAll('.axm-item-title')].map((node) => node.textContent);

  test('the tab shows the hub page\'s grouped list: the same sections, the same items, the same counts', async () => {
    const page = renderHub();
    await screen.findByText('conn-alpha1');
    const fromPage = {
      sections: sectionTitles(),
      items: itemTitles(page.container),
      waiting: screen.getByText(/waiting on you\./).textContent,
    };
    cleanup();
    const tab = renderTab();
    const panel = screen.getByRole('tabpanel', { name: 'Approvals' });
    await within(panel).findByText('conn-alpha1');
    expect(sectionTitles()).toEqual([
      'Group: Alpha team (1)', 'Group: Zulu team (1)', 'Shared projects (1)', 'Private: your projects (1)',
      'Private to bob (1)', 'Private to another Account (1)', 'Board-level (2)',
    ]);
    expect(sectionTitles()).toEqual(fromPage.sections);
    expect(itemTitles(tab.container)).toEqual(fromPage.items);
    expect(within(panel).getByText(/waiting on you\./).textContent).toBe(fromPage.waiting);
    expect(within(panel).getByRole('combobox', { name: 'Kind' })).toBeInTheDocument();
    expect(within(panel).getByRole('combobox', { name: 'Owner' })).toBeInTheDocument();
    expect(calls).toContain('GET /api/approvals?view=hub&status=pending');
  });

  test('Review offers the existing decide flow, and Approve asks for step-up before anything is decided', async () => {
    renderTab();
    const row = (await screen.findByText('conn-mine1')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    expect(within(row).getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    const stepUp = await screen.findByRole('dialog', { name: /Confirm it.s you/ });
    expect(stepUp).toHaveTextContent('Approve the agent-mint request from conn-mine1 for task “Task mine1”.');
    expect(calls.some((call) => /^POST .*\/approvals\//.test(call))).toBe(false);
  });

  test('History opens the drawer on the tab by URL; closing removes only the approval', async () => {
    renderTab('/notifications?tab=approvals&kind=agent-mint');
    await screen.findByText('conn-zulu1');
    await userEvent.click(screen.getByRole('button', { name: /^History: conn-zulu1/ }));
    expect(await screen.findByRole('dialog', { name: 'Approval history' })).toBeInTheDocument();
    expect(location).toBe('/notifications?tab=approvals&kind=agent-mint&approval=zulu1');
    await userEvent.click(screen.getByRole('button', { name: 'Close approval history' }));
    expect(location).toBe('/notifications?tab=approvals&kind=agent-mint');
  });

  test('one number on every surface, with the hub on the tab', async () => {
    render(
      <MemoryRouter initialEntries={['/notifications?tab=approvals']}>
        <DecisionNotice />
        <NotificationBell />
        <NotificationsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('7 decisions need you')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Notifications/ }))
      .toHaveAccessibleName('Notifications: 7 need your action'));
    expect(screen.getByText(/^7 waiting on you\. 1 waiting on someone else\./)).toBeInTheDocument();
  });

  test('the dashboard notice\'s "Review decisions" and the bell\'s decisions row land on the tab, on the hub', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <NotificationBell />
        <Routes>
          <Route path="/" element={<DecisionNotice />} />
          {/* Owner ruling E453: the Action Center; the server's own
              `/notifications?...` links reach it through the alias. */}
          <Route path="/action-center" element={<NotificationsPage />} />
          <Route path="/notifications" element={<ActionCenterAlias from="notifications" />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole('link', { name: 'Review decisions' }));
    expect(location).toBe('/action-center?tab=approvals');
    const panel = await screen.findByRole('tabpanel', { name: 'Approvals' });
    expect(await within(panel).findByText('conn-zulu1')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Approvals' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByRole('tab', { name: 'Notifications' }));
    expect(location).toBe('/action-center');
    const bell = screen.getByRole('button', { name: /^Notifications:/ });
    await waitFor(() => expect(bell).toHaveAccessibleName('Notifications: 7 need your action'));
    await userEvent.click(bell);
    // Slice B (card 5854f0d6): the popover lists each decision; a row opens that item on the tab.
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Needs your action' })).getByRole('link', { name: 'Task board1' }));
    await waitFor(() => expect(location).toBe('/action-center?tab=approvals&approval=board1'));
    expect(await screen.findByRole('tabpanel', { name: 'Approvals' })).toBeInTheDocument();
  });
});

describe('links inside an item: the dashboard token link (card 6dc53ea0)', () => {
  const GRANT_ITEM = {
    ...item('grant1', { kind: 'grant' }),
    targetTaskId: null, targetTaskTitle: null,
    accessRequest: {
      granteePrincipalId: 'p-acct', granteeHandle: 'acct', reason: 'Hub test: the run needs this to finish.',
      requestedExpiresAt: iso(300), approvedExpiresAt: null, relatedTaskId: 't-rel', relatedTaskTitle: 'Related task',
      relatedPhaseId: 'ph-1', relatedPhaseName: 'Phase one', relatedProjectId: 'pr-1', relatedProjectTitle: 'Project one',
      createdGrantIds: [],
      ruleViews: [{ resourceType: 'task', selectorForm: 'exact', verbs: ['read'], objects: [{ id: 't-x', title: 'Asked task' }], allOfType: null }],
    },
  };

  test.each(['hub', 'access-manager'] as const)('%s: every link in an expanded grant request carries the class', async (mount) => {
    hubItems = [GRANT_ITEM];
    const { refs: _r, ownership: _o, deciders: _d, decidable: _c, decideVia: _v, ...plain } = GRANT_ITEM;
    plainItems = [plain];
    render(
      <MemoryRouter initialEntries={[mount === 'hub' ? '/approvals' : '/settings/access-manager']}>
        {mount === 'hub' ? <ApprovalsPage /> : <AccessManagerPage />}
      </MemoryRouter>,
    );
    const row = (await screen.findByText('conn-grant1')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    const detail = row.querySelector('.axm-item-detail')!;
    const links = within(detail as HTMLElement).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Asked task', 'Related task', 'Phase one', 'Project one']);
    for (const link of links) expect(link).toHaveClass('approvals-queue-link');
  });

  test('the class rules paint the gated accent ink, underline it, and give hover and focus-visible states', () => {
    for (const [sheet, cls] of [['components/approvals/ApprovalsQueue.css', 'approvals-queue-link'], ['components/approvals/ApprovalDrawer.css', 'approval-drawer-link']]) {
      const css = readFileSync(join(SRC, sheet), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
      const rule = (selector: string) => {
        const match = css.match(new RegExp(`(^|\\n)\\.${selector.replace(/[:-]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`));
        expect(match, `${sheet} has no standalone .${selector} rule`).not.toBeNull();
        return match![2];
      };
      expect(rule(cls)).toMatch(/color:\s*var\(--text-accent\)/);
      expect(rule(cls)).toMatch(/text-decoration:\s*underline/);
      expect(rule(`${cls}:hover`)).toMatch(/text-decoration-thickness/);
      expect(rule(`${cls}:focus-visible`)).toMatch(/box-shadow:\s*var\(--focus-ring\)/);
    }
  });
});

describe('a change request is decided only where the server says so (card 502fb19e, slice S3; design sections 5.6 and 6)', () => {
  const PROJECT = '99999999-9999-4999-8999-999999999999';
  const changeItem = (id: string, over: Record<string, unknown> = {}) => item(id, {
    kind: 'change', targetTaskId: null, targetTaskTitle: null, requestedScopes: [], decideVia: {},
    refs: { task: null, phase: null, project: null },
    deciders: { rule: 'Root, an administrator signed in to the dashboard, or the owner of every object it names, with step-up.', stepUp: true },
    change: {
      targetType: 'knowledge.compartment', targetId: null, targetObjects: [{ type: 'project', id: PROJECT }],
      granteeType: 'principal', granteePrincipalId: 'p-reader', granteeHandle: 'reader-one', reason: 'Hub test: my assistant needs my notes.',
      spec: { type: 'knowledge.compartment', before: {}, requested: { sourceId: 'src-1', operation: 'read', projectIds: [PROJECT], expiresAt: iso(300) }, approved: null, diff: null },
      appliedAt: null, appliedEffect: null, deciderStanding: null, relatedTaskId: null, relatedPhaseId: null,
    },
    fieldDiff: [{ field: 'projectIds', before: null, after: [PROJECT] }],
    // A requester's answer never carries these (the server cuts them); the
    // page must not draw them even if it did.
    relationships: { summary: 'Hub test: 1 principal gains read on 1 object', edges: [
      { principal: { type: 'principal', id: 'p-reader' }, object: `compartment:${PROJECT}`, action: 'read', before: false, after: true, via: 'knowledge', state: 'added' },
    ] },
    ...over,
  });

  test('the requester\'s own item: no relationships, no decision, even for a root viewer the old guess would let decide', async () => {
    hubItems = [changeItem('req1', { view: 'requester', decidable: false, decisionRefusal: { code: 'SELF_DECISION_REFUSED', message: 'you filed this change' } })];
    renderHub();
    const row = (await screen.findByText('conn-req1')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    const region = within(row).getByRole('region', { name: 'Before and after' });
    expect(within(region).getByRole('table', { name: 'Fields' })).toBeInTheDocument();
    expect(within(region).queryByRole('table', { name: 'Relationships' })).not.toBeInTheDocument();
    expect(within(row).queryByText('Hub test: 1 principal gains read on 1 object')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
    expect(within(row).getByText('You do not decide this change: you filed this change.')).toBeInTheDocument();
  });

  test('a decider\'s item: the relationships and the decision, as the server says', async () => {
    hubItems = [changeItem('dec1', { view: 'decider', decidable: true })];
    renderHub();
    const row = (await screen.findByText('conn-dec1')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    expect(within(row).getByRole('table', { name: 'Relationships' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Approve as requested' })).toBeInTheDocument();
  });

  test('the Access manager\'s plain row carries no decidable flag: it offers no decision and points to the hub', async () => {
    const { refs: _r, ownership: _o, deciders: _d, decidable: _c, decideVia: _v, relationships: _rel, fieldDiff: _f, ...plain } = changeItem('plain1') as Record<string, unknown>;
    plainItems = [plain];
    render(<MemoryRouter initialEntries={['/settings/access-manager']}><AccessManagerPage /></MemoryRouter>);
    const row = (await screen.findByText('conn-plain1')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Review' }));
    expect(within(row).getByText(/decided on the approvals hub/)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
  });
});
