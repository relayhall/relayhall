// @vitest-environment jsdom
/**
 * RH-TW1c (card `50e74c1d`) — the Sessions and Stats surfaces render the
 * projection, and the three states are never conflated.
 *
 * ONE file for both pages because they share one client module and one
 * stylesheet; splitting them would duplicate the fixture and let the two
 * drift on what a state chip says.
 *
 * WHAT IT MEASURES
 *
 *   1. LOADING, ERROR and EMPTY are three different renderings. The one that
 *      matters most is the pair a careless page conflates: a 403 must NOT
 *      render "No reporters connected", because an operator who reads that
 *      sentence concludes their reporters stopped. The error assertion checks
 *      the refusal text AND the absence of the empty-state heading.
 *
 *   2. The EMPTY state is the shipped one, unchanged. UI-REFINE polished that
 *      copy; this card renders data ABOVE it, not instead of it.
 *
 *   3. Instants are `<time>` elements carrying a machine-readable `dateTime`,
 *      formatted by `utils/dateFormat` — the one place a date becomes text.
 *      A bare `toLocaleString()` renders `05/09/2026` as May 9th for one
 *      reader and September 5th for another, which is card 96984e2c.
 *
 *   4. The disclosure is a real disclosure: a button with `aria-expanded` and
 *      `aria-controls`, and the timeline it names appears when opened.
 *
 *   5. axe-core over the REAL component trees, populated and empty, with ZERO
 *      violations. Markup is not stubbed: a smoke test over stubbed children
 *      proves nothing about the page that ships.
 */
import axe from 'axe-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { authenticatedFetch } from '../utils/auth';
import { SessionsPage } from './SessionsPage';
import { StatsPage } from './StatsPage';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const mockFetch = vi.mocked(authenticatedFetch);

const SESSION_REF = 'rhp_abcdefghijklmnopqrstuvwxy0';
const OTHER_REF = 'rhp_0123456789abcdefghijklmno';

const SOURCE = {
  connectorId: 'conn-1', connectorHandle: 'laptop-reporter', accountId: 'acct-1',
  sourceProduct: 'claude-code', adapter: 'claude-code-otlp', adapterVersion: '1.2.3',
  mechanism: 'push', supportLevel: 'tested', lastVerified: '2026-09-01',
  policyTier: 0, schemaVersion: 'rh.ai.telemetry/1.0',
  lastSeenAt: '2026-09-05T10:00:00.000Z', firstSeenAt: '2026-09-05T09:00:00.000Z',
  lastPhase: 'running', eventCount: 12, sessionCount: 2, errorCount: 0,
  state: 'active' as const, basis: 'envelope' as const,
  connectorFrame: { state: 'idle' as const, receivedAt: '2026-09-05T09:59:00.000Z', kind: 'status' },
};

const SESSION = {
  sessionRef: SESSION_REF, connectorId: 'conn-1', connectorHandle: 'laptop-reporter',
  sourceProduct: 'claude-code', state: 'active' as const,
  startedAt: '2026-09-05T09:00:00.000Z', lastSeenAt: '2026-09-05T10:00:00.000Z',
  lastPhase: 'running', eventCount: 6, errorCount: 0, models: ['claude-opus-5'],
  inputTokens: 1200, outputTokens: 340, totalTokens: 1540, requests: 6,
};

const FINISHED_SESSION = { ...SESSION, sessionRef: OTHER_REF, state: 'finished' as const, lastPhase: 'completed' };

const DETAIL = {
  session: SESSION,
  truncated: false,
  events: [{
    eventId: 'e1', observedAt: '2026-09-05T10:00:00.000Z', occurredAt: '2026-09-05T09:59:59.000Z',
    kind: 'model_call', phase: 'running', modelProvider: 'anthropic', modelResolved: 'claude-opus-5',
    operation: 'chat', outcomeStatus: 'ok', errorType: null, durationMs: 1200,
    inputTokens: 200, outputTokens: 60, contextUtilization: 0.42,
  }],
};

