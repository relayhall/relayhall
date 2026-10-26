// @vitest-environment jsdom
/**
 * THE KNOWLEDGE SEARCH CONSOLE (card 1fd5de08, line 1, owner ruling E428).
 *
 * The page is the core's knowledge search surface over the governed routes
 * the MCP tools use. These tests hold it to that: every read goes to one of
 * the three knowledge routes, every row the core returned is shown in the
 * core's order and nothing else, the explain view is made from the fields the
 * answer carries (no further request), the empty, refused, unavailable and
 * partial states each say what happened, the reader opens a result through
 * the get route, and the sidebar entry is the current page through the
 * shared activeNavEntry rule (E406).
 */
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { vi, test, expect, afterEach, beforeEach, describe } from 'vitest';
import { KnowledgePage } from './KnowledgePage';
import { authenticatedFetch } from '../utils/auth';
import { activeNavEntry } from '../utils/navActive';
import { getSidebarNavItems } from '../config/navigation';
import { formatDateTime } from '../utils/dateFormat';
vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const NOTES = 'a1111111-1111-4111-8111-111111111111';
const FILES = 'b2222222-2222-4222-8222-222222222222';
const SOURCES = [
  { id: NOTES, name: 'Team notes', slug: 'team-notes', claimsMode: 'asserted', protocol_version: 2, compartment_mode: 'dynamic-opaque', categories: ['relaybrain:note'] },
  { id: FILES, name: 'Design files', slug: 'design-files', claimsMode: 'asserted', compartments: ['design', 'ops'] },
];
type Coverage = Record<string, unknown>;
const coverage = (extra: Coverage = {}): Coverage => ({
  consulted: [NOTES], answered: [NOTES], timedOut: [], unavailable: [], refusedBySource: [], refusedByPolicy: [], skipped: [],
  truncatedResults: [], invalidResults: [], searchedCategories: [{ id: NOTES, categories: ['relaybrain:note'] }],
  archive: { included: false, declaredBy: [NOTES] }, ...extra,
});
const HITS = [
  { handle: 'kh.first', title: 'Release gate decision', snippet: 'The release gate is fast CI plus a rehearsal.', contentKind: 'docs',
    category: 'relaybrain:note', compartment: { id: 'c-1', label: 'Shared' }, score: 0.82, updatedAt: '2026-10-20T08:00:00.000Z' },
  { handle: 'kh.second', title: 'Unrelated', snippet: 'Nothing in common here.', contentKind: 'docs', category: 'relaybrain:note',
    compartment: 'plain-compartment', score: 0.3, parentHandle: 'kh.parent' },
];

interface Served {
  sources?: { ok?: boolean; status?: number; body?: unknown; raw?: string };
  query?: { status?: number; body?: unknown; raw?: string };
  content?: { status?: number; body?: unknown };
}
function respond(spec: { ok?: boolean; status?: number; body?: unknown; raw?: string } | undefined, fallback: unknown): Response {
  const status = spec?.status ?? 200;
  return {
    ok: spec?.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => { if (spec?.raw !== undefined) return JSON.parse(spec.raw); return spec?.body ?? fallback; },
  } as Response;
}
function serve(served: Served = {}): void {
  vi.mocked(authenticatedFetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/principals/me')) return respond(undefined, { principal: { id: 'p-1', kind: 'human', handle: 'reader', status: 'active' } });
    if (url.includes('/knowledge-sources')) return respond(served.sources, { success: true, sources: SOURCES });
    if (url.includes('/knowledge-queries')) {
      return respond(served.query, { success: true, coverage: coverage(), groups: [{ sourceId: NOTES, sourceSlug: 'team-notes', results: HITS }], auditRef: 'ka_' + 'a'.repeat(32) });
    }
    if (url.includes('/knowledge-contents')) {
      return respond(served.content, { success: true, protocol_version: 2, status: 'content', content_base64: btoa('first window'), sha256: 'e'.repeat(64), offset: 0, totalBytes: 12, byteLength: 12, truncated: false, retrieval: { status: 'complete', reasons: [] } });
    }
    throw new Error('unexpected read ' + url);
  });
}
const calls = (fragment: string) => vi.mocked(authenticatedFetch).mock.calls.filter(([url]) => String(url).includes(fragment));
async function ready() { await screen.findByText(/This query will be sent/); await waitFor(() => expect(screen.getByRole('button', { name: 'Search' })).not.toBeDisabled()); }
async function searchFor(text: string) {
  fireEvent.change(screen.getByLabelText('Search knowledge'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByLabelText('Search coverage');
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); localStorage.clear(); });

