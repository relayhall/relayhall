// @vitest-environment jsdom
/**
 * Accessibility smoke suite (RH-DESIGN.6 §8/D22, task 07113036).
 *
 * axe-core over the real component trees of the surfaces the RH-UI wave
 * touches. Network is mocked; markup is NOT — a smoke suite that renders
 * stubbed-out children proves nothing, and stub-shaped green is the exact
 * failure mode this file exists to avoid.
 *
 * HONEST SCOPE. jsdom has no layout engine, so axe's colour-contrast rule is
 * inapplicable here and is not what this suite covers: contrast is enforced
 * mechanically, per Theme, by scripts/check-design-contrast.py against the
 * declared pairing matrix. What this suite covers is structure — roles,
 * accessible names, labels, landmarks, heading order, duplicated ids,
 * ARIA validity — which is where jsdom is authoritative. The manual and
 * accessibility-tree pass is RH-UI.6's.
 *
 * The set grows with the wave: About lands in RH-UI.5 and Appearance in
 * RH-UI.4; RH-UI.6 adds the mobile disclosure interaction.
 */
import axe from 'axe-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { LoginPage } from './pages/LoginPage';
import { BreakGlassBanner } from './components/BreakGlassBanner';
import { AboutPage } from './pages/AboutPage';
import { PreferencesPage } from './pages/PreferencesPage';
import { Sidebar } from './components/Sidebar';
import { Button } from './components/Button';
import { TaskColumn } from './components/tasks/TaskColumn';
import { ReportsCard } from './components/dashboard/ReportsCard';
import { SystemStatus } from './components/dashboard/SystemStatus';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { MyConnectionsPage } from './pages/MyConnectionsPage';
import { AuditPage } from './pages/AuditPage';
import { ConnectAgentCard } from './components/dashboard/ConnectAgentCard';
import { SetPasswordPanel } from './components/access/SetPasswordPanel';
import { ThemeProvider } from './contexts/ThemeContext';
import { RelayHallConfigProvider } from './contexts/RelayHallConfigContext';
import type { Task } from './types/task';

