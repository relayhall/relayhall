// @vitest-environment jsdom
/**
 * Card ab8f78e9 (owner ruling E91) — the per-session MCP ACTION LOG in the
 * expanded timeline of an `mcp` session on the Agent sessions page.
 *
 * WHAT IT MEASURES
 *
 *   1. An `mcp` session's opened timeline lists its tool calls — tool, the
 *      target it named, the outcome in words (the closed error code's label),
 *      the duration and a `<time>` — under "MCP tool calls".
 *   2. The page says plainly that REST and CLI calls are not shown and that
 *      arguments are never recorded, and it has an honest empty state.
 *   3. A session of any other product has no action-log section at all, and
 *      a detail from a server without the field renders the empty state
 *      rather than failing.
 *   4. The log is read from the session's own point read: no other route is
 *      asked for it.
 *   5. axe-core over the real tree, with the log open, finds nothing.
 */
import axe from 'axe-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { authenticatedFetch } from '../utils/auth';
import { MCP_ACTION_ERROR_LABELS, describeActionOutcome } from '../utils/telemetryProjection';
import { SessionsPage } from './SessionsPage';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
const mockFetch = vi.mocked(authenticatedFetch);

const MCP_REF = 'rhp_abcdefghijklmnopqrstuvwxy0';
const CC_REF = 'rhp_0123456789abcdefghijklmno';
const TASK = '55555555-5555-4555-8555-555555555555';

const SOURCE = {
  connectorId: 'conn-1', connectorHandle: 'workstation', connectorDisplayName: 'Workstation Claude', accountId: 'acct-1',
  sourceProduct: 'mcp', adapter: 'relayhall-mcp', adapterVersion: null, mechanism: 'push', supportLevel: 'tested',
  lastVerified: null, policyTier: 0, schemaVersion: 'rh.ai.telemetry/1.0',
  lastSeenAt: '2026-09-05T10:00:00.000Z', firstSeenAt: '2026-09-05T09:00:00.000Z',
  lastPhase: 'running', eventCount: 6, sessionCount: 2, errorCount: 0,
  state: 'active' as const, basis: 'envelope' as const, connectorFrame: null,
};

const BASE_SESSION = {
  connectorId: 'conn-1', connectorHandle: 'workstation', connectorDisplayName: 'Workstation Claude',
  state: 'active' as const, startedAt: '2026-09-05T09:00:00.000Z', lastSeenAt: '2026-09-05T10:00:00.000Z',
  lastPhase: 'running', eventCount: 6, errorCount: 0, models: [],
  inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0,
};
const MCP_SESSION = { ...BASE_SESSION, sessionRef: MCP_REF, sourceProduct: 'mcp' };
const CC_SESSION = { ...BASE_SESSION, sessionRef: CC_REF, sourceProduct: 'claude-code' };

const EVENT = {
  eventId: 'e1', observedAt: '2026-09-05T10:00:00.000Z', occurredAt: null, kind: 'session', phase: 'running',
  modelProvider: null, modelResolved: null, operation: null, outcomeStatus: null, errorType: null,
  durationMs: null, inputTokens: null, outputTokens: null, contextUtilization: null,
};