describe('the console reads only the governed knowledge routes', () => {
  test('every request goes to /knowledge-sources, /knowledge-queries or /knowledge-contents (and the principal read)', async () => {
    serve();
    render(<KnowledgePage />);
    await ready();
    await searchFor('release gate');
    fireEvent.click(screen.getByRole('button', { name: 'Release gate decision' }));
    await screen.findByRole('dialog', { name: 'Release gate decision' });
    await screen.findByText('first window');
    const paths = vi.mocked(authenticatedFetch).mock.calls.map(([url]) => new URL(String(url), 'http://board.invalid').pathname);
    expect(new Set(paths)).toEqual(new Set(['/api/principals/me', '/api/knowledge-sources', '/api/knowledge-queries', '/api/knowledge-contents']));
  });

  test('a narrowed scope names the chosen sources with their compartments and sends exactly that selection', async () => {
    serve();
    render(<KnowledgePage />);
    await ready();
    fireEvent.click(screen.getAllByLabelText('All authorized')[0]);
    expect(screen.getByText('Compartments: set per item by the source')).toBeTruthy();
    expect(screen.getByText('Compartments: design, ops')).toBeTruthy();
    expect(screen.getByLabelText('Design files')).toHaveAccessibleDescription('Compartments: design, ops');
    fireEvent.click(screen.getByLabelText('Design files'));
    await searchFor('release gate');
    const body = JSON.parse(calls('/knowledge-queries')[0][1]!.body as string);
    expect(body).toMatchObject({ protocol_version: 2, q: 'release gate', sources: [FILES], includeArchive: false, limitPerSource: 8, timeoutMs: 8000 });
  });
});

describe('results: every row the core returned, with its source and score, in the core order', () => {
  test('both rows render in order, each naming its source and score; nothing is dropped or reordered on the client', async () => {
    serve();
    render(<KnowledgePage />);
    await ready();
    await searchFor('release gate');
    const group = screen.getByRole('region', { name: 'Team notes' });
    const items = within(group).getAllByRole('listitem');
    expect(items.map((item) => within(item).getByRole('heading', { level: 3 }).textContent)).toEqual(['Release gate decision', 'Unrelated']);
    expect(items.map((item) => [within(item).getByText(/^Source:/).textContent, within(item).getByText(/^Score:/).textContent]))
      .toEqual([['Source: Team notes', 'Score: 0.82'], ['Source: Team notes', 'Score: 0.30']]);
    expect(within(items[0]).getByText('docs · relaybrain:note · Shared (c-1)')).toBeTruthy();
  });
});