vi.mock('./utils/auth', () => ({
  auth: {
    isAuthenticated: () => true, getToken: () => 'token', logout: vi.fn(),
    // Card 27322abb: armed here so the banner RENDERS for the audit below.
    // Whether it should render is measured by BreakGlassBanner.test.tsx; what
    // this file measures is the markup once it does.
    usedBreakGlass: () => true,
  },
  authenticatedFetch: vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`/tasks/${task.id}`)) return new Response(JSON.stringify({ success: true, task }), { status: 200 });
    if (url.endsWith(`/tasks/${task.id}/session-status`)) return new Response(JSON.stringify({ success: true, data: { state: 'active' } }), { status: 200 });
    if (url.includes('/timeline')) return new Response(JSON.stringify({
      success: true,
      filter: 'all',
      nextCursor: null,
      sourcesUnavailable: ['history'],
      events: [
        {
          id: 'stream-1', at: '2026-08-14T12:00:00.000Z', createdAt: '2026-08-14T12:00:00.000Z',
          source: 'stream', provenance: 'reported', eventType: 'outpost.progress', title: 'Outpost progress',
          description: 'Halfway through the implementation.', actor: 'agent-1',
          actorDetail: { principalId: 'principal-1', handle: 'agent-1', role: 'claimant' },
          sessionKey: null, harness: null, metadata: { percent: 50 }, redaction: null,
        },
        {
          id: 'review-1', at: '2026-08-14T11:00:00.000Z', createdAt: '2026-08-14T11:00:00.000Z',
          source: 'review', provenance: 'system', eventType: 'review.reject', title: 'Verifier decision: reject',
          description: 'One finding remains.', actor: 'agent', actorDetail: null,
          sessionKey: null, harness: null, metadata: { findings: ['Missing proof'] }, redaction: null,
        },
        {
          id: 'redacted-1', at: '2026-08-13T10:00:00.000Z', createdAt: '2026-08-13T10:00:00.000Z',
          source: 'stream', provenance: 'authored', eventType: 'note', title: 'Private note',
          description: null, actor: 'reviewer', actorDetail: { principalId: 'principal-2', handle: 'reviewer', role: 'verifier' },
          sessionKey: null, harness: null, metadata: {}, redaction: { mode: 'tombstone', redactedAt: '2026-08-14T13:00:00.000Z' },
        },
      ],
    }), { status: 200 });
    // Card 653be44f — the day-one connection surfaces. The own-chain read is
    // answered with ONE populated connection so the list, the Setup pane and
    // the Advanced tab all have real markup to audit; a stubbed-empty page
    // would prove nothing about the structures this card actually ships.
    if (url.endsWith('/principals/me/connectors')) return new Response(JSON.stringify({
      success: true, connectors: connectorsFixture, instructions: bootstrapInstructions,
    }), { status: 200 });
    if (url.endsWith('/warrants')) return new Response(JSON.stringify({ success: true, warrants: [] }), { status: 200 });
    if (url.includes('/reports?taskId=')) return new Response(JSON.stringify({ success: true, reports: [] }), { status: 200 });
    // Card 96aeacb7 — the audit ledger page, audited with REAL rows and a
    // next-page cursor. An empty ledger renders an empty state, and a smoke
    // suite that audits an empty state proves nothing about the record table,
    // the filter form or the detail drawer this card ships. The actor
    // directory is left at this file's default empty answer on purpose, so
    // the rows exercise the attribution the LEDGER carries — the fallback
    // path, and the one a fresh install actually renders.
    if (url.includes('/audit')) return new Response(JSON.stringify({
      success: true,
      events: auditLedgerFixture,
      nextCursor: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      retention: 'indefinite',
      purgeAvailable: false,
    }), { status: 200 });
    return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
  }),
}));
vi.mock('./hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe: () => () => undefined }) }));
vi.mock('./utils/preferences', () => ({
  fetchPreferences: vi.fn(async () => ({ theme: null, reducedMotion: 'system' })),
  savePreferences: vi.fn(async () => ({ theme: null, reducedMotion: 'system' })),
}));
vi.mock('./config/relayhall', async () => {
  const actual = await vi.importActual<typeof import('./config/relayhall')>('./config/relayhall');
  return { ...actual, fetchConfig: vi.fn(async () => actual.DEFAULT_CONFIG) };
});
vi.mock('./contexts/PluginContext', () => ({
  usePlugins: () => ({
    plugins: [], pluginSidebarItems: [], pluginRoutes: [], loading: false,
  }),
  PluginProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./services/appearance', async () => {
  const actual = await vi.importActual<typeof import('./services/appearance')>('./services/appearance');
  return {
    ...actual,
    loadAppearanceInfo: vi.fn(async () => ({ displayName: null, description: '', links: [], teamMarkdown: '' })),
  };
});
vi.mock('./utils/releaseInfo', async () => {
  const actual = await vi.importActual<typeof import('./utils/releaseInfo')>('./utils/releaseInfo');
  return {
    ...actual,
    loadReleaseManifest: vi.fn(async () => ({
      service: 'relayhall-frontend',
      sha: 'a'.repeat(40),
      dirty: 'false',
      buildContext: 'test',
      builtAt: '2026-08-14T01:02:03Z',
    })),
    loadApiInfo: vi.fn(async () => ({ name: 'RelayHall API', version: '2.0.0' })),
  };
});

/**
 * Rules axe cannot evaluate in jsdom, declared rather than left to a silent
 * "inapplicable". Removing an entry is a strengthening; adding one needs a
 * reason as specific as these.
 */
const RULES_JSDOM_CANNOT_JUDGE = {
  // needs a layout engine to composite colours; the pairing matrix owns this
  'color-contrast': { enabled: false },
} as const;

async function auditOf(container: HTMLElement): Promise<axe.Result[]> {
  const results = await axe.run(container, {
    rules: RULES_JSDOM_CANNOT_JUDGE,
    resultTypes: ['violations'],
  });
  return results.violations;
}

function describeViolations(violations: axe.Result[]): string {
  return violations
    .map((violation) => {
      const where = violation.nodes.map((node) => node.html).join('\n      ');
      return `${violation.id} (${violation.impact}): ${violation.help}\n      ${where}`;
    })
    .join('\n');
}

/** Two recorded acts: one success with metadata, one refusal without. */
const auditLedgerFixture = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    occurredAt: '2026-09-04T09:15:00.000Z',
    action: 'credential.mint', outcome: 'success',
    actorPrincipalId: '11111111-1111-4111-8111-111111111111', actorHandle: 'owner',
    authMethod: 'session', credentialId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'principal', resourceId: '22222222-2222-4222-8222-222222222222',
    metadata: { scopes: ['tasks:read'] },
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    occurredAt: '2026-09-03T08:00:00.000Z',
    action: 'grant.revoke', outcome: 'denied',
    actorPrincipalId: null, actorHandle: 'agent-7',
    authMethod: 'principal_api_key', credentialId: null,
    resourceType: 'grant', resourceId: null,
    metadata: {},
  },
];