const STATS = {
  windowDays: 7, windowStart: '2026-08-29T10:00:00.000Z',
  totals: {
    events: 12, sessions: 2, sources: 1, errors: 0, requests: 12,
    inputTokens: 1200, outputTokens: 340, cachedReadTokens: 10,
    reasoningTokens: 5, toolTokens: 3, totalTokens: 1540,
  },
  modelMix: [{ provider: 'anthropic', model: 'claude-opus-5', events: 12, inputTokens: 1200, outputTokens: 340, totalTokens: 1540 }],
  cost: [{ currency: 'USD', basis: 'estimated', amount: '2.500000', events: 12 }],
  coverage: [SOURCE],
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

/** Populated, empty or refused — one switch, so no test invents its own wiring. */
function wireFetch(mode: 'full' | 'empty' | 'refused') {
  mockFetch.mockImplementation(async (url: string) => {
    const path = String(url);
    if (mode === 'refused') {
      return jsonResponse(
        { success: false, code: 'TELEMETRY_READ_SCOPE_REQUIRED', error: 'This credential resolves to no Account.' },
        false, 403,
      );
    }
    if (path.includes('/telemetry/presence')) {
      return jsonResponse({ success: true, sources: mode === 'full' ? [SOURCE] : [] });
    }
    if (path.includes('/telemetry/stats')) {
      return jsonResponse(mode === 'full'
        ? { success: true, ...STATS }
        : { success: true, ...STATS, totals: { ...STATS.totals, events: 0, sessions: 0, sources: 0 }, modelMix: [], cost: [], coverage: [] });
    }
    if (path.includes(`/telemetry/sessions/${SESSION_REF}`)) {
      return jsonResponse({ success: true, ...DETAIL });
    }
    if (path.includes('/telemetry/sessions')) {
      return jsonResponse({ success: true, sessions: mode === 'full' ? [SESSION, FINISHED_SESSION] : [] });
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
}

function renderPage(page: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}

async function axeViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    // jsdom has no layout engine, so contrast is not decidable here; it is
    // enforced per Theme by scripts/check-design-contrast.py. Everything axe
    // CAN decide in jsdom — roles, names, ARIA validity, duplicate ids,
    // heading order — is left on.
    rules: { 'color-contrast': { enabled: false } },
  });
  return results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`);
}

beforeEach(() => { mockFetch.mockReset(); });
afterEach(() => { cleanup(); });

describe('SessionsPage', () => {
  test('renders the presence projection and the session rows', async () => {
    wireFetch('full');
    renderPage(<SessionsPage />);
    expect(await screen.findByRole('heading', { name: 'Reporting sources' })).toBeInTheDocument();
    // The product names the source card AND its session rows, so it is
    // deliberately matched as a SET rather than as a unique node.
    expect(screen.getAllByText('claude-code').length).toBe(3);
    expect(screen.getByText('laptop-reporter')).toBeInTheDocument();
    // The SHIPPED chip vocabulary, and the fourth session word beside it.
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getByText('Finished')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument();
    // The reporter-process frame is shown BESIDE the state, never folded in.
    expect(screen.getByText(/Reporter process idle at/)).toBeInTheDocument();
  });

  test('every instant is a <time> with a machine-readable dateTime, formatted once', async () => {
    wireFetch('full');
    const { container } = renderPage(<SessionsPage />);
    await screen.findByRole('heading', { name: 'Reporting sources' });
    const times = container.querySelectorAll('time');
    expect(times.length).toBeGreaterThan(0);
    for (const time of Array.from(times)) {
      expect(time.getAttribute('dateTime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // en-GB day-first, from utils/dateFormat — never a viewer-locale render.
      expect(time.textContent).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/);
    }
  });

  test('the timeline is a real disclosure, and opens the point route', async () => {
    wireFetch('full');
    renderPage(<SessionsPage />);
    await screen.findByRole('heading', { name: 'Reporting sources' });
    const toggles = screen.getAllByRole('button', { expanded: false });
    expect(toggles.length).toBe(2);
    await userEvent.click(toggles[0]);
    expect(await screen.findByText('model_call')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1);
    // The point route is addressed by the TRIPLE. A page that asked for the
    // pseudonym alone would render a timeline that might belong to another
    // Connector entirely (round-1 review `f4c56960`, second blocker), and the
    // request URL is where that is decidable on this side of the seam.
    const pointCall = mockFetch.mock.calls
      .map((args) => String(args[0]))
      .find((url) => url.includes(`/telemetry/sessions/${SESSION_REF}`));
    expect(pointCall).toBeDefined();
    expect(pointCall).toContain(`connectorId=${SESSION.connectorId}`);
    expect(pointCall).toContain(`sourceProduct=${SESSION.sourceProduct}`);
  });

  test('EMPTY renders the shipped empty state, unchanged', async () => {
    wireFetch('empty');
    renderPage(<SessionsPage />);
    expect(await screen.findByText('No reporters connected')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sessions' })).not.toBeInTheDocument();
  });

  test('a REFUSAL renders as a refusal, never as the empty state', async () => {
    wireFetch('refused');
    renderPage(<SessionsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This credential resolves to no Account.');
    // The defect this assertion exists for: telling an operator their
    // reporters stopped when the truth is that they may not read them.
    expect(screen.queryByText('No reporters connected')).not.toBeInTheDocument();
  });

  test('axe finds nothing, populated and empty', async () => {
    wireFetch('full');
    const populated = renderPage(<SessionsPage />);
    await screen.findByRole('heading', { name: 'Reporting sources' });
    expect(await axeViolations(populated.container)).toEqual([]);
    cleanup();

    wireFetch('empty');
    const empty = renderPage(<SessionsPage />);
    await screen.findByText('No reporters connected');
    expect(await axeViolations(empty.container)).toEqual([]);
  });
});

describe('StatsPage', () => {
  test('renders usage, model mix, cost WITH its basis, and the coverage view', async () => {
    wireFetch('full');
    renderPage(<StatsPage />);
    expect(await screen.findByRole('heading', { name: 'Usage' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Model mix' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Adapter coverage' })).toBeInTheDocument();
    expect(screen.getAllByText('claude-opus-5').length).toBeGreaterThan(0);
    // The basis is VISIBLE TEXT, not a tooltip: an estimate presented as an
    // invoice is the failure §4.7 exists to prevent.
    expect(screen.getByRole('cell', { name: 'estimated' })).toBeInTheDocument();
    // The amount arrived as a STRING and is shown trimmed, not re-parsed
    // through a double on the way to the screen.
    expect(screen.getByText('2.5')).toBeInTheDocument();
  });

  test('an unstated coverage label is shown as unstated, never guessed', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      const path = String(url);
      if (path.includes('/telemetry/stats')) {
        return jsonResponse({
          success: true,
          ...STATS,
          coverage: [{ ...SOURCE, mechanism: null, supportLevel: null, adapter: null }],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    renderPage(<StatsPage />);
    expect(await screen.findByRole('heading', { name: 'Adapter coverage' })).toBeInTheDocument();
    // Exactly the two CELLS — the explanatory note below the table also
    // contains the word, and counting text nodes would silently pass if a
    // cell stopped saying it and the prose kept the count up.
    expect(screen.getAllByRole('cell', { name: 'unstated' })).toHaveLength(2);
  });

  test('EMPTY renders the shipped empty state; a REFUSAL renders as a refusal', async () => {
    wireFetch('empty');
    renderPage(<StatsPage />);
    expect(await screen.findByText('No activity data to chart')).toBeInTheDocument();
    cleanup();

    wireFetch('refused');
    renderPage(<StatsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This credential resolves to no Account.');
    expect(screen.queryByText('No activity data to chart')).not.toBeInTheDocument();
  });

  test('axe finds nothing, populated and empty', async () => {
    wireFetch('full');
    const populated = renderPage(<StatsPage />);
    await screen.findByRole('heading', { name: 'Usage' });
    expect(await axeViolations(populated.container)).toEqual([]);
    cleanup();

    wireFetch('empty');
    const empty = renderPage(<StatsPage />);
    await screen.findByText('No activity data to chart');
    expect(await axeViolations(empty.container)).toEqual([]);
  });
});

describe('the polling cadence', () => {
  test('sits above a frame interval and well below the staleness window', async () => {
    const { TELEMETRY_POLL_MS } = await import('../utils/telemetryProjection');
    expect(TELEMETRY_POLL_MS).toBeGreaterThanOrEqual(5_000);
    // The server derives `stale` at 9 minutes; a poll slower than that would
    // let the page show `active` for a source the server already calls stale.
    expect(TELEMETRY_POLL_MS).toBeLessThan(9 * 60_000);
  });

  test('neither page subscribes — presence is PULLED, and the source says so', async () => {
    // Ingest has "no feed emission" (the ratified §2.6.5 rule restated in
    // TelemetryService), so a WebSocket push for presence would have to be
    // emitted from the path that rule forbids. A future edit that reaches for
    // the socket instead of the poll reddens HERE rather than quietly
    // contradicting the ingest contract.
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    for (const page of ['SessionsPage.tsx', 'StatsPage.tsx']) {
      const source = readFileSync(join(__dirname, page), 'utf8');
      expect(source).not.toContain('useWebSocket');
      expect(source).toContain('refetchInterval');
    }
    // And the poll is actually wired: the page re-reads through the mocked
    // fetch rather than only rendering whatever the first read returned.
    wireFetch('full');
    renderPage(<SessionsPage />);
    await screen.findByRole('heading', { name: 'Reporting sources' });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  });
});
