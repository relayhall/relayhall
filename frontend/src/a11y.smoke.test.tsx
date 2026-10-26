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
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import axe from 'axe-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { LoginPage } from './pages/LoginPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { authenticatedFetch } from './utils/auth';
import { BreakGlassBanner } from './components/BreakGlassBanner';
import { AboutPage } from './pages/AboutPage';
import { loadApiInfo, loadReleaseManifest } from './utils/releaseInfo';
import { PreferencesPage } from './pages/PreferencesPage';
import { Sidebar } from './components/Sidebar';
import { Button } from './components/Button';
import { TaskColumn } from './components/tasks/TaskColumn';
import { TaskActivityBadge } from './components/tasks/TaskActivityBadge';
import { FilterBar, type TaskFilters } from './components/tasks/FilterBar';
import { ReportsCard } from './components/dashboard/ReportsCard';
import { SystemStatus } from './components/dashboard/SystemStatus';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { MyConnectionsPage } from './pages/MyConnectionsPage';
import { BootstrapPane } from './components/connections/BootstrapPane';
import { AuditPage } from './pages/AuditPage';
import { ConnectAgentCard } from './components/dashboard/ConnectAgentCard';
import { SetPasswordPanel } from './components/access/SetPasswordPanel';
import { SharedWritersPanel } from './components/access/SharedWritersPanel';
import { CeilingRulesField } from './components/access/CeilingRulesField';
import { ApprovalsQueue } from './components/approvals/ApprovalsQueue';
import { GrantsPage } from './pages/GrantsPage';
import { PrincipalsPage } from './pages/PrincipalsPage';
import roleCatalogueFixture from './components/access/roleCatalogue.generated.json';
import { SessionsPage } from './pages/SessionsPage';
import { KnowledgePage } from './pages/KnowledgePage';
import type { CeilingRuleRow } from './components/access/ceilingRules';
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
  authenticatedFetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`/tasks/${task.id}`)) return new Response(JSON.stringify({ success: true, task }), { status: 200 });
    if (url.endsWith(`/tasks/activity?ids=${task.id}`)) return new Response(JSON.stringify({ success: true, observedAt: new Date().toISOString(), staleAfterMs: 540000, activity: [{ taskId: task.id, state: 'active', kind: 'heartbeat', receivedAt: new Date(Date.now() - 1000).toISOString() }] }), { status: 200 });
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
    // Card 785e1eed P1-B-2 — the approvals queue with a CREDENTIAL request,
    // answered only while the queue case below arms the fixture, so the
    // shell's pending-approvals poll keeps this file's default answer.
    if (approvalsFixture && url.includes(`/approvals/${approvalsFixture.approval.id}`)) {
      return new Response(JSON.stringify({
        success: true, approval: approvalsFixture.approval, events: [], decision: approvalsFixture.decision,
      }), { status: 200 });
    }
    if (approvalsFixture && url.includes('/approvals')) {
      return new Response(JSON.stringify({
        success: true, approvals: [approvalsFixture.approval], viewer: { isRoot: true, isAdministrator: true },
      }), { status: 200 });
    }
    // Card 21787b03 - the Access grants page, answered only while its case
    // arms the fixture, so every other case keeps this file's default answer
    // for its own identity and directory reads: an owner-plane identity, one
    // active identity to grant to, one listed row, and a create that echoes
    // what the form sent without identity summaries, as the server does.
    if (grantsFixture && url.endsWith('/principals/me')) return new Response(JSON.stringify({
      success: true, principal: grantsFixture.me, scopes: ['root'],
    }), { status: 200 });
    // Card caea70ef - an identity's detail page also reads credentials and the
    // role catalogue, answered only while the same fixture is armed.
    if (grantsFixture && url.endsWith('/credentials')) return new Response(JSON.stringify({
      success: true, credentials: grantsFixture.credentials ?? [],
    }), { status: 200 });
    if (grantsFixture && url.endsWith('/principals/roles')) return new Response(JSON.stringify({
      success: true, roles: roleCatalogueFixture.roles,
    }), { status: 200 });
    if (grantsFixture && url.endsWith('/principals')) return new Response(JSON.stringify({
      success: true, principals: grantsFixture.principals,
    }), { status: 200 });
    if (grantsFixture && url.endsWith('/grants') && init?.method === 'POST') return new Response(JSON.stringify({
      success: true,
      grant: { ...grantsFixture.grants[0], id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', resourceId: null, expiresAt: null, grantee: null, ...JSON.parse(String(init.body)) },
    }), { status: 201 });
    // Owner ruling E413: the clean-up's dry run, answered while its case arms it.
    if (grantsFixture?.bulkRevoke && url.endsWith('/grants/bulk-revoke')) {
      return new Response(JSON.stringify(grantsFixture.bulkRevoke), { status: 200 });
    }
    // Card ff410dc4: the Access page reads one page with query parameters, so
    // the list path is matched with or without them (`/principals/{id}/grants`
    // still ends the path).
    if (grantsFixture && /\/grants(\?.*)?$/.test(url)) return new Response(JSON.stringify({
      success: true, grants: grantsFixture.grants,
      ...(grantsFixture.pagination ? { pagination: grantsFixture.pagination } : {}),
      ...(grantsFixture.madeCounts ? { madeCounts: grantsFixture.madeCounts } : {}),
    }), { status: 200 });
    // Card 549cc51f - the shared-area writer list, answered only while its case
    // arms the fixture.
    if (sharedWritersFixture && url.includes('/knowledge-shared-writers')) {
      return new Response(JSON.stringify(sharedWritersFixture), { status: 200 });
    }
    // Card 0ac41d40 - the Agent sessions page with a short-session count and a
    // further page, so the toggle, both filter selects and "Load more" all
    // render. The default answer elsewhere would leave the page empty, and an
    // empty state is not the markup this card ships.
    if (url.includes('/telemetry/presence')) return new Response(JSON.stringify({
      success: true, sources: [sessionsSourceFixture],
    }), { status: 200 });
    if (url.includes('/telemetry/sessions/')) return new Response(JSON.stringify({
      success: true, session: sessionsRowFixture, truncated: false, events: [],
    }), { status: 200 });
    if (url.includes('/telemetry/sessions')) return new Response(JSON.stringify({
      success: true, sessions: [sessionsRowFixture], hiddenCount: 2, shortCount: 2, total: 3,
      offset: 0, nextOffset: 1, shortSession: { maxEvents: 3, minDurationMs: 120_000 },
    }), { status: 200 });
    // Card 1fd5de08, line 1 - the Knowledge search console, answered only while its
    // case arms the fixture: a source list, a partial answer with results, and
    // a cited revision for the reader.
    if (knowledgeFixture && url.includes('/knowledge-sources')) {
      return new Response(JSON.stringify({ success: true, sources: knowledgeFixture.sources }), { status: 200 });
    }
    if (knowledgeFixture && url.includes('/knowledge-queries')) {
      return new Response(JSON.stringify({ success: true, ...knowledgeFixture.answer }), { status: 200 });
    }
    if (knowledgeFixture && url.includes('/knowledge-contents')) {
      return new Response(JSON.stringify({ success: true, ...knowledgeFixture.content }), { status: 200 });
    }
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
    plugins: sidebarPluginsFixture, pluginSidebarItems: [], pluginRoutes: [], loading: false,
  }),
  PluginProvider: ({ children }: { children: React.ReactNode }) => children,
}));
// The sidebar widget frames are audited as documents of their own; the bridge
// that would poll the board for them is not what these audits are about.
vi.mock('./utils/pluginBridge', () => ({
  attachPluginBridge: () => () => undefined,
  trustedPluginMessage: () => false,
}));
vi.mock('./services/appearance', async () => {
  const actual = await vi.importActual<typeof import('./services/appearance')>('./services/appearance');
  return {
    ...actual,
    loadAppearanceInfo: vi.fn(async () => ({ displayName: null, description: '', links: [], teamMarkdown: '' })),
  };
});
// Card 6d549392: the default is a COMPLETE identity for both artefacts; the
// About audits below override it per test for the partial and empty states.
vi.mock('./utils/releaseInfo', async () => {
  const actual = await vi.importActual<typeof import('./utils/releaseInfo')>('./utils/releaseInfo');
  const identity = {
    version: '2.0.0',
    sha: 'a'.repeat(40),
    dirty: 'false',
    buildContext: 'test',
    builtAt: '2026-08-14T01:02:03Z',
  };
  return {
    ...actual,
    loadReleaseManifest: vi.fn(async () => ({ service: 'relayhall-frontend', ...identity })),
    loadApiInfo: vi.fn(async () => ({
      name: 'RelayHall API',
      version: '2.0.0',
      build: { service: 'relayhall-backend', ...identity },
    })),
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

/** Card 30d198df (4): the stylesheets a board card ships, in import order. */
const CARD_SHEETS = ['index.css', 'components/tasks/TaskColumn.css', 'components/tasks/TaskCard.css',
  'components/tasks/TaskActivityBadge.css'];

/** A media query list evaluated at one viewport width. Only the conditions the
 * card's sheets use are modelled; anything else throws, so a new condition
 * cannot be silently treated as false. Reduced motion and a coarse pointer are
 * the defaults of the desktop browser this models: off. */
function mediaMatches(list: string, width: number): boolean {
  return list.split(',').some(query => query.trim().split(/\s+and\s+/i).every(raw => {
    const feature = raw.trim();
    const size = /^\(\s*(max|min)-width:\s*(\d+)px\s*\)$/.exec(feature);
    if (size) return size[1] === 'max' ? width <= Number(size[2]) : width >= Number(size[2]);
    if (/^\(\s*(prefers-reduced-motion:\s*reduce|pointer:\s*coarse)\s*\)$/.test(feature)) return false;
    throw new Error(`unmodelled media condition: ${feature}`);
  }));
}

/** The card sheets with every @media block resolved at `width`: a matching
 * block's rules are kept in place, a non-matching block is dropped. */
function cardStylesAt(width: number, sheets: readonly string[] = CARD_SHEETS): string {
  const out: string[] = [];
  for (const name of sheets) {
    const parse = document.createElement('style');
    parse.textContent = readFileSync(resolvePath(__dirname, name), 'utf8');
    document.head.appendChild(parse);
    try {
      for (const rule of Array.from(parse.sheet?.cssRules ?? [])) {
        if (rule instanceof CSSMediaRule) {
          if (mediaMatches(rule.media.mediaText, width)) out.push(...Array.from(rule.cssRules, inner => inner.cssText));
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

/** What, in the cascade at `width`, would stop an activity badge from
 * wrapping: the badge not a wrapping flex row, a minimum wider than nothing,
 * a box wider than the viewport, no-wrap text anywhere from the card down to
 * the badge's words (white-space inherits, so the card's own ancestors
 * count), or an observation time that cannot break. Visually hidden text is
 * exempt. */
function narrowWrapProblems(root: HTMLElement, width: number): string[] {
  const problems: string[] = [];
  for (const badge of Array.from(root.querySelectorAll<HTMLElement>('.task-activity'))) {
    const own = getComputedStyle(badge);
    if (own.display !== 'flex') problems.push(`.task-activity display is ${own.display}`);
    if (own.flexWrap !== 'wrap') problems.push(`.task-activity flex-wrap is ${own.flexWrap}`);
    if (!['0', '0px'].includes(own.minWidth)) problems.push(`.task-activity min-width is ${own.minWidth || 'unset'}`);
    const path: HTMLElement[] = [];
    for (let node = badge.parentElement; node && root.contains(node); node = node.parentElement) path.unshift(node);
    const words = Array.from(badge.querySelectorAll<HTMLElement>('*')).filter(node => !node.closest('.sr-only'));
    for (const node of [...path, badge, ...words]) {
      const style = getComputedStyle(node);
      const name = node === badge ? '.task-activity' : node.tagName.toLowerCase();
      if (node !== badge) {
        for (const prop of ['minWidth', 'width'] as const) {
          const px = /^(\d+(?:\.\d+)?)px$/.exec(style[prop]);
          if (px && Number(px[1]) > width) problems.push(`${name} ${prop} is ${style[prop]}`);
        }
      }
      if (node.tagName === 'TIME' && style.overflowWrap !== 'anywhere') {
        problems.push(`time overflow-wrap is ${style.overflowWrap || 'unset'}`);
      }
      if (['nowrap', 'pre'].includes(style.whiteSpace)) problems.push(`${name} white-space is ${style.whiteSpace}`);
    }
  }
  return problems;
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
// Owner ruling E458: the plugin registry the shell's sidebar draws its widgets from.
let sidebarPluginsFixture: unknown[] = [];

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

/** The approvals the queue case reads; null everywhere else (see the mock). */
let approvalsFixture: { approval: Record<string, unknown> & { id: string }; decision: Record<string, unknown> } | null = null;

const credentialRequest = {
  id: '99999999-9999-4999-8999-999999999992', kind: 'credential', status: 'pending',
  requesterPrincipalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', requesterHandle: 'connector-laptop',
  targetTaskId: null, targetTaskTitle: null, requestedScopes: ['tasks:read', 'phases:write'],
  requestedRules: [], approvedScopes: null, approvedRules: null, lapseReason: null, denialReason: null,
  requestedAt: '2026-10-10T08:00:00.000Z', pendingExpiresAt: '2026-10-17T08:00:00.000Z', collectExpiresAt: null,
  accessRequest: {
    granteePrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', granteeHandle: 'acct-owner',
    reason: 'The run must edit phases to finish the release handover.', requestedExpiresAt: '2026-10-24T08:00:00.000Z',
    approvedExpiresAt: null, relatedTaskId: '44444444-4444-4444-8444-444444444444', relatedTaskTitle: 'Hand over the release',
    relatedPhaseId: null, relatedPhaseName: null, relatedProjectId: null, relatedProjectTitle: null,
    createdGrantIds: [], issuedCredentialId: null, requestedTransport: 'any', approvedTransport: null, credentialLabel: null,
  },
};

const credentialDecision = {
  kind: 'credential',
  credential: {
    target: { principalId: credentialRequest.requesterPrincipalId, handle: 'connector-laptop', kind: 'service', status: 'active' },
    liveCredentials: [{
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', label: 'Laptop credential', keyId: 'AbCdEfGh1234',
      scopes: ['tasks:read', 'tasks:write'], transport: 'any', expiresAt: null, requesting: true,
    }],
    requestedScopes: [
      { scope: 'tasks:read', heldByRequestingCredential: true, heldByAnyLiveCredential: true },
      { scope: 'phases:write', heldByRequestingCredential: false, heldByAnyLiveCredential: false },
    ],
    newScopes: ['phases:write'], requestedTransport: 'any', approvedTransport: null, label: null,
    effectiveAfterIssue: ['tasks:read', 'phases:write'], inertScopes: [],
    deciderCap: { standing: 'root', delegable: [], within: ['tasks:read', 'phases:write'], exceeding: [] },
    collectExpiresAt: null, issuedCredentialId: null, previousCredentialStays: true,
  },
};

/** The Agent sessions case's one source and one row (card 0ac41d40). */
const sessionsSourceFixture = {
  connectorId: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', connectorHandle: 'laptop-reporter',
  connectorDisplayName: 'Laptop reporter', accountId: 'acct-1', sourceProduct: 'claude-code',
  adapter: 'claude-code-otlp', adapterVersion: '1.2.3', mechanism: 'push', supportLevel: 'tested',
  lastVerified: '2026-09-01', policyTier: 0, schemaVersion: 'rh.ai.telemetry/1.0',
  lastSeenAt: '2026-09-05T10:00:00.000Z', firstSeenAt: '2026-09-05T09:00:00.000Z', lastPhase: 'running',
  eventCount: 12, sessionCount: 3, errorCount: 0, state: 'active', basis: 'envelope', connectorFrame: null,
};
const sessionsRowFixture = {
  sessionRef: 'rhp_abcdefghijklmnopqrstuvwxy0', connectorId: sessionsSourceFixture.connectorId,
  connectorHandle: 'laptop-reporter', connectorDisplayName: 'Laptop reporter', sourceProduct: 'claude-code',
  state: 'active', startedAt: '2026-09-05T09:00:00.000Z', lastSeenAt: '2026-09-05T10:00:00.000Z',
  lastPhase: 'running', eventCount: 6, errorCount: 0, models: ['claude-opus-5'],
  inputTokens: 1200, outputTokens: 340, totalTokens: 1540, requests: 6,
};

/** What the Access grants case reads; null everywhere else (see the mock). */
let grantsFixture: {
  me: Record<string, unknown>; principals: Record<string, unknown>[]; grants: Record<string, unknown>[];
  credentials?: Record<string, unknown>[];
  pagination?: Record<string, unknown>; madeCounts?: Record<string, number>;
  bulkRevoke?: Record<string, unknown>;
} | null = null;
// Card 549cc51f: the shared-area writer list answer, armed by its own case only.
let sharedWritersFixture: Record<string, unknown> | null = null;
/** Card 1fd5de08, line 1: the Knowledge console's three reads, armed by its case only. */
let knowledgeFixture: { sources: unknown[]; answer: Record<string, unknown>; content: Record<string, unknown> } | null = null;

const grantsHolder = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', handle: 'tester', displayName: 'Focused Tester',
  kind: 'human', status: 'active', role: 'viewer',
};

beforeEach(() => {
  approvalsFixture = null;
  grantsFixture = null;
  knowledgeFixture = null;
  connectorsFixture = [connection];
  sidebarPluginsFixture = [];
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

  // Card 6d549392. About is audited in each of its identity states. Each test
  // first proves the state it claims to audit is the one rendered: an audit
  // of the loading placeholder would pass by measuring nothing.
  test('About page, complete build identity', async () => {
    const { container } = render(<AboutPage />);
    const backend = await screen.findByRole('region', { name: 'Backend build' });
    expect(within(backend).queryByText('Unavailable')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test('About page, partial build identity', async () => {
    vi.mocked(loadReleaseManifest).mockImplementationOnce(async () => ({
      service: 'relayhall-frontend', version: '2.0.0', sha: 'a'.repeat(40), dirty: null, buildContext: null, builtAt: null,
    }));
    vi.mocked(loadApiInfo).mockImplementationOnce(async () => ({ name: 'RelayHall API', version: '1.0.0', build: null }));
    const { container } = render(<AboutPage />);
    const backend = await screen.findByRole('region', { name: 'Backend build' });
    expect(within(backend).getAllByText('Unavailable')).toHaveLength(4);
    expect(screen.getByRole('status', { name: /identities differ/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  test('About page, no build identity', async () => {
    vi.mocked(loadReleaseManifest).mockImplementationOnce(async () => { throw new Error('down'); });
    vi.mocked(loadApiInfo).mockImplementationOnce(async () => { throw new Error('down'); });
    const { container } = render(<AboutPage />);
    expect((await screen.findByRole('alert')).textContent).toContain('unavailable');
    const frontend = screen.getByRole('region', { name: 'Frontend build' });
    expect(within(frontend).getAllByText('Unavailable')).toHaveLength(4);
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

  // Owner ruling E458: a plugin widget that opts in with frame "section" is a
  // sidebar section (a folding heading and the frame under it, no box). Audited
  // in the production shell beside the identity widget and a boxed neighbour,
  // folded and unfolded, at desktop width and at 375 px (where the sidebar is
  // the drawer, opened). The cascade's colour pairings are the contrast gate's,
  // which axe cannot judge in jsdom; every theme draws this heading with the
  // navigation headings' own ink.
  test.each([1280, 375])('the sidebar with a section-framed widget, folded and unfolded, is axe-clean at %ipx (E458)', async (width) => {
    const user = userEvent.setup();
    const restoreWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: mediaMatches(query, width), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    const widget = (name: string, extra: Record<string, unknown> = {}) => ({
      name, healthy: true, schema_version: 'rh.plugin/1', api_base: '/plugins/' + name,
      sidebar_widget: { path: '/widget', height: 200, ...extra },
    });
    sidebarPluginsFixture = [widget('nim-orb'), widget('usage-limits', { grow: true, frame: 'section' }), widget('zeta')];
    try {
      const { container } = render(
        <MemoryRouter>
          <Sidebar connected />
        </MemoryRouter>
      );
      if (width <= 1279) await user.click(screen.getByRole('button', { name: 'Open menu' }));
      // axe cannot reach into a sandboxed frame in jsdom, so the frames are left to the plugin's own
      // document and the host-owned part is checked here: every frame is named by its section heading.
      const frames = Array.from(container.querySelectorAll('iframe'));
      expect(frames.map(frame => frame.getAttribute('title'))).toEqual(['Activity Status', 'Usage limits', 'Zeta']);
      const audit = async () => describeViolations((await axe.run(
        { include: [container], exclude: [['iframe']] }, { rules: RULES_JSDOM_CANNOT_JUDGE, resultTypes: ['violations'] })).violations);
      const region = screen.getByRole('region', { name: 'Usage limits' });
      expect(region.classList.contains('sidebar-plugin-widget--section')).toBe(true);
      expect(screen.getByRole('region', { name: 'Zeta' }).classList.contains('sidebar-plugin-widget--section')).toBe(false);
      const heading = within(region).getByRole('button', { name: 'Usage limits' });
      expect(heading.getAttribute('aria-expanded')).toBe('true');
      expect(await audit()).toBe('');
      await user.click(heading);
      expect(heading.getAttribute('aria-expanded')).toBe('false');
      expect(await audit()).toBe('');
      await user.click(heading);
      expect(heading.getAttribute('aria-expanded')).toBe('true');
      expect(await audit()).toBe('');
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: restoreWidth });
    }
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

  test('every task activity state on a board column is named, adds no tab stop and is axe-clean (b595b3b0)', async () => {
    const states = ['active', 'idle', 'stale', 'unknown', 'unavailable'] as const;
    const tasks = states.map((state, index) => ({ ...task, id: `0000000${index}-0000-4000-8000-000000000000`, title: `Activity ${state}`, status: 'in-progress' as const }));
    const taskActivity = new Map(states.map((state, index) => [tasks[index].id, {
      state, receivedAt: state === 'unknown' || state === 'unavailable' ? null : '2026-10-06T12:00:00Z' }]));
    const { container } = render(
      <MemoryRouter>
        <main>
          <h1>Tasks</h1>
          <TaskColumn status="in-progress" title="In progress" tasks={tasks} total={tasks.length} taskActivity={taskActivity}
            onDragStart={vi.fn()} onDragEnd={vi.fn()} onDrop={vi.fn()} onUpdateTask={vi.fn()} onSubtaskTransition={vi.fn()} onDeleteTask={vi.fn()} />
        </main>
      </MemoryRouter>
    );
    for (const label of ['Active', 'Idle', 'Stale', 'Unknown', 'Unavailable']) {
      const badge = screen.getByText(`Task activity: ${label}`).closest('.task-activity') as HTMLElement;
      expect(badge.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')).toHaveLength(0);
      expect(badge.hasAttribute('aria-label')).toBe(false);
    }
    expect(container.querySelectorAll('.task-activity time')).toHaveLength(3);
    const violations = await auditOf(container);
    expect(describeViolations(violations)).toBe('');
  });

  // Card 30d198df (4). jsdom has no layout engine, so a narrow phone is
  // modelled the way the browser would decide it: the stylesheets the card
  // ships, every @media block resolved at that width (an unmodelled media
  // condition throws rather than being skipped), and the cascade read back
  // through getComputedStyle on the real rendered column. What it proves is
  // that nothing in the cascade at that width stops the badge from wrapping;
  // pixel overflow itself needs a browser.
  test.each([320, 375])('the task activity badge can wrap on a %ipx board column and stays axe-clean', async (width) => {
    const restoreWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: mediaMatches(query, width), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    const style = document.createElement('style');
    style.textContent = cardStylesAt(width);
    document.head.appendChild(style);
    try {
      const states = ['active', 'idle', 'stale', 'unknown', 'unavailable'] as const;
      const tasks = states.map((state, index) => ({ ...task, id: `1000000${index}-0000-4000-8000-000000000000`,
        title: `A long In Progress title that has to wrap at ${width} pixels: ${state}`, status: 'in-progress' as const }));
      const taskActivity = new Map(states.map((state, index) => [tasks[index].id, {
        state, receivedAt: state === 'unknown' || state === 'unavailable' ? null : '2026-10-06T12:00:00Z' }]));
      const { container } = render(
        <MemoryRouter>
          <main style={{ width: `${width}px` }}>
            <h1>Tasks</h1>
            <TaskColumn status="in-progress" title="In progress" tasks={tasks} total={tasks.length} taskActivity={taskActivity}
              onDragStart={vi.fn()} onDragEnd={vi.fn()} onDrop={vi.fn()} onUpdateTask={vi.fn()} onSubtaskTransition={vi.fn()} onDeleteTask={vi.fn()} />
          </main>
        </MemoryRouter>
      );
      // The check measured the five badges it claims to, not an empty tree.
      expect(container.querySelectorAll('.task-activity')).toHaveLength(5);
      expect(container.querySelectorAll('.task-activity time')).toHaveLength(3);
      expect(narrowWrapProblems(container, width)).toEqual([]);
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally {
      style.remove();
      vi.unstubAllGlobals();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: restoreWidth });
    }
  });

  test('the narrow-width check goes red on a badge that cannot wrap, and on a media condition it cannot model', () => {
    const style = document.createElement('style');
    style.textContent = `${cardStylesAt(320)}
.task-activity { flex-wrap: nowrap; min-width: 400px; }
.task-activity time { overflow-wrap: normal; white-space: nowrap; }`;
    document.head.appendChild(style);
    try {
      const { container } = render(<TaskActivityBadge activity={{ state: 'active', receivedAt: '2026-10-06T12:00:00Z' }} />);
      expect(narrowWrapProblems(container, 320)).toEqual([
        '.task-activity flex-wrap is nowrap',
        '.task-activity min-width is 400px',
        'time overflow-wrap is normal',
        'time white-space is nowrap',
      ]);
    } finally {
      style.remove();
    }
    expect(mediaMatches('(max-width: 767px)', 375)).toBe(true);
    expect(mediaMatches('(max-width: 1023px) and (min-width: 768px)', 375)).toBe(false);
    expect(() => mediaMatches('(orientation: portrait)', 375)).toThrow('unmodelled media condition');
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
    // E388: the redesign's disclosures and the E387(3) controls are audited
    // open and in place, not skipped as hidden.
    expect(screen.getByRole('separator', { name: 'Resize Timeline' }).getAttribute('aria-valuenow')).toBe('384');
    expect(within(timeline).getByRole('button', { name: 'Expand Timeline to full width' }).getAttribute('aria-pressed')).toBe('false');
    for (const disclosure of Array.from(container.querySelectorAll<HTMLDetailsElement>('details.task-timeline-runs, details.task-detail-advanced, details.task-detail-ownership-disclosure'))) disclosure.open = true;
    expect(container.querySelectorAll('details[open]').length).toBeGreaterThanOrEqual(3);
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
    expect(await screen.findByRole('heading', { level: 3, name: 'Scopes on this credential' })).toBeTruthy();
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

  // E462 slice S1: the harness connection surfaces, audited the way the other
  // day-one surfaces are, at desktop width and at 375 px. jsdom lays nothing
  // out, so the width is carried by what the stylesheet is bound to (the wrap
  // rule is pinned in BootstrapPane.test.tsx) and the audit here is of the
  // markup: the install section's labelled region, its two copy blocks and its
  // buttons, in context under a page heading.
  test.each([1280, 375])('the harness template, chosen in the wizard, is axe-clean at %ipx (E462 S1)', async (width) => {
    connectorsFixture = [];
    const restoreWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    try {
      const user = userEvent.setup();
      const { container } = render(
        <MemoryRouter>
          <main>
            <h1>Dashboard</h1>
            <ConnectAgentCard />
          </main>
        </MemoryRouter>
      );
      await user.click(await screen.findByRole('button', { name: /Connect your agent/ }));
      await user.click(await screen.findByRole('radio', { name: /Antigravity/ }));
      // The harness sentence replaces decision 1's, and the radio is checked.
      expect(await screen.findByText(/one token for the board's tools, reporting and wake/)).toBeTruthy();
      expect(screen.getByRole('radio', { name: /Antigravity/ }).getAttribute('aria-checked')).toBe('true');
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: restoreWidth });
    }
  });

  test.each([1280, 375])('the install section of a harness connection is axe-clean in context at %ipx (E462 S1)', async (width) => {
    const restoreWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    try {
      const { container } = render(
        <MemoryRouter>
          <main>
            <h1>Set up Workstation</h1>
            <BootstrapPane
              mcpConfig={bootstrapInstructions.mcpConfig}
              cliEnv={['export RELAYHALL_TOKEN=rh_dev_ab12cd34ef56.SECRETVALUE0000000000']}
              bootstrapLine={bootstrapInstructions.bootstrapLine}
              boardEndpoint={bootstrapInstructions.boardEndpoint}
              transport="any"
              initialTab="claudeCode"
              carriesSecret
              recovery="connect a replacement agent from My connections and disable this one"
              installLine="relayhall connector install --harness claude-code --board https://board.example"
            />
          </main>
        </MemoryRouter>
      );
      expect(screen.getByRole('region', { name: 'Install the connector' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Copy the install line' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Copy the token for the installer' })).toBeTruthy();
      expect(describeViolations(await auditOf(container))).toBe('');
      // E462 S2: the manual snippets fold under one disclosure; audited closed
      // (above) and open, reached by the summary's accessible name.
      await userEvent.click(screen.getByText('Set up by hand instead'));
      expect(screen.getByTestId('manual-setup').hasAttribute('open')).toBe(true);
      expect(screen.getByRole('button', { name: 'Copy the Claude Code setup block' })).toBeTruthy();
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: restoreWidth });
    }
  });

  test.each([1280, 375])('the harness delegation warning is axe-clean at %ipx (E462 S2)', async (width) => {
    connectorsFixture = [];
    const restoreWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    try {
      const user = userEvent.setup();
      const { container } = render(
        <MemoryRouter>
          <main>
            <h1>Dashboard</h1>
            <ConnectAgentCard />
          </main>
        </MemoryRouter>
      );
      await user.click(await screen.findByRole('button', { name: /Connect your agent/ }));
      await user.click(await screen.findByRole('radio', { name: /Codex/ }));
      expect(await screen.findByTestId('harness-delegation-warning')).toBeTruthy();
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: restoreWidth });
    }
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

  test('the shared-area writer panel is axe-clean with a listed writer and the remove form open (549cc51f)', async () => {
    // Card 549cc51f. Composed as the Access manager composes it, under the page
    // h1, with one listed writer so the list, the audit link, the add form and
    // the remove form are all in the audited tree. Every control is reached by
    // its accessible name; the reason fields carry their help as a description.
    sharedWritersFixture = {
      success: true,
      source: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'brain', name: 'Brain' },
      scope: 'organisation',
      youCanWrite: false,
      writers: [{
        accountId: 'p-grace', label: 'Grace Hopper', active: true,
        addedBy: { id: 'me', label: 'Ada' }, addedAt: '2026-10-16T09:00:00.000Z',
        reason: 'Maintains the organisation runbooks.', expiresAt: null, approvalId: null, origin: 'direct',
      }],
    };
    try {
      const user = userEvent.setup();
      const people = [
        { id: 'me', handle: 'ada', kind: 'human', status: 'active', role: 'admin', displayName: null, parentPrincipalId: null },
        { id: 'p-grace', handle: 'grace', kind: 'human', status: 'active', role: 'user', displayName: 'Grace Hopper', parentPrincipalId: null },
      ] as any[];
      const { container } = render(
        <MemoryRouter>
          <main>
            <h1>Access manager</h1>
            <SharedWritersPanel principals={people} requestStepUp={() => undefined} surface={() => undefined} auditTrailAvailable />
          </main>
        </MemoryRouter>,
      );
      expect(await screen.findByRole('heading', { level: 2, name: /Shared-area writers/ })).toBeTruthy();
      expect(await screen.findByText('Grace Hopper')).toBeTruthy();
      expect(screen.getByRole('form', { name: 'Add a shared-area writer' })).toBeTruthy();
      expect(screen.getByLabelText('Account')).toBeTruthy();
      expect(screen.getByLabelText('Why can this Account write the shared area?').getAttribute('aria-describedby'))
        .toBe('axm-shared-writers-reason-help');
      expect(screen.getByRole('link', { name: 'Audit trail of these changes' })).toBeTruthy();
      expect(describeViolations(await auditOf(container))).toBe('');

      await user.click(screen.getByRole('button', { name: 'Remove Grace Hopper' }));
      expect(screen.getByRole('form', { name: 'Remove Grace Hopper from the writer list' })).toBeTruthy();
      expect(screen.getByLabelText('Why remove Grace Hopper?').getAttribute('aria-describedby'))
        .toBe('axm-shared-writers-remove-reason-help');
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally {
      sharedWritersFixture = null;
    }
  });

  test('the warrant ceiling-rules field is axe-clean with rows, a paste refusal and a submit refusal (785e1eed P2-F)', async () => {
    // Composed as the warrant form composes it: inside a labelled form under
    // an h1, controlled by a parent that owns the rows. Audited in the states
    // the owner meets at the sitting - filled from the packet, a paste the
    // field refuses, a submit refusal - and disabled, which is how it reads
    // while a published profile is chosen.
    const user = userEvent.setup();
    const packet: CeilingRuleRow[] = [
      { key: 1, resourceType: 'task', selectorForm: 'all-in-project', selectorIds: '12345678-1234-4abc-8def-123456789abc', verbs: ['read', 'write'] },
      { key: 2, resourceType: 'report', selectorForm: 'all-of-type', selectorIds: '', verbs: ['read'] },
    ];
    const Harness = ({ disabled }: { disabled: boolean }) => {
      const [rows, setRows] = useState<CeilingRuleRow[]>(packet);
      return (
        <main>
          <h1>Access manager</h1>
          <form aria-label="Create a warrant">
            <CeilingRulesField
              idPrefix="axm-w-rules"
              rows={rows}
              onRowsChange={setRows}
              disabled={disabled}
              problems={['Rule 2: choose at least one verb.']}
            />
          </form>
        </main>
      );
    };
    const { container, rerender } = render(<Harness disabled={false} />);
    expect(screen.getByRole('group', { name: 'Rule 1' })).toBeTruthy();
    expect(screen.getAllByLabelText('Resource type')).toHaveLength(2);
    expect(describeViolations(await auditOf(container))).toBe('');

    await user.click(screen.getByRole('button', { name: 'Paste rules JSON' }));
    await user.click(screen.getByLabelText(/^Rules JSON/));
    await user.paste('{"not": "an array"}');
    await user.click(screen.getByRole('button', { name: 'Fill rows from JSON' }));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(describeViolations(await auditOf(container))).toBe('');

    rerender(<Harness disabled />);
    expect(describeViolations(await auditOf(container))).toBe('');
  });

  test('the Tasks board Phase filter — "Search phases", Project groups and the scope notice — is axe-clean and keyboard-ordered (096fda30)', async () => {
    // Card 096fda30 (owner E67). Composed as the board composes it: the real
    // FilterBar under a page h1, with Phases of two Projects and no Project
    // selected, so the list renders GROUPED — the structure this card adds —
    // and with the scope notice the board shows after clearing a Phase.
    const user = userEvent.setup();
    const projects = [
      { id: '11111111-1111-4111-8111-111111111111', name: 'RelayHall' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Storefront' },
    ];
    const phases = [
      { id: 'phase-rh-1', name: '01 · Authored knowledge', position: 10, projectId: projects[0].id },
      { id: 'phase-shop-1', name: 'Shop launch', position: 1, projectId: projects[1].id },
    ];
    const Harness = () => {
      const [filters, setFilters] = useState<TaskFilters>({
        searchQuery: '', priorities: [], tags: [], projects: [], phases: [], statuses: [],
      });
      return (
        <main>
          <h1>Tasks</h1>
          <FilterBar
            tasks={[]}
            filters={filters}
            onFiltersChange={setFilters}
            availableProjects={['RelayHall', 'Storefront']}
            availablePhases={phases}
            phaseProjects={projects}
            phaseScopeNotice='Phase filter "#10 01 · Authored knowledge" was cleared: it is not in the selected projects.'
            onDismissPhaseScopeNotice={() => undefined}
          />
        </main>
      );
    };
    const { container } = render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Phase' }));
    const search = screen.getByRole('textbox', { name: 'Search phases' });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(screen.getByRole('group', { name: 'RelayHall' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Storefront' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('was cleared');
    expect(describeViolations(await auditOf(container))).toBe('');

    // Typing narrows the list and reveals the clear control; focus then moves
    // box -> clear -> backlog -> the first matching Phase, as in the Project search.
    await user.type(search, 'launch');
    expect(screen.queryByRole('group', { name: 'RelayHall' })).toBeNull();
    expect(describeViolations(await auditOf(container))).toBe('');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Clear phase search' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Backlog (no phase)' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: '#1 Shop launch' }));
  });

  // Owner ruling E395: every list filter leads with a named "Selected" group,
  // carries an x beside its button while it has a selection, and a "Clear"
  // inside its dropdown; each clear control is named for its filter. Audited
  // with every dropdown open in turn, at desktop width and at 375 px with the
  // filter bar's own stylesheets resolved at that width.
  const e395Projects = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'RelayHall' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Storefront' },
  ];
  const e395Phases = [
    { id: 'phase-rh-1', name: '01 · Authored knowledge', position: 10, projectId: e395Projects[0].id },
    { id: 'phase-shop-1', name: 'Shop launch', position: 1, projectId: e395Projects[1].id },
  ];
  const E395Harness = () => {
    const [filters, setFilters] = useState<TaskFilters>({
      searchQuery: '', priorities: ['high'], tags: ['beta'], projects: ['Storefront'], phases: ['phase-shop-1'], statuses: ['review'],
    });
    return (
      <main>
        <h1>Tasks</h1>
        <FilterBar
          tasks={[]}
          filters={filters}
          onFiltersChange={setFilters}
          availableTags={['alpha', 'beta']}
          availableProjects={['RelayHall', 'Storefront']}
          availablePhases={e395Phases}
          phaseProjects={e395Projects}
        />
      </main>
    );
  };
  const E395_FILTERS = ['Priority', 'Status', 'Tags', 'Project', 'Phase'];

  test('board filters lead with a named Selected group and carry a named clear control each, axe-clean with every dropdown open (E395)', async () => {
    const user = userEvent.setup();
    const { container } = render(<E395Harness />);
    for (const name of E395_FILTERS) {
      expect(screen.getByRole('button', { name: `Clear ${name} filter` })).toBeTruthy();
    }
    expect(describeViolations(await auditOf(container))).toBe('');
    for (const name of E395_FILTERS) {
      await user.click(screen.getByRole('button', { name: new RegExp(`^${name}\\b`) }));
      const menu = container.querySelector<HTMLElement>('.filter-dropdown-menu')!;
      expect(within(menu).getByRole('group', { name: 'Selected' })).toBeTruthy();
      expect(within(menu).getByRole('button', { name: `Clear ${name} filter` })).toBeTruthy();
      expect(describeViolations(await auditOf(container)), `${name} open`).toBe('');
    }
    // After a clear: the x has gone and focus is on the filter button.
    await user.click(screen.getAllByRole('button', { name: 'Clear Phase filter' })[0]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Phase\b/ }));
    expect(describeViolations(await auditOf(container))).toBe('');
  });

  test('at 375 px the expanded filter bar keeps each clear control a touch target and stays axe-clean (E395)', async () => {
    const width = 375;
    const restoreWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: mediaMatches(query, width), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    const style = document.createElement('style');
    style.textContent = cardStylesAt(width, ['index.css', 'components/Button.css', 'components/ui/IconButton.css',
      'components/tasks/FilterBar.css']);
    document.head.appendChild(style);
    try {
      const user = userEvent.setup();
      const { container } = render(<E395Harness />);
      const filters = container.querySelector<HTMLElement>('.filter-bar-filters')!;
      // Collapsed behind the phone disclosure until asked for.
      expect(getComputedStyle(filters).display).toBe('none');
      await user.click(screen.getByRole('button', { name: /^Filters/ }));
      expect(getComputedStyle(filters).display).toBe('flex');
      for (const name of E395_FILTERS) {
        const x = screen.getByRole('button', { name: `Clear ${name} filter` });
        expect(getComputedStyle(x).minHeight, name).toBe('44px');
        expect(getComputedStyle(x).minWidth, name).toBe('44px');
      }
      expect(describeViolations(await auditOf(container))).toBe('');
      await user.click(screen.getByRole('button', { name: /^Project\b/ }));
      const menu = container.querySelector<HTMLElement>('.filter-dropdown-menu')!;
      expect(getComputedStyle(menu).position).toBe('fixed');
      expect(within(menu).getByRole('group', { name: 'Selected' })).toBeTruthy();
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally {
      style.remove();
      vi.unstubAllGlobals();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: restoreWidth });
    }
  });

  test('the notification centre\'s tablist with the Approvals tab open: the hub populated, an item\'s drawer open, then an item expanded (e2dd52b8)', async () => {
    // Card e2dd52b8 Part A (owner E84). The page under its own h1, the three
    // tabs as a tablist, and the Approvals panel rendering the real hub with
    // two grouped items: first with one item's drawer open by its deep link,
    // then with the drawer closed and a decidable item expanded. The network
    // answers below are this case's alone; every other read falls through to
    // this file's mock, which is restored afterwards.
    const id = '99999999-9999-4999-8999-999999999993';
    const hubItem = (itemId: string, handle: string, over: Record<string, unknown>) => ({
      id: itemId, kind: 'agent-mint', status: 'pending', requesterPrincipalId: connection.principalId, requesterHandle: handle,
      targetTaskId: task.id, targetTaskTitle: task.title, requestedScopes: ['tasks:read'], requestedRules: [],
      approvedScopes: null, lapseReason: null, denialReason: null,
      requestedAt: '2026-10-10T08:00:00.000Z', pendingExpiresAt: '2026-10-17T08:00:00.000Z', collectExpiresAt: null,
      refs: { task: { id: task.id, title: task.title }, phase: null, project: { id: 'pr-1', title: 'Relay project' } },
      deciders: { rule: 'Root, or the Account that owns the requesting connector, with step-up.', stepUp: true },
      decideVia: {},
      ...over,
    });
    const items = [
      hubItem(id, 'connector-laptop', {
        ownership: { class: 'group', groups: [{ id: 'g1', name: 'Alpha team' }], ownerHandle: null, ownerIsViewer: false },
        decidable: true,
      }),
      hubItem('99999999-9999-4999-8999-999999999994', 'connector-desktop', {
        ownership: { class: 'board', groups: [], ownerHandle: null, ownerIsViewer: false }, decidable: false,
      }),
    ];
    const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetchMock = vi.mocked(authenticatedFetch);
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/principals/me')) {
        return respond({ success: true, principal: { id: 'p-owner', handle: 'owner', kind: 'human', status: 'active', role: 'admin' }, scopes: ['root'] });
      }
      if (url.endsWith('/principals')) return respond({ success: true, principals: [] });
      if (url.endsWith(`/approvals/${id}`)) {
        return respond({ success: true, approval: items[0], events: [
          { id: 1, occurredAt: '2026-10-10T08:00:00.000Z', approvalId: id, action: 'approval.requested',
            actorPrincipalId: connection.principalId, actorHandle: 'connector-laptop', metadata: {} },
        ] });
      }
      if (url.includes('/approvals?')) return respond({ success: true, view: 'hub', approvals: items });
      return fallback(input, init);
    });
    try {
      const user = userEvent.setup();
      const { container } = render(
        <MemoryRouter initialEntries={[`/notifications?tab=approvals&approval=${id}`]}>
          <main><NotificationsPage /></main>
        </MemoryRouter>,
      );
      const panel = await screen.findByRole('tabpanel', { name: 'Approvals' });
      expect(within(screen.getByRole('tablist', { name: 'Action Center view' })).getAllByRole('tab')).toHaveLength(5);
      expect(await within(panel).findByText('connector-desktop')).toBeTruthy();
      expect(within(panel).getByRole('heading', { name: /Group: Alpha team/ })).toBeTruthy();
      const drawer = await screen.findByRole('dialog', { name: 'Approval history' });
      await waitFor(() => expect(drawer.textContent).toContain('Who did what'));
      expect(describeViolations(await auditOf(container))).toBe('');

      await user.click(screen.getByRole('button', { name: 'Close approval history' }));
      // The deep link expanded its item, and it stays expanded with the drawer
      // closed; the item someone else decides is expanded by hand.
      const mine = within(panel).getByText('connector-laptop').closest('li')!;
      expect(within(mine).getByRole('button', { name: 'Approve' })).toBeTruthy();
      const theirs = within(panel).getByText('connector-desktop').closest('li')!;
      await user.click(within(theirs).getByRole('button', { name: 'Review' }));
      expect(within(theirs).getByText('Waiting on someone else')).toBeTruthy();
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally {
      fetchMock.mockImplementation(fallback);
    }
  });

  test('a credential request in the approvals queue is axe-clean, expanded with its narrowing controls (785e1eed P1-B-2)', async () => {
    // Composed as the Access manager mounts it: under the page h1, the queue's
    // own h2, the item expanded by its deep link so the held credentials, the
    // scope checkboxes, the pin select, the date field and the fenced reason
    // are all in the audited tree.
    approvalsFixture = { approval: credentialRequest, decision: credentialDecision };
    const { container } = render(
      <MemoryRouter>
        <main>
          <h1>Access manager</h1>
          <ApprovalsQueue
            mount="access-manager"
            principalById={new Map()}
            deepLinkApprovalId={credentialRequest.id}
            requestStepUp={() => undefined}
            surface={() => undefined}
          />
        </main>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Laptop credential')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByLabelText(/Transport pin/)).toBeTruthy();
    expect(screen.getByLabelText(/Approve until/)).toBeTruthy();
    expect(describeViolations(await auditOf(container))).toBe('');
  });

  test('the Access grants form is axe-clean, and after a create keeps its values under a named status (21787b03)', async () => {
    // Card 21787b03. Audited in the two states the owner meets: the form over
    // a listed grant, with the copy saying what the form keeps, and the form
    // after a create, with the status naming what was created and Resource
    // type and the resource ID still holding what was entered.
    grantsFixture = {
      me: { id: '12121212-1212-4212-8212-121212121212', handle: 'owner', displayName: 'Owner', kind: 'human', status: 'active', role: 'admin' },
      principals: [grantsHolder],
      grants: [{
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', granteeType: 'principal', granteeId: grantsHolder.id,
        resourceType: 'phase', resourceId: null, verb: 'read', grantedByPrincipalId: null, expiresAt: null,
        createdAt: '2026-08-13T12:00:00.000Z', grantedBy: null,
        grantee: { id: grantsHolder.id, handle: 'tester', displayName: 'Focused Tester', kind: 'human', status: 'active', compatibility: false },
      }],
    };
    const user = userEvent.setup();
    const { container } = render(<main><GrantsPage /></main>);
    expect(await screen.findByText('Every resource of this type')).toBeTruthy();
    expect(screen.getByText(/The form keeps every field after a grant is created/)).toBeTruthy();
    expect(describeViolations(await auditOf(container))).toBe('');

    const target = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
    await user.selectOptions(screen.getByLabelText('Resource type'), 'service');
    await user.type(screen.getByLabelText(/Specific resource ID/), target);
    await user.click(screen.getByRole('button', { name: 'Create grant' }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain(`read · service · ${target} · no expiry, for Focused Tester (tester)`);
    expect((screen.getByLabelText('Resource type') as HTMLSelectElement).value).toBe('service');
    expect((screen.getByLabelText(/Specific resource ID/) as HTMLInputElement).value).toBe(target);
    expect(describeViolations(await auditOf(container))).toBe('');
  });

  // Card ff410dc4 (owner ruling E407 item 1): the Current grants list as the
  // owner meets it - the default hand-made view with the hidden-origin note,
  // a system-made, an unknown-origin and a Group row, every filter, the
  // Edit/Revoke pair and Load more - axe-clean at desktop width and at 375px,
  // where the pair must stay two equal controls side by side.
  test.each([1280, 375])('the Access grants list with origins, filters and the Edit and Revoke pair is axe-clean at %ipx (ff410dc4)', async (width) => {
    const restoreWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: mediaMatches(query, width), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    const style = document.createElement('style');
    style.textContent = cardStylesAt(width, ['index.css', 'pages/GrantsPage.css']);
    document.head.appendChild(style);
    const holder = { id: grantsHolder.id, handle: 'tester', displayName: 'Focused Tester', kind: 'human', status: 'active', compatibility: false };
    const connector = { id: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd', handle: 'pc-connector', displayName: null, kind: 'service', status: 'active', compatibility: false };
    const row = (id: string, extra: Record<string, unknown>) => ({
      id, granteeType: 'principal', granteeId: holder.id, resourceType: 'task', resourceId: '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a', verb: 'read',
      grantedByPrincipalId: null, expiresAt: null, createdAt: '2026-10-20T12:00:00.000Z', origin: 'manual', grantee: holder, grantedBy: null,
      target: { label: 'Quarterly review', status: 'todo', state: 'live' }, ...extra,
    });
    grantsFixture = {
      me: { id: '12121212-1212-4212-8212-121212121212', handle: 'owner', displayName: 'Owner', kind: 'human', status: 'active', role: 'admin' },
      principals: [grantsHolder],
      grants: [
        row('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1', { madeBy: { class: 'hand', via: 'direct', evidence: 'audit' }, grantedBy: holder }),
        row('b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2', { verb: 'write', madeBy: { class: 'system', via: 'task-creator', evidence: 'audit' }, grantedBy: connector,
          target: { label: 'An archived Task with a long title that has to wrap at a narrow width', status: 'archived', state: 'archived' } }),
        row('b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3', { resourceType: 'report', resourceId: null, madeBy: { class: 'unknown', via: null, evidence: 'none' }, target: { label: null, status: null, state: 'wildcard' } }),
        row('b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4', { granteeType: 'group', granteeId: '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e', grantee: null,
          granteeGroup: { id: '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e', name: 'Operators' }, resourceType: 'project',
          madeBy: { class: 'system', via: 'project-default', evidence: 'column' } }),
      ],
      pagination: { limit: 50, sort: '-created', returned: 4, total: 120, hasMore: true, nextCursor: 'gc1.next' },
      madeCounts: { hand: 1, system: 3900, unknown: 7 },
    };
    try {
      const { container } = render(<main style={{ width: `${width}px` }}><GrantsPage /></main>);
      const table = await screen.findByRole('table', { name: 'Current access grants' });
      expect(within(table).getByText('Hand-made')).toBeTruthy();
      expect(within(table).getAllByText('System-made')).toHaveLength(2);
      expect(within(table).getByText('Unknown origin')).toBeTruthy();
      expect(within(table).getByText('Group Operators')).toBeTruthy();
      expect(screen.getByText(/Hidden by the Origin filter: 3900 system-made, 7 of unknown origin/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Load more grants' })).toBeTruthy();
      const pairs = Array.from(container.querySelectorAll<HTMLElement>('.grants-actions'));
      expect(pairs).toHaveLength(4);
      for (const pair of pairs) {
        expect(pair.getAttribute('role')).toBe('group');
        const tracks = getComputedStyle(pair);
        expect([tracks.display, tracks.gridTemplateColumns]).toEqual(['grid', 'repeat(2, minmax(0, 1fr))']);
        const [edit, revoke] = Array.from(pair.querySelectorAll<HTMLElement>('button'));
        expect([edit.textContent, revoke.textContent]).toEqual(['Edit', 'Revoke']);
        // The pair is EQUAL: the box each control draws is the same.
        const box = (el: HTMLElement) => {
          const c = getComputedStyle(el);
          return [c.width, c.minHeight, c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft, c.borderTopWidth, c.fontSize, c.fontWeight, c.display];
        };
        expect(box(revoke)).toEqual(box(edit));
        expect(box(edit)[0]).toBe('100%');
      }
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally {
      style.remove();
      vi.unstubAllGlobals();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: restoreWidth });
    }
  });

  // Owner ruling E413: the clean-up of redundant grants beside the paging, as
  // the owner meets it after a dry run (counts by verdict, a sample of each
  // kind, the first batch offered) and with the batch's step-up open,
  // axe-clean at desktop width and at 375px.
  test.each([1280, 375])('the redundant-grant clean-up dry run and its step-up are axe-clean at %ipx (E413)', async (width) => {
    const restoreWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: mediaMatches(query, width), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    const style = document.createElement('style');
    style.textContent = cardStylesAt(width, ['index.css', 'pages/GrantsPage.css']);
    document.head.appendChild(style);
    const holder = { id: grantsHolder.id, handle: 'tester', displayName: 'Focused Tester', kind: 'human', status: 'active', compatibility: false };
    const ids = ['c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2', 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3'];
    grantsFixture = {
      me: { id: '12121212-1212-4212-8212-121212121212', handle: 'owner', displayName: 'Owner', kind: 'human', status: 'active', role: 'admin' },
      principals: [grantsHolder],
      grants: ids.map((id) => ({
        id, granteeType: 'principal', granteeId: holder.id, resourceType: 'task', resourceId: '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a', verb: 'read',
        grantedByPrincipalId: null, expiresAt: null, createdAt: '2026-10-20T12:00:00.000Z', origin: 'manual', grantee: holder, grantedBy: null,
        madeBy: { class: 'system', via: 'task-creator', evidence: 'audit' }, target: { label: 'Quarterly review', status: 'todo', state: 'live' },
      })),
      pagination: { limit: 200, sort: '-created', returned: 3, total: 3, hasMore: false, nextCursor: null },
      bulkRevoke: {
        success: true, dryRun: true, removed: 0, rolledBack: false, wouldRollBack: false, redundantIdSetHash: 'grant-ids-v1:smoke',
        results: [
          { id: ids[0], verdict: 'redundant', reason: 'the engine answers all 10 questions the same without it', grant: { granteeId: holder.id, resourceType: 'task', resourceId: '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a', verb: 'read' } },
          { id: ids[1], verdict: 'effective', reason: 'removing it changes 1 of 10 answers (first: self read on task)' },
          { id: ids[2], verdict: 'assignment', reason: "carries an assignment's access (GRANT_CARRIES_ASSIGNMENT): unassign the Task or revoke the Warrant" },
        ],
      },
    };
    try {
      const user = userEvent.setup();
      const { container } = render(<main style={{ width: `${width}px` }}><GrantsPage /></main>);
      await screen.findByRole('table', { name: 'Current access grants' });
      await user.click(screen.getByRole('button', { name: 'Clean up redundant grants' }));
      await user.click(screen.getByRole('button', { name: 'Check this view (dry run)' }));
      expect(await screen.findByRole('heading', { name: 'Dry run: 3 grants checked' })).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Sample of grants to revoke' })).toBeTruthy();
      expect(describeViolations(await auditOf(container))).toBe('');
      await user.click(screen.getByRole('button', { name: 'Revoke batch 1 of 1 (1 grant)' }));
      expect(await screen.findByRole('dialog')).toBeTruthy();
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally {
      style.remove();
      vi.unstubAllGlobals();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: restoreWidth });
    }
  });

  test('an identity opened from the Identities list is axe-clean, with every fact read and the role action chosen (caea70ef)', async () => {
    // Card caea70ef. The detail page as an administrator meets it: the
    // directory facts, a Connector with a credential and its scopes, a grant,
    // the audit rows, and the role action with a role chosen and explained.
    const owner = { id: '12121212-1212-4212-8212-121212121212', handle: 'owner', displayName: 'Owner', kind: 'human', status: 'active', role: 'admin' };
    const connector = {
      id: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd', handle: 'tester-laptop', displayName: null, kind: 'service',
      status: 'active', role: null, parentPrincipalId: grantsHolder.id,
    };
    grantsFixture = {
      me: owner,
      principals: [owner, grantsHolder, connector],
      grants: [{
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', granteeType: 'principal', granteeId: grantsHolder.id,
        resourceType: 'phase', resourceId: null, verb: 'read', grantedByPrincipalId: null, expiresAt: null,
        createdAt: '2026-08-13T12:00:00.000Z', origin: 'manual',
      }],
      credentials: [{
        id: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', keyId: 'k1smoke', label: 'laptop', scopes: ['tasks:read', 'tasks:write'],
        createdAt: '2026-08-13T12:00:00.000Z', expiresAt: null, revokedAt: null, lastUsedAt: null, graceUntil: null, transport: 'mcp',
      }],
    };
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter initialEntries={[`/settings/principals?identity=${grantsHolder.id}`]}>
        <main>
          <Routes><Route path="/settings/principals" element={<PrincipalsPage />} /></Routes>
        </main>
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'tester' })).toBeTruthy();
    expect((await screen.findAllByText('k1smoke')).length).toBeGreaterThan(0);
    expect(await screen.findByText('read on every phase')).toBeTruthy();
    await user.selectOptions(await screen.findByLabelText(/New role/), 'editor');
    expect(describeViolations(await auditOf(container))).toBe('');
  });

  // Card 0ac41d40. The Agent sessions page with its new controls in use: the
  // "Show N short sessions" toggle PRESSED (a toggle button names its state
  // through aria-pressed and its rule through aria-describedby), a Reporter
  // and a Product chosen in the labelled selects, and "Load more" shown.
  test('the Agent sessions page is axe-clean with the short-session toggle pressed, a filter set and Load more shown (0ac41d40)', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/sessions']}>
          <main><SessionsPage /></main>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const toggle = await screen.findByRole('button', { name: 'Show 2 short sessions' });
    expect(describeViolations(await auditOf(container))).toBe('');

    await user.click(toggle);
    expect((await screen.findByRole('button', { name: 'Show 2 short sessions', pressed: true }))
      .getAttribute('aria-describedby')).toBe('telemetry-short-definition');
    await user.selectOptions(screen.getByLabelText('Reporter'), sessionsSourceFixture.connectorId);
    await user.selectOptions(screen.getByLabelText('Product'), 'claude-code');
    expect((screen.getByLabelText('Reporter') as HTMLSelectElement).value).toBe(sessionsSourceFixture.connectorId);
    expect(await screen.findByRole('button', { name: /Load more sessions/ })).toBeTruthy();
    expect(describeViolations(await auditOf(container))).toBe('');
  });


  // Card 1fd5de08, line 1 (E428): the Knowledge search console as a reader meets it -
  // a narrowed source selection with its compartments, a partial answer with
  // an unavailable source, two results with their source and score, one
  // explain view open, and the shared side-panel reader open on a cited
  // revision - axe-clean at desktop width and at 375 px.
  test.each([1280, 375])('the Knowledge search console with results, an explain view and the reader open is axe-clean at %ipx (F14)', async (width) => {
    const restoreWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: mediaMatches(query, width), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    const style = document.createElement('style');
    style.textContent = cardStylesAt(width, ['index.css', 'pages/KnowledgePage.css', 'components/knowledge/KnowledgeReader.css']);
    document.head.appendChild(style);
    const notes = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const files = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
    knowledgeFixture = {
      sources: [
        { id: notes, name: 'Team notes', slug: 'team-notes', claimsMode: 'asserted', protocol_version: 2, compartment_mode: 'dynamic-opaque', categories: ['relaybrain:note'] },
        { id: files, name: 'Design files', slug: 'design-files', claimsMode: 'asserted', compartments: ['design'] },
      ],
      answer: {
        coverage: {
          consulted: [notes, files], answered: [notes], timedOut: [], unavailable: [{ id: files, reason: 'transport' }],
          refusedBySource: [], refusedByPolicy: [], skipped: [], truncatedResults: [], invalidResults: [],
          searchedCategories: [{ id: notes, categories: ['relaybrain:note'] }, { id: files, categories: 'all' }],
          archive: { included: false, declaredBy: [] },
        },
        groups: [{ sourceId: notes, sourceSlug: 'team-notes', results: [
          { handle: 'kh.one', title: 'Release gate decision', snippet: 'The release gate is fast CI plus a rehearsal.', contentKind: 'docs',
            category: 'relaybrain:note', compartment: { id: 'c-1', label: 'Shared' }, score: 0.82, updatedAt: '2026-10-20T08:00:00.000Z' },
          { handle: 'kh.two', title: 'A second note with a much longer title that has to wrap at a narrow width', snippet: 'Unrelated words.',
            contentKind: 'docs', category: 'relaybrain:note', compartment: { id: 'c-1', label: 'Shared' }, score: 0.4, parentHandle: 'kh.parent' },
        ] }],
        auditRef: 'ka_' + 'b'.repeat(32),
      },
      content: {
        protocol_version: 2, status: 'content', content_base64: btoa('# Release gate. Fast CI plus a rehearsal.'),
        sha256: 'c'.repeat(64), offset: 0, byteLength: 40, totalBytes: 40, truncated: false,
        provenance: { sourceId: notes, compartment: { id: 'c-1', label: 'Shared' }, contentKind: 'docs', category: 'relaybrain:note' },
        retrieval: { status: 'complete', reasons: [] }, auditRef: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
    };
    const user = userEvent.setup();
    try {
      const { container } = render(<MemoryRouter initialEntries={['/knowledge']}><KnowledgePage /></MemoryRouter>);
      await screen.findByText(/This query will be sent/);
      await user.click(screen.getAllByLabelText('All authorized')[0]);
      expect(screen.getByText('Compartments: design')).toBeTruthy();
      await user.click(screen.getByLabelText('Team notes'));
      await user.click(screen.getByLabelText('Design files'));
      await user.type(screen.getByLabelText('Search knowledge'), 'release gate');
      await user.click(screen.getByRole('button', { name: 'Search' }));
      const coverage = await screen.findByLabelText('Search coverage');
      expect(coverage.textContent).toContain('Design files: unavailable (transport');
      expect(screen.getAllByText('Score: 0.82')).toHaveLength(1);
      await user.click(screen.getByRole('button', { name: 'Why this matched: Release gate decision' }));
      expect(screen.getByText(/Found in the title or snippet/)).toBeTruthy();
      expect(describeViolations(await auditOf(container))).toBe('');
      await user.click(screen.getByRole('button', { name: 'Release gate decision' }));
      const reader = await screen.findByRole('dialog', { name: 'Release gate decision' });
      await within(reader).findByText(/Fast CI plus a rehearsal/);
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally {
      style.remove();
      vi.unstubAllGlobals();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: restoreWidth });
    }
  });
  // Card 1fd5de08, line 2 (E428, E124): the Knowledge status panel after one
  // partial search - the totals, a source that answered with one dated and one
  // undated result, a source that was unavailable, and the "Not shown here"
  // list of figures the core never receives - axe-clean at desktop width and
  // at 375 px.
  test.each([1280, 375])('the Knowledge status panel after a partial search is axe-clean at %ipx (F14 line 2)', async (width) => {
    const restoreWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: mediaMatches(query, width), media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    const style = document.createElement('style');
    style.textContent = cardStylesAt(width, ['index.css', 'pages/KnowledgePage.css', 'components/knowledge/KnowledgeStatus.css']);
    document.head.appendChild(style);
    const notes = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const files = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
    knowledgeFixture = {
      sources: [
        { id: notes, name: 'Team notes with a long name that has to wrap at a narrow width', slug: 'team-notes', claimsMode: 'asserted', protocol_version: 2, compartment_mode: 'dynamic-opaque', categories: ['relaybrain:note'] },
        { id: files, name: 'Design files', slug: 'design-files', claimsMode: 'asserted', compartments: ['design'] },
      ],
      answer: {
        coverage: {
          consulted: [notes, files], answered: [notes], timedOut: [], unavailable: [{ id: files, reason: 'transport' }],
          refusedBySource: [], refusedByPolicy: [], skipped: [], truncatedResults: [], invalidResults: [],
          searchedCategories: [{ id: notes, categories: 'all' }, { id: files, categories: 'all' }],
          archive: { included: false, declaredBy: [] },
        },
        groups: [{ sourceId: notes, sourceSlug: 'team-notes', results: [
          { handle: 'kh.one', title: 'Release gate decision', snippet: 'Fast CI plus a rehearsal.', contentKind: 'docs',
            compartment: { id: 'c-1', label: 'Shared' }, score: 0.82, updatedAt: '2026-10-20T08:00:00.000Z' },
          { handle: 'kh.two', title: 'Undated note', snippet: 'No update time.', contentKind: 'docs', compartment: 'c-2', score: 0.4 },
        ] }],
        auditRef: 'ka_' + 'b'.repeat(32),
      },
      content: {},
    };
    try {
      const { container } = render(<MemoryRouter initialEntries={['/knowledge']}><KnowledgePage /></MemoryRouter>);
      await screen.findByText(/This query will be sent/);
      fireEvent.change(screen.getByLabelText('Search knowledge'), { target: { value: 'release gate' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      await screen.findByLabelText('Search coverage');
      const panel = screen.getByRole('region', { name: 'Source status' });
      expect(within(panel).getByText('Unavailable (transport).')).toBeTruthy();
      expect(within(panel).getByText('Not shown here')).toBeTruthy();
      expect(describeViolations(await auditOf(container))).toBe('');
    } finally {
      style.remove();
      vi.unstubAllGlobals();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: restoreWidth });
    }
  });
});