const task: Task = {
  id: '2c1c5a3e-1111-4a11-8111-111111111111',
  title: 'Wire the theme engine',
  description: 'A **task** with markdown, a list:\n\n- one\n- two',
  status: 'in-progress',
  priority: 'normal',
  subtasks: [
    { id: 's1', text: 'Bind the Themes', status: 'completed' },
    { id: 's2', text: 'Ship the user config page', status: 'empty' },
  ],
  links: [],
  sessionRefs: [],
  autoCreated: false,
  autoStart: false,
  blockedBy: [],
  tags: ['ui-wave'],
  createdAt: '2026-08-11T10:00:00.000Z',
  updatedAt: '2026-08-11T11:00:00.000Z',
} as unknown as Task;

const bootstrapInstructions = {
  boardEndpoint: 'https://board.example/api',
  bootstrapLine: 'You have a RelayHall board at https://board.example/api.',
  mcpConfig: {
    claudeCode: { mcpServers: { relayhall: { type: 'http', url: 'https://board.example/api/mcp' } } },
    codex: '[mcp_servers.relayhall]',
    generic: { transport: 'streamable-http' },
  },
  cliEnv: ['export RELAYHALL_TOKEN=<paste your connection credential here>'],
  previewPath: '/principals/me/effective-access',
  credentialPlaceholder: '<paste your connection credential here>',
};

/**
 * The own-chain read the mock answers with. It is a `let` because the day-one
 * card exists ONLY for a person with an empty chain: a fixed one-connection
 * fixture meant the audit named after that card could never render it, which is
 * exactly the hole the round-1 reviewer found (T3) — the test asserted the card
 * was ABSENT and then audited a wizard opened from a different page.
 */
let connectorsFixture: unknown[] = [];

const connection = {
  principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  handle: 'connector-laptop',
  displayName: 'Laptop',
  status: 'active',
  lastSeenAt: '2026-09-04T09:00:00.000Z',
  purpose: 'Connector for service laptop',
  service: {
    id: 's1', slug: 'laptop', name: 'Laptop',
    description: 'Claude Code, connected from the Connect your agent flow.',
    status: 'draft', runtimeMode: 'direct', createdAt: null,
  },
  credentials: [{
    id: 'cred-1', keyId: 'rh_dev_public', label: 'Laptop', scopes: ['tasks:read', 'tasks:write'],
    transport: 'mcp', createdAt: null, expiresAt: null, revokedAt: null,
    lastUsedAt: '2026-09-04T09:30:00.000Z', graceUntil: null,
    revealCount: 0, revealable: true, state: 'live' as const,
  }],
  agents: [{
    id: 'agent-1', handle: 'agent-task-1', displayName: null, status: 'active',
    lastSeenAt: null, boundTaskId: '77777777-7777-4777-8777-777777777777',
    mintedUnderWarrantId: null, terminatedAt: null, credentials: [],
  }],
};

beforeEach(() => {
  connectorsFixture = [connection];
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});
afterEach(cleanup);