const ACTIONS = [
  { observedAt: '2026-09-05T10:00:05.000Z', toolName: 'relayhall_task_get', targetType: 'task', targetId: TASK,
    outcome: 'error', errorCode: 'not_found', durationMs: 14 },
  { observedAt: '2026-09-05T10:00:01.000Z', toolName: 'relayhall_principal_whoami', targetType: null, targetId: null,
    outcome: 'ok', errorCode: null, durationMs: 3 },
];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function wire(detailFor: (ref: string) => Record<string, unknown>) {
  mockFetch.mockImplementation(async (url: string) => {
    const path = String(url);
    if (path.includes('/telemetry/presence')) return jsonResponse({ success: true, sources: [SOURCE] });
    for (const ref of [MCP_REF, CC_REF]) {
      if (path.includes(`/telemetry/sessions/${ref}`)) return jsonResponse({ success: true, ...detailFor(ref) });
    }
    if (path.includes('/telemetry/sessions')) {
      return jsonResponse({
        success: true, sessions: [MCP_SESSION, CC_SESSION], hiddenCount: 0, shortCount: 0, total: 2,
        offset: 0, nextOffset: null, shortSession: { maxEvents: 3, minDurationMs: 120_000 },
      });
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sessions']}><SessionsPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

async function open(ref: string): Promise<void> {
  await screen.findByRole('heading', { name: 'Sessions' });
  const button = screen.getAllByRole('button', { expanded: false })
    .find((candidate) => candidate.textContent?.startsWith(ref.slice(0, 14)));
  expect(button).toBeDefined();
  await userEvent.click(button!);
}

async function axeViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  return results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`);
}

beforeEach(() => { mockFetch.mockReset(); });
afterEach(() => { cleanup(); });

describe('SessionsPage — the MCP action log (ab8f78e9)', () => {
  test('an mcp session lists its tool calls: tool, target, outcome in words, duration and time', async () => {
    wire((ref) => ({ session: ref === MCP_REF ? MCP_SESSION : CC_SESSION, events: [EVENT], truncated: false,
      actions: ref === MCP_REF ? ACTIONS : [], actionsTruncated: false }));
    renderPage();
    await open(MCP_REF);
    const section = await screen.findByRole('region', { name: /MCP tool calls in session/ });
    expect(within(section).getByRole('heading', { name: 'MCP tool calls' })).toBeInTheDocument();
    const rows = within(section).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('relayhall_task_get')).toBeInTheDocument();
    expect(within(rows[0]).getByText(TASK)).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('task');
    expect(within(rows[0]).getByText('Error: Not found')).toBeInTheDocument();
    expect(within(rows[0]).getByText('14 ms')).toBeInTheDocument();
    expect(rows[0].querySelector('time')?.getAttribute('dateTime')).toBe(ACTIONS[0].observedAt);
    expect(within(rows[1]).getByText('relayhall_principal_whoami')).toBeInTheDocument();
    expect(within(rows[1]).getByText('OK')).toBeInTheDocument();
    // No target named: a dash, never an invented one.
    expect(within(rows[1]).getAllByRole('cell')[2]).toHaveTextContent(/^—$/);
    expect(within(section).getByText(/calls made over the REST API or the CLI are not shown here/)).toBeInTheDocument();
    expect(within(section).getByText(/Tool arguments are never recorded/)).toBeInTheDocument();
  });

  test('an empty log says so honestly, and a detail without the field is read as empty', async () => {
    wire((ref) => ({ session: ref === MCP_REF ? MCP_SESSION : CC_SESSION, events: [EVENT], truncated: false }));
    renderPage();
    await open(MCP_REF);
    const section = await screen.findByRole('region', { name: /MCP tool calls in session/ });
    expect(within(section).getByText(/No MCP tool calls are recorded for this session/)).toBeInTheDocument();
    expect(within(section).queryByRole('table')).not.toBeInTheDocument();
    expect(within(section).getByText(/REST API or the CLI are not shown here/)).toBeInTheDocument();
  });

  test('a session of another product has no action-log section', async () => {
    wire((ref) => ({ session: ref === MCP_REF ? MCP_SESSION : CC_SESSION, events: [EVENT], truncated: false,
      actions: [], actionsTruncated: false }));
    renderPage();
    await open(CC_REF);
    expect(await screen.findByText('session')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /MCP tool calls/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/REST API or the CLI/)).not.toBeInTheDocument();
  });

  test('a cut log says so, and the log comes from the session point read alone', async () => {
    wire((ref) => ({ session: ref === MCP_REF ? MCP_SESSION : CC_SESSION, events: [EVENT], truncated: false,
      actions: ACTIONS, actionsTruncated: true }));
    renderPage();
    await open(MCP_REF);
    await screen.findByRole('region', { name: /MCP tool calls in session/ });
    expect(screen.getByText(/Showing the most recent tool calls only/)).toBeInTheDocument();
    const urls = mockFetch.mock.calls.map((args) => String(args[0]));
    expect(urls.filter((url) => url.includes(`/telemetry/sessions/${MCP_REF}`)).length).toBeGreaterThan(0);
    expect(urls.every((url) => /\/telemetry\/(presence|sessions)/.test(url))).toBe(true);
  });

  test('every closed error code has words, and an unknown code is shown as itself', () => {
    for (const code of ['tool_refused', 'bad_request', 'unauthenticated', 'forbidden', 'not_found', 'conflict',
      'rate_limited', 'rejected', 'unavailable', 'server_error', 'internal']) {
      expect(MCP_ACTION_ERROR_LABELS[code]).toEqual(expect.any(String));
      expect(describeActionOutcome({ outcome: 'error', errorCode: code })).toBe(`Error: ${MCP_ACTION_ERROR_LABELS[code]}`);
    }
    expect(describeActionOutcome({ outcome: 'ok', errorCode: null })).toBe('OK');
    expect(describeActionOutcome({ outcome: 'error', errorCode: 'new_code' })).toBe('Error: new_code');
  });

  test('axe finds nothing with the action log open', async () => {
    wire((ref) => ({ session: ref === MCP_REF ? MCP_SESSION : CC_SESSION, events: [EVENT], truncated: false,
      actions: ACTIONS, actionsTruncated: false }));
    const { container } = renderPage();
    await open(MCP_REF);
    await screen.findByRole('region', { name: /MCP tool calls in session/ });
    expect(await axeViolations(container)).toEqual([]);
  });
});