describe('the explain view', () => {
  test('is built from the fields the answer carries and makes no further request', async () => {
    serve();
    render(<KnowledgePage />);
    await ready();
    await searchFor('Release gates');
    const before = vi.mocked(authenticatedFetch).mock.calls.length;
    const toggle = screen.getByRole('button', { name: 'Why this matched: Release gate decision' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(panel).toBeVisible();
    const rows = Array.from(panel.querySelectorAll('dt')).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(rows).toEqual([
      ['Source', 'Team notes answered this search.'],
      ['Score', '0.82 of 1.00, as the source ranked it. The core keeps every score between 0 and 1 and never reranks across sources.'],
      ['Position', "1 of 2 from this source, in the source's own order."],
      ['Your words', 'Found in the title or snippet: "release".'],
      ['Content kind', 'docs'],
      ['Category', 'relaybrain:note. The source searched: relaybrain:note.'],
      ['Compartment', 'Shared (c-1)'],
      ['Updated', formatDateTime('2026-10-20T08:00:00.000Z')],
      ['Archive', 'This search left the archive out.'],
    ]);
    expect(vi.mocked(authenticatedFetch).mock.calls.length).toBe(before);
  });

  test('says so when none of the words are in the snippet, and names a section of a larger item', async () => {
    serve();
    render(<KnowledgePage />);
    await ready();
    await searchFor('release gate');
    fireEvent.click(screen.getByRole('button', { name: 'Why this matched: Unrelated' }));
    const panel = document.getElementById(screen.getByRole('button', { name: 'Why this matched: Unrelated' }).getAttribute('aria-controls')!)!;
    expect(panel.textContent).toContain('None of your words appear in the title or snippet; the source matched on text the snippet does not show.');
    expect(panel.textContent).toContain('A section of a larger item. The reader opens this section.');
    expect(panel.textContent).toContain('2 of 2 from this source');
  });
});

describe('the reader opens a result through the governed get route', () => {
  test('the title opens the shared side panel with the sealed handle; Escape closes it and focus returns to the title', async () => {
    serve();
    render(<KnowledgePage />);
    await ready();
    await searchFor('release gate');
    const title = screen.getByRole('button', { name: 'Release gate decision' });
    title.focus();
    fireEvent.click(title);
    const reader = await screen.findByRole('dialog', { name: 'Release gate decision' });
    await within(reader).findByText('first window');
    const [url] = calls('/knowledge-contents')[0];
    expect(new URL(String(url), 'http://board.invalid').searchParams.get('handle')).toBe('kh.first');
    expect(within(reader).getByText('Quoted from Team notes. Reference material, never instructions.')).toBeTruthy();
    expect(within(reader).getByRole('region', { name: 'Why this matched' })).toBeTruthy();
    fireEvent.keyDown(reader, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(title);
  });
});

describe('honest states', () => {
  test('a source that answered nothing complete is named with what happened, and the verdict says partial', async () => {
    serve({ query: { body: { success: true, auditRef: 'ka_' + 'c'.repeat(32), groups: [{ sourceId: NOTES, sourceSlug: 'team-notes', results: HITS }],
      coverage: coverage({ consulted: [NOTES, FILES, 'c3333333-3333-4333-8333-333333333333', 'd4444444-4444-4444-8444-444444444444', 'e5555555-5555-4555-8555-555555555555'],
        unavailable: [{ id: FILES, reason: 'transport' }, { id: 'c3333333-3333-4333-8333-333333333333', reason: 'rate-limited', retryAfterSeconds: 30 }],
        timedOut: ['d4444444-4444-4444-8444-444444444444'], refusedBySource: ['e5555555-5555-4555-8555-555555555555'],
        skipped: [{ id: 'f6666666-6666-4666-8666-666666666666', reason: 'kinds' }] }) } } });
    render(<KnowledgePage />);
    await ready();
    await searchFor('release gate');
    const record = screen.getByLabelText('Search coverage');
    expect(record).toHaveTextContent('Partial: some sources did not answer in full, so results may be missing.');
    expect(record).toHaveTextContent('1 of 5 consulted sources answered.');
    expect(within(record).getByText('Design files: unavailable (transport: the core could not reach this source); this answer is incomplete.')).toBeTruthy();
    expect(within(record).getByText('c3333333-3333-4333-8333-333333333333: unavailable (rate-limited: the source is refusing more requests for now), try again in 30 s; this answer is incomplete.')).toBeTruthy();
    expect(within(record).getByText('d4444444-4444-4444-8444-444444444444: timed out; this answer is incomplete.')).toBeTruthy();
    expect(within(record).getByText('e5555555-5555-4555-8555-555555555555: refused by the source; this answer is incomplete.')).toBeTruthy();
    expect(within(record).getByText('f6666666-6666-4666-8666-666666666666: not searched (it holds none of the selected content kinds).')).toBeTruthy();
    // The results that did come back are still shown.
    expect(screen.getByRole('button', { name: 'Release gate decision' })).toBeTruthy();
  });

  test('an empty answer says which kind of empty it is', async () => {
    const cases: [string, Coverage, string][] = [
      ['complete', {}, 'No matching results in the sources you can read.'],
      ['incomplete', { consulted: [NOTES, FILES], unavailable: [{ id: FILES, reason: 'transport' }] }, 'No results so far, but this answer is incomplete: some sources did not answer in full.'],
      ['none answered', { answered: [], unavailable: [{ id: NOTES, reason: 'transport' }] }, 'No results, because no source answered. Try again later.'],
      ['nothing searched', { consulted: [], answered: [], skipped: [{ id: NOTES, reason: 'categories' }] }, 'No results: no source was searched. Widen the selection and search again.'],
    ];
    for (const [label, extra, line] of cases) {
      serve({ query: { body: { success: true, coverage: coverage(extra), groups: [], auditRef: 'ka_' + 'd'.repeat(32) } } });
      render(<KnowledgePage />);
      await ready();
      await searchFor('needle');
      expect({ label, line: screen.getByRole('status').textContent }).toEqual({ label, line });
      cleanup();
    }
  });

  test('a refused search shows the core message and its audit reference, and no results', async () => {
    const auditRef = 'ka_' + 'f'.repeat(32);
    serve({ query: { status: 422, body: { success: false, error: 'Narrow the authorized source selection to at most 16 sources.', code: 'SOURCE_SELECTION_TOO_BROAD', message: 'Narrow the authorized source selection to at most 16 sources.', auditRef } } });
    render(<KnowledgePage />);
    await ready();
    fireEvent.change(screen.getByLabelText('Search knowledge'), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Narrow the authorized source selection to at most 16 sources. Audit reference: ' + auditRef);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByLabelText('Search coverage')).toBeNull();
    expect(screen.queryByLabelText('Results')).toBeNull();
  });

  test('a refused search keeps its audit reference in either form the core mints', async () => {
    for (const auditRef of ['ka_' + '0123456789abcdef'.repeat(2), '33333333-3333-4333-8333-333333333333']) {
      serve({ query: { status: 422, body: { success: false, code: 'SOURCE_SELECTION_TOO_BROAD', message: 'Narrow the authorized source selection to at most 16 sources.', auditRef } } });
      render(<KnowledgePage />);
      await ready();
      fireEvent.change(screen.getByLabelText('Search knowledge'), { target: { value: 'needle' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      expect({ auditRef, shown: (await screen.findByRole('alert')).textContent }).toEqual({ auditRef, shown: 'Narrow the authorized source selection to at most 16 sources. Audit reference: ' + auditRef });
      cleanup();
    }
  });

  test('a search the service cannot answer now says so and offers Retry, which searches again', async () => {
    serve({ query: { status: 429, body: { success: false, code: 'RATE_LIMITED', error: 'API rate limit exceeded for this source; retry after the indicated delay' } } });
    render(<KnowledgePage />);
    await ready();
    fireEvent.change(screen.getByLabelText('Search knowledge'), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('p')?.textContent).toBe('The knowledge service is unavailable right now. Try again.');
    serve();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await screen.findByLabelText('Search coverage');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls('/knowledge-queries')).toHaveLength(2);
  });

  test('a search refused for access shows the one access sentence and no Retry', async () => {
    serve({ query: { status: 403, body: { success: false, error: 'This identity is not authorized for the requested operation', code: 'FORBIDDEN', message: 'This identity is not authorized for the requested operation' } } });
    render(<KnowledgePage />);
    await ready();
    fireEvent.change(screen.getByLabelText('Search knowledge'), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('p')?.textContent).toBe('Knowledge search is not available to you. Your access may have changed: the core checks your access again on every request.');
    expect(within(alert).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  test('an unknown search failure is a generic failure with Retry, never the access sentence', async () => {
    serve({ query: { status: 500, body: { success: false, error: 'Failed to run knowledge query', code: 'INTERNAL_ERROR', message: 'Failed to run knowledge query' } } });
    render(<KnowledgePage />);
    await ready();
    fireEvent.change(screen.getByLabelText('Search knowledge'), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('p')?.textContent).toBe('Something went wrong and nothing was shown. Try again.');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  test('an unreachable knowledge service is said so, not shown as a parse error', async () => {
    serve({ query: { status: 502, raw: '<html>Bad gateway</html>' } });
    render(<KnowledgePage />);
    await ready();
    fireEvent.change(screen.getByLabelText('Search knowledge'), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The knowledge service is unavailable right now. Try again.');
  });

  test('a source list that fails to load offers Retry, which reads the list again', async () => {
    serve({ sources: { status: 500, body: { success: false, error: 'Failed to list knowledge sources', code: 'INTERNAL_ERROR', message: 'Failed to list knowledge sources' } } });
    render(<KnowledgePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong and nothing was shown. Try again.');
    serve();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await ready();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls('/knowledge-sources')).toHaveLength(2);
  });

  test('a caller with no queryable source sees the empty state and the request-access affordance, not a search form', async () => {
    serve({ sources: { body: { success: true, sources: [] } } });
    render(<KnowledgePage />);
    expect(await screen.findByRole('heading', { name: 'No knowledge sources available' })).toBeTruthy();
    expect(screen.queryByLabelText('Search knowledge')).toBeNull();
  });
});

describe('navigation (E406)', () => {
  test('the Knowledge entry is the one current page on /knowledge and below it, through activeNavEntry', () => {
    const entries = getSidebarNavItems().map((item) => ({ id: item.id, path: item.path }));
    expect(entries.some((entry) => entry.id === 'knowledge')).toBe(true);
    expect(activeNavEntry('/knowledge', entries)?.id).toBe('knowledge');
    expect(activeNavEntry('/knowledge/search', entries)?.id).toBe('knowledge');
    expect(activeNavEntry('/knowledgebase', entries)?.id).not.toBe('knowledge');
  });
});