describe('the audit itself', () => {
  test('fails on markup it should fail on', async () => {
    // A green smoke suite is only evidence if the audit can go red. This
    // fragment carries three unmistakable violations; if axe ever stops
    // running (a bad mock, a jsdom change, a misconfigured rule set), the
    // rest of this file would pass silently and this test would not.
    const { container } = render(
      <div>
        <img src="mark.png" />
        <button />
        <input type="text" />
      </div>
    );
    const violations = await auditOf(container);
    expect(violations.map((violation) => violation.id).sort())
      .toEqual(['button-name', 'image-alt', 'label']);
  });
});

describe('accessibility smoke set', () => {
  test('login page', async () => {
    const { container } = render(
      <RelayHallConfigProvider>
        <ThemeProvider>
          <LoginPage onLoginSuccess={() => undefined} />
        </ThemeProvider>
      </RelayHallConfigProvider>
    );
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  // Card 27322abb (owner ruling 60307311 §1.1). The first-run step REPLACES
  // the sign-in form, so the audit above never reaches it: a deployment that
  // has no administrator sees only this markup, and it is the first thing
  // anybody ever sees of RelayHall.
  test('first-run step on the login page', async () => {
    const relayhall = await import('./config/relayhall');
    vi.mocked(relayhall.fetchConfig).mockResolvedValueOnce({
      ...relayhall.DEFAULT_CONFIG,
      auth: { ...relayhall.DEFAULT_CONFIG.auth, sessions: true, firstRun: true },
    });
    const { container } = render(
      <RelayHallConfigProvider>
        <ThemeProvider>
          <LoginPage onLoginSuccess={() => undefined} />
        </ThemeProvider>
      </RelayHallConfigProvider>
    );
    // The provider fetches after mount; the step is not in the tree until it
    // resolves, and auditing an empty tree would pass by measuring nothing.
    await screen.findByRole('button', { name: 'Create the first administrator' });
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test('break-glass banner', async () => {
    const { container } = render(<BreakGlassBanner />);
    expect(screen.getByRole('status')).toBeTruthy();
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test('user config page', async () => {
    const { container } = render(
      <ThemeProvider>
        <PreferencesPage />
      </ThemeProvider>
    );
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test('About page', async () => {
    const { container } = render(<AboutPage />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  // Card 96aeacb7. The page is audited in BOTH of its populated states: the
  // record on its own, and the record with one act opened. A modal drawer is
  // where an accessible page most often stops being one — an unlabelled
  // dialog, a heading level skipped inside it, a control with no name — and
  // none of that is visible in the closed state.
  test('audit log page, showing the record', async () => {
    const { container } = render(<AuditPage />);
    await screen.findByText('credential.mint');
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test('audit log page, with one recorded act open', async () => {
    const { container } = render(<AuditPage />);
    const row = await screen.findByRole('button', { name: /credential\.mint/ });
    fireEvent.click(row);
    await screen.findByRole('dialog');
    // The drawer renders INSIDE the page, not through a portal, so the
    // container holds both and they are judged together — which is how a
    // reader meets them.
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test('shell navigation', async () => {
    const { container } = render(
      <MemoryRouter>
        <>
          <Sidebar connected />
          <main><h1>Dashboard</h1></main>
        </>
      </MemoryRouter>
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelectorAll('aside[aria-label="Application sidebar"]')).toHaveLength(1);
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test('explicitly named icon button remains keyboard operable', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <Button ariaLabel="Create new task" icon={<svg aria-hidden="true" />} onClick={onClick}>
        New Task
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Create new task' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test.each([390, 1024])(
    'mobile shell is a keyboard-safe disclosure at %ipx',
    async (width) => {
      const listeners = new Set<(event: MediaQueryListEvent) => void>();
      const query = {
        matches: width <= 1279,
        media: '(max-width: 1279px)',
        onchange: null,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as unknown as MediaQueryList;
      vi.stubGlobal('matchMedia', vi.fn(() => query));

      render(
        <MemoryRouter>
          <Sidebar connected />
        </MemoryRouter>
      );

      const button = screen.getByRole('button', { name: 'Open menu' });
      const sidebar = document.getElementById('sidebar-navigation');
      expect(sidebar).not.toBeNull();
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('aria-controls')).toBe('sidebar-navigation');
      expect(sidebar?.hasAttribute('inert')).toBe(true);
      expect(sidebar?.getAttribute('aria-hidden')).toBe('true');

      fireEvent.click(button);
      expect(screen.getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded')).toBe('true');
      expect(sidebar?.hasAttribute('inert')).toBe(false);
      expect(sidebar?.hasAttribute('aria-hidden')).toBe(false);

      const dashboard = screen.getByRole('link', { name: 'Dashboard' });
      dashboard.focus();
      expect(document.activeElement).toBe(dashboard);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.getByRole('button', { name: 'Open menu' }).getAttribute('aria-expanded')).toBe('false');
      expect(sidebar?.hasAttribute('inert')).toBe(true);
      expect(sidebar?.getAttribute('aria-hidden')).toBe('true');
      expect(document.activeElement).toBe(button);
    }
  );

  test('task board column uses a valid labelled group and heading hierarchy', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <main>
          <h1>Tasks</h1>
          <TaskColumn
            status="todo"
            title="To do"
            tasks={[{ ...task, status: 'todo' }]}
            total={1}
            onDragStart={vi.fn()}
            onDragEnd={vi.fn()}
            onDrop={vi.fn()}
            onUpdateTask={vi.fn()}
            onSubtaskTransition={vi.fn()}
            onDeleteTask={vi.fn()}
          />
        </main>
      </MemoryRouter>
    );
    expect(container.querySelector('[data-status="todo"]')?.getAttribute('role')).toBe('group');
    expect(container.querySelector('h1')?.textContent).toBe('Tasks');
    expect(container.querySelector('h2')?.textContent).toBe('To do');
    expect(container.querySelector('h3')?.textContent).toBe(task.title);
    // C2 (3cdf6e65 §2.1): the article carries NO interactive role and NO
    // draggable of its own — drag initiates only from the handle.
    const article = container.querySelector('article.task-card');
    expect(article?.getAttribute('draggable')).toBeNull();
    expect(article?.getAttribute('role')).toBeNull();
    // exactly one NAMED opener; the stretched overlay is inert
    expect(screen.getAllByRole('button', { name: `Open task: ${task.title}` })).toHaveLength(1);
    const overlay = container.querySelector('.task-card-open-surface');
    expect(overlay?.getAttribute('aria-hidden')).toBe('true');
    expect(overlay?.tagName).toBe('SPAN');
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');

    const tagAction = container.querySelector('.task-card-tag') as HTMLButtonElement;
    await user.click(tagAction);
    expect(screen.queryByRole('dialog', { name: 'Task details' })).toBeNull();

    // handle: named menu button, mounted OUTSIDE the handle, APG keyboard
    const handle = screen.getByRole('button', { name: `Move task: ${task.title}` });
    expect(handle.getAttribute('aria-haspopup')).toBe('menu');
    handle.focus();
    await user.keyboard('{Enter}');
    const menu = screen.getByRole('menu', { name: `Move task: ${task.title}` });
    expect(handle.contains(menu)).toBe(false);
    expect(handle.getAttribute('aria-expanded')).toBe('true');
    // menu is axe-clean while open (nested-interactive would surface here)
    expect(describeViolations(await auditOf(document.body))).toBe('');
    // current state is disabled; arrows stay inside the menu
    const items = screen.getAllByRole('menuitem');
    expect(items.some(i => i.textContent === 'Todo' && (i as HTMLButtonElement).disabled)).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(handle);
  });

  test('card activation NAVIGATES to /tasks/:taskId — opener and stretched overlay (C2 §2.2/§8)', async () => {
    const user = userEvent.setup();
    const locations: string[] = [];
    const LocationProbe = () => { locations.push(useLocation().pathname); return null; };
    const { container } = render(
      <MemoryRouter initialEntries={['/tasks']}>
        <LocationProbe />
        <main>
          <TaskColumn
            status="todo"
            title="To do"
            tasks={[{ ...task, status: 'todo' }]}
            total={1}
            onDragStart={vi.fn()}
            onDragEnd={vi.fn()}
            onDrop={vi.fn()}
            onUpdateTask={vi.fn()}
            onSubtaskTransition={vi.fn()}
            onDeleteTask={vi.fn()}
          />
        </main>
      </MemoryRouter>
    );
    const opener = screen.getByRole('button', { name: `Open task: ${task.title}` });
    await user.click(opener);
    expect(locations[locations.length - 1]).toBe(`/tasks/${task.id}`);
    // the stretched overlay forwards to the same action
    const overlay = container.querySelector('.task-card-open-surface') as HTMLElement;
    fireEvent.click(overlay);
    expect(locations[locations.length - 1]).toBe(`/tasks/${task.id}`);
  });

  test('dashboard cards keep a valid heading hierarchy under the page h1', async () => {
    // Final RH-UI.6 QA (exact e70c46e) caught axe heading-order on the
    // dashboard: card titles rendered as h3 directly under the page h1.
    // Cards are h2 sections now; this pins the level.
    const { container } = render(
      <MemoryRouter>
        <main>
          <h1>Dashboard</h1>
          <ReportsCard />
          <SystemStatus />
        </main>
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { level: 2, name: /Reports/ })).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 2, name: /System Status/ })).toBeTruthy();
    expect(container.querySelector('.reports-card-header h3')).toBeNull();
    expect(container.querySelector('.system-status-header h3')).toBeNull();
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test('routed Task details timeline is axe-clean inside the production shell when populated and expanded', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <RelayHallConfigProvider>
          <MemoryRouter initialEntries={[`/tasks/${task.id}?filter=all`]}>
            <div className="app-container">
              <Sidebar connected />
              <div className="app">
                <main id="main-content" className="main-content">
                  <Routes><Route path="/tasks/:taskId" element={<TaskDetailPage />} /></Routes>
                </main>
              </div>
            </div>
          </MemoryRouter>
        </RelayHallConfigProvider>
      </QueryClientProvider>
    );
    await screen.findByRole('heading', { level: 1, name: task.title });
    const timeline = await screen.findByRole('complementary', { name: 'Timeline' });
    expect(within(timeline).getAllByRole('list')).not.toHaveLength(0);
    expect(timeline.querySelectorAll('time').length).toBeGreaterThanOrEqual(4);
    const expansion = within(timeline).getByRole('button', { name: 'Show details for Outpost progress' });
    expansion.focus();
    await user.keyboard('{Enter}');
    expect(expansion.getAttribute('aria-expanded')).toBe('true');
    expect(within(timeline).getByText('Outpost progress detail')).toBeTruthy();
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test('My connections is axe-clean inside the production shell, with Setup and Advanced open', async () => {
    // Card 653be44f. Composed under the real shell, not in isolation: heading
    // order, the disclosure buttons' aria-expanded/aria-controls pairing and
    // the segmented harness tabs are all things that only go wrong in context.
    const user = userEvent.setup();
    const { container } = render(
      <RelayHallConfigProvider>
        <MemoryRouter initialEntries={['/settings/connections']}>
          <div className="app-container">
            <Sidebar connected />
            <div className="app">
              <main id="main-content" className="main-content">
                <MyConnectionsPage />
              </main>
            </div>
          </div>
        </MemoryRouter>
      </RelayHallConfigProvider>
    );
    await screen.findByRole('heading', { level: 1, name: 'My connections' });
    const row = (await screen.findByRole('heading', { level: 2, name: 'Laptop' })).closest('li') as HTMLElement;

    const setup = within(row).getByRole('button', { name: /Setup/ });
    expect(setup.getAttribute('aria-expanded')).toBe('false');
    await user.click(setup);
    expect(setup.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByRole('radiogroup', { name: 'Client to configure' })).toBeTruthy();
    expect(await auditOf(container)).toHaveLength(0);

    await user.click(within(row).getByRole('button', { name: /Advanced/ }));
    expect(await screen.findByRole('heading', { level: 3, name: 'What it can do' })).toBeTruthy();
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test('the day-one card renders, is axe-clean, and opens the wizard inside itself', async () => {
    // Card 653be44f, repaired after round-1 finding T3. This audits the ACTUAL
    // composition the test is named for: the day-one card, on a dashboard, for
    // a person with an EMPTY chain — and then the wizard mounted INSIDE it.
    // The previous version asserted the card was absent (because the shared
    // fixture always had a connection) and audited a wizard opened from My
    // connections instead, so a broken heading level on the real card stayed
    // green under mutation.
    connectorsFixture = [];
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <main>
          <h1>Dashboard</h1>
          <ConnectAgentCard />
        </main>
      </MemoryRouter>
    );
    // The card is an h2 section like every other dashboard card.
    expect(await screen.findByRole('heading', { level: 2, name: /Connect your agent/ })).toBeTruthy();
    expect(describeViolations(await auditOf(container))).toBe('');

    // ...and the wizard it opens is an h2 with h3 steps beneath, so opening it
    // inside the card cannot skip a level.
    await user.click(screen.getByRole('button', { name: /Connect your agent/ }));
    expect(await screen.findByRole('heading', { level: 3, name: 'What is it for?' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'What the connection is for' })).toBeTruthy();
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test('My connections opens the same wizard without skipping a heading level', async () => {
    const user = userEvent.setup();
    const page = render(
      <MemoryRouter initialEntries={['/settings/connections']}>
        <main><h1>Settings</h1><MyConnectionsPage /></main>
      </MemoryRouter>
    );
    await within(page.container).findByRole('heading', { level: 2, name: 'Laptop' });
    await user.click(within(page.container).getByRole('button', { name: 'Connect an agent' }));
    expect(await within(page.container).findByRole('heading', { level: 2, name: /Connect your agent/ })).toBeTruthy();
    expect(within(page.container).getByRole('heading', { level: 3, name: 'What is it for?' })).toBeTruthy();
    const violations = await auditOf(page.container);
    expect(describeViolations(violations)).toBe('');
  });

  test('the password control is axe-clean, labelled, and keyboard-reachable (bc5cd9f0)', async () => {
    // Card bc5cd9f0. Audited as it is actually composed — inside a page with an
    // h1, so its h2 cannot skip a level — with every control reached by its
    // ACCESSIBLE NAME rather than by a class or a test id: a panel whose fields
    // are only findable by markup is a panel a screen reader cannot fill in.
    const user = userEvent.setup();
    const people = [
      { id: 'me', handle: 'ada', kind: 'human', status: 'active', role: 'admin', displayName: null },
      { id: 'p-grace', handle: 'grace', kind: 'human', status: 'active', role: 'user', displayName: 'Grace Hopper' },
    ] as any[];
    const { container } = render(
      <main>
        <h1>Access manager</h1>
        <SetPasswordPanel
          principals={people}
          issuerRole="admin"
          ownPrincipalId="me"
          surface={() => undefined}
        />
      </main>
    );

    expect(screen.getByRole('heading', { level: 2, name: /Passwords/ })).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Set an Account password' })).toBeTruthy();
    expect(screen.getByLabelText('Account')).toBeTruthy();
    expect(screen.getByLabelText(/New password/)).toBeTruthy();
    expect(screen.getByLabelText('Type it again')).toBeTruthy();
    expect(describeViolations(await auditOf(container))).toBe('');

    // The mismatch hint is announced, not merely painted: it is a live region
    // and it is the field's own description, so it reaches somebody who cannot
    // see the two boxes side by side.
    await user.selectOptions(screen.getByLabelText('Account'), 'p-grace');
    await user.type(screen.getByLabelText(/New password/), 'one-password');
    await user.type(screen.getByLabelText('Type it again'), 'another-password');
    const mismatch = screen.getByText('The two entries do not match.');
    expect(mismatch.getAttribute('role')).toBe('status');
    expect(screen.getByLabelText('Type it again').getAttribute('aria-describedby')).toBe(mismatch.id);
    expect(describeViolations(await auditOf(container))).toBe('');
  });

});
