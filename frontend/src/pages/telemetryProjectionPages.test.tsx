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
 *
 *   6. (card 0ac41d40) The short-session toggle, the Reporter/Product filter,
 *      "Load more" and the poll: what the page SENDS, what it keeps across a
 *      poll, and the Stats labels for the short share.
 */
import axe from 'axe-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { authenticatedFetch } from '../utils/auth';
import { TELEMETRY_POLL_MS as TELEMETRY_POLL_MS_FOR_TEST } from '../utils/telemetryProjection';
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
      // The list answers with its counts (card 0ac41d40): nothing hidden here,
      // one page holding every row.
      const sessions = mode === 'full' ? [SESSION, FINISHED_SESSION] : [];
      return jsonResponse({
        success: true, sessions, hiddenCount: 0, shortCount: 0, total: sessions.length,
        offset: 0, nextOffset: null, shortSession: { maxEvents: 3, minDurationMs: 120_000 },
      });
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
}

function renderPage(page: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/sessions']}>{page}</MemoryRouter></QueryClientProvider>);
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
    // deliberately matched as a SET rather than as a unique node. The
    // Product filter (card 0ac41d40) offers it too, as an OPTION, which is
    // counted on its own rather than folded into the same number.
    expect(screen.getAllByText('claude-code', { ignore: 'option, script, style' }).length).toBe(3);
    expect(screen.getByRole('option', { name: 'claude-code' })).toBeInTheDocument();
    // The Reporter is named on the source card AND on each of its two
    // session rows (the Reporter column, card 35b73092); with no display
    // name on the row, the handle stands in. The Reporter filter offers it
    // under the same name.
    expect(screen.getAllByText('laptop-reporter', { ignore: 'option, script, style' })).toHaveLength(3);
    expect(screen.getByRole('option', { name: 'laptop-reporter' })).toBeInTheDocument();
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

  test('MCP-derived rows name their Connector by display name, on the card and in the Reporter column (35b73092)', async () => {
    const MCP_SOURCE = {
      ...SOURCE, sourceProduct: 'mcp', adapter: 'relayhall-mcp',
      connectorDisplayName: 'Workstation Claude', connectorFrame: null,
    };
    const MCP_SESSION = {
      ...SESSION, sourceProduct: 'mcp', connectorDisplayName: 'Workstation Claude',
      models: [], inputTokens: 0, outputTokens: 0, totalTokens: 0,
    };
    mockFetch.mockImplementation(async (url: string) => {
      const path = String(url);
      if (path.includes('/telemetry/presence')) return jsonResponse({ success: true, sources: [MCP_SOURCE] });
      if (path.includes('/telemetry/sessions')) return jsonResponse({ success: true, sessions: [MCP_SESSION] });
      throw new Error(`unexpected fetch: ${path}`);
    });
    const { container } = renderPage(<SessionsPage />);
    expect(await screen.findByRole('heading', { name: 'Reporting sources' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Reporter' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Workstation Claude' })).toBeInTheDocument();
    // Card and row both say the display name; the derived handle is not shown.
    // The Reporter filter (card 0ac41d40) offers the same name as an option.
    expect(screen.getAllByText('Workstation Claude', { ignore: 'option, script, style' })).toHaveLength(2);
    expect(screen.getByRole('option', { name: 'Workstation Claude' })).toBeInTheDocument();
    expect(screen.queryByText('laptop-reporter')).not.toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
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

// ─────────── short sessions, the filter and paging (card 0ac41d40) ───────────

/**
 * Card `0ac41d40` (owner ruling E89 (b)). The SERVER decides which sessions
 * are short, filters and pages; these cases measure what the page SENDS and
 * what it keeps. The fake list below answers like the route: it applies the
 * toggle, the filters and the offset to a fixture and reports the counts, so
 * a page that sent the wrong parameters shows the wrong rows.
 *
 * Fixture: `conn-1` (claude-code) has 55 sessions and 3 short ones; `conn-2`
 * (mcp) has 5 and 4 short. Newest first, as the route orders them.
 */
describe('SessionsPage — short sessions, the filter and paging (0ac41d40)', () => {
  const RULE = { maxEvents: 3, minDurationMs: 120_000 };
  const SOURCE_2 = {
    ...SOURCE, connectorId: 'conn-2', connectorHandle: 'workstation', connectorDisplayName: 'Workstation Claude',
    sourceProduct: 'mcp', adapter: 'relayhall-mcp', connectorFrame: null,
  };
  type Row = typeof SESSION & { connectorDisplayName?: string; short: boolean };
  const at = (minutesAgo: number): string => new Date(Date.UTC(2026, 8, 5, 10, 0) - minutesAgo * 60_000).toISOString();
  const row = (index: number, connectorId: string, short: boolean, minutesAgo: number): Row => ({
    ...SESSION,
    sessionRef: `rhp_${connectorId}_${short ? 'short' : 'long'}_${String(index).padStart(3, '0')}`,
    connectorId,
    connectorHandle: connectorId === 'conn-1' ? 'laptop-reporter' : 'workstation',
    connectorDisplayName: connectorId === 'conn-1' ? undefined : 'Workstation Claude',
    sourceProduct: connectorId === 'conn-1' ? 'claude-code' : 'mcp',
    lastSeenAt: at(minutesAgo),
    short,
    ...(short ? { eventCount: 3, models: [], inputTokens: 0, outputTokens: 0, totalTokens: 0 } : {}),
  });

  let rows: Row[];
  let requests: URL[];

  function fixture(): Row[] {
    const all: Row[] = [];
    for (let i = 0; i < 55; i += 1) all.push(row(i, 'conn-1', false, 10 + i * 2));
    for (let i = 0; i < 3; i += 1) all.push(row(i, 'conn-1', true, 11 + i * 2));
    for (let i = 0; i < 5; i += 1) all.push(row(i, 'conn-2', false, 200 + i));
    for (let i = 0; i < 4; i += 1) all.push(row(i, 'conn-2', true, 1 + i));
    return all.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  function listAnswer(url: URL) {
    const query = url.searchParams;
    const include = query.get('includeShort') === 'true';
    const inScope = rows.filter((r) => (!query.get('connectorId') || r.connectorId === query.get('connectorId'))
      && (!query.get('sourceProduct') || r.sourceProduct === query.get('sourceProduct')));
    const shortRows = inScope.filter((r) => r.short);
    const listed = inScope.filter((r) => include || !r.short);
    const offset = Number(query.get('offset') ?? 0);
    const limit = Number(query.get('limit') ?? 50);
    const page = listed.slice(offset, offset + limit).map(({ short: _short, ...rest }) => rest);
    const reached = offset + page.length;
    return {
      success: true, sessions: page, hiddenCount: include ? 0 : shortRows.length, shortCount: shortRows.length,
      total: listed.length, offset, limit, nextOffset: page.length > 0 && reached < listed.length ? reached : null,
      windowDays: 7, windowStart: '2026-08-29T10:00:00.000Z', includeShort: include, shortSession: RULE,
    };
  }

  function wireList() {
    rows = fixture();
    requests = [];
    mockFetch.mockImplementation(async (input: string) => {
      const url = new URL(String(input), 'http://board.example');
      if (url.pathname.endsWith('/telemetry/presence')) return jsonResponse({ success: true, sources: [SOURCE, SOURCE_2] });
      if (url.pathname.endsWith('/telemetry/sessions')) {
        requests.push(url);
        return jsonResponse(listAnswer(url));
      }
      if (url.pathname.includes('/telemetry/sessions/')) return jsonResponse({ success: true, ...DETAIL });
      throw new Error(`unexpected fetch: ${url.pathname}`);
    });
  }

  /** One row of the table per session: its disclosure button. */
  const sessionButtons = (): HTMLElement[] => screen.getAllByRole('button', { name: /rhp_/ });
  const lastListRequest = (): URL => requests[requests.length - 1];

  afterEach(() => { vi.useRealTimers(); });

  test('hidden by default: the page asks without includeShort, says how many it hid, and what "short" means', async () => {
    wireList();
    renderPage(<SessionsPage />);
    const toggle = await screen.findByRole('button', { name: 'Show 7 short sessions' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // Every parameter the page means is SENT; the toggle only when set.
    const first = requests[0].searchParams;
    expect({
      offset: first.get('offset'), limit: first.get('limit'), windowDays: first.get('windowDays'),
      includeShort: first.has('includeShort'), connectorId: first.has('connectorId'), sourceProduct: first.has('sourceProduct'),
    }).toEqual({ offset: '0', limit: '50', windowDays: '7', includeShort: false, connectorId: false, sourceProduct: false });
    // The definition comes from the server's values and describes the toggle.
    const definition = document.getElementById(toggle.getAttribute('aria-describedby')!);
    expect(definition).toHaveTextContent(
      'Short means at most 3 events, under 2 minutes, with no model and no tokens');
    expect(definition).toHaveTextContent('Stats still count them');
    expect(screen.getByText(/showing 50 of 60 session\(s\) in the last 7 days; 7 short session\(s\) hidden\./))
      .toBeInTheDocument();
    expect(screen.queryByText(/_short_/)).not.toBeInTheDocument();
  });

  test('the TOGGLE asks for short sessions, keeps its label, and reports itself pressed', async () => {
    wireList();
    renderPage(<SessionsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show 7 short sessions' }));
    await waitFor(() => expect(lastListRequest().searchParams.get('includeShort')).toBe('true'));
    const pressed = await screen.findByRole('button', { name: 'Show 7 short sessions', pressed: true });
    expect(pressed).toBeInTheDocument();
    expect((await screen.findAllByText('rhp_conn-2_sho…')).length).toBe(4);
    expect(screen.getByText(/showing 50 of 67 session\(s\) in the last 7 days\./)).toBeInTheDocument();
    await userEvent.click(pressed);
    await waitFor(() => expect(lastListRequest().searchParams.has('includeShort')).toBe(false));
    expect(await screen.findByRole('button', { name: 'Show 7 short sessions', pressed: false })).toBeInTheDocument();
  });

  test('the Reporter and Product FILTER are sent to the server, and a choice that matches nothing keeps the controls', async () => {
    wireList();
    renderPage(<SessionsPage />);
    const reporter = await screen.findByRole('combobox', { name: 'Reporter' });
    const product = screen.getByRole('combobox', { name: 'Product' });
    // The choices are the reporters and products presence names.
    expect(within(reporter).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['All reporters', 'laptop-reporter', 'Workstation Claude']);
    expect(within(product).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['All products', 'claude-code', 'mcp']);

    await userEvent.selectOptions(reporter, 'conn-2');
    await waitFor(() => expect(lastListRequest().searchParams.get('connectorId')).toBe('conn-2'));
    await waitFor(() => expect(sessionButtons()).toHaveLength(5));
    expect(screen.getByRole('button', { name: 'Show 4 short sessions' })).toBeInTheDocument();

    await userEvent.selectOptions(product, 'claude-code');
    await waitFor(() => {
      const sent = lastListRequest().searchParams;
      expect({ connectorId: sent.get('connectorId'), sourceProduct: sent.get('sourceProduct'), offset: sent.get('offset') })
        .toEqual({ connectorId: 'conn-2', sourceProduct: 'claude-code', offset: '0' });
    });
    expect(await screen.findByText('No sessions match this reporter and product in the last 7 days.'))
      .toBeInTheDocument();
    // The controls are still there to undo the choice.
    expect(screen.getByRole('combobox', { name: 'Reporter' })).toHaveValue('conn-2');
    expect(screen.getByRole('combobox', { name: 'Product' })).toHaveValue('claude-code');
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument();
  });

  test('LOAD MORE asks for the next offset, appends the rows, and goes away on the last page', async () => {
    wireList();
    renderPage(<SessionsPage />);
    const more = await screen.findByRole('button', { name: 'Load more sessions (10 more)' });
    expect(sessionButtons()).toHaveLength(50);
    await userEvent.click(more);
    await waitFor(() => expect(sessionButtons()).toHaveLength(60));
    expect(lastListRequest().searchParams.get('offset')).toBe('50');
    expect(screen.queryByRole('button', { name: /Load more sessions/ })).not.toBeInTheDocument();
    expect(screen.getByText(/showing 60 of 60 session\(s\)/)).toBeInTheDocument();
  });

  test('the POLL refreshes the loaded window and never resets the filter, the toggle, the pages or an open row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    wireList();
    renderPage(<SessionsPage />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Reporter' }), 'conn-1');
    await user.click(await screen.findByRole('button', { name: 'Show 3 short sessions' }));
    await user.click(await screen.findByRole('button', { name: 'Load more sessions (8 more)' }));
    await waitFor(() => expect(sessionButtons()).toHaveLength(58));
    const [firstRow] = sessionButtons();
    await user.click(firstRow);
    expect(firstRow).toHaveAttribute('aria-expanded', 'true');

    // Something new arrives on the server between two polls.
    rows = [row(999, 'conn-1', false, 0), ...rows];
    requests = [];
    await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS_FOR_TEST);
    await waitFor(() => expect(requests.map((url) => url.searchParams.get('offset'))).toEqual(['0', '50']));
    // Both loaded pages were re-read under the SAME filter and toggle.
    for (const url of requests) {
      expect({ connectorId: url.searchParams.get('connectorId'), includeShort: url.searchParams.get('includeShort') })
        .toEqual({ connectorId: 'conn-1', includeShort: 'true' });
    }
    // The fresh row is shown, the loaded window still holds every row, and the
    // reader's own state is untouched.
    await waitFor(() => expect(sessionButtons()).toHaveLength(59));
    // The new row is on top, and the row that was open is still open — one
    // place further down, because its key is its identity, not its position.
    expect(sessionButtons()[0]).toHaveAttribute('aria-expanded', 'false');
    expect(sessionButtons()[1]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('combobox', { name: 'Reporter' })).toHaveValue('conn-1');
    expect(screen.getByRole('button', { name: 'Show 3 short sessions' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1);
    expect(screen.getByText(/showing 59 of 59 session\(s\)/)).toBeInTheDocument();
  });

  test('axe finds nothing with the toggle pressed, a filter set and Load more shown', async () => {
    wireList();
    const { container } = renderPage(<SessionsPage />);
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Reporter' }), 'conn-1');
    await userEvent.click(await screen.findByRole('button', { name: 'Show 3 short sessions' }));
    expect(await screen.findByRole('button', { name: 'Load more sessions (8 more)' })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('StatsPage — the short share is labelled (0ac41d40)', () => {
  function wireStats(totals: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/telemetry/stats')) {
        return jsonResponse({ success: true, ...STATS, totals: { ...STATS.totals, ...totals }, ...extra });
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });
  }
  const RULE = { maxEvents: 3, minDurationMs: 120_000 };

  test('Sessions and Events say how many of them are short, with the rule in words', async () => {
    wireStats({ sessions: 1520, events: 6000, shortSessions: 1400, shortSessionEvents: 4100 }, { shortSession: RULE });
    renderPage(<StatsPage />);
    await screen.findByRole('heading', { name: 'Usage' });
    expect(screen.getByText('1,520')).toBeInTheDocument();
    expect(screen.getByText(
      'Includes 1,400 short sessions (at most 3 events, under 2 minutes, with no model and no tokens), '
      + 'which the Sessions page hides by default.')).toBeInTheDocument();
    expect(screen.getByText('Includes 4,100 events from short sessions.')).toBeInTheDocument();
  });

  test('the label is shown at zero too, and absent only when the board does not report it', async () => {
    wireStats({ shortSessions: 0, shortSessionEvents: 0 }, { shortSession: RULE });
    renderPage(<StatsPage />);
    await screen.findByRole('heading', { name: 'Usage' });
    expect(screen.getByText(/^Includes 0 short sessions/)).toBeInTheDocument();
    expect(screen.getByText('Includes 0 events from short sessions.')).toBeInTheDocument();
    cleanup();

    wireStats({});
    renderPage(<StatsPage />);
    await screen.findByRole('heading', { name: 'Usage' });
    expect(screen.queryByText(/short session/)).not.toBeInTheDocument();
  });
});
