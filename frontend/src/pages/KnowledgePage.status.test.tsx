// @vitest-environment jsdom
/**
 * THE KNOWLEDGE STATUS PANEL ON THE PAGE (card 1fd5de08, line 2; E124).
 *
 * The panel adds no request and no authority: it is fed by the source list
 * and the searches the console already runs. These tests hold the page to
 * that: the reads are exactly the list and the searches the caller ran, each
 * search (answered or failed) is counted once, a source the core did not list
 * is never named, and a source list that failed to load shows no panel at all
 * rather than a panel of zeros.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { vi, test, expect, afterEach, beforeEach, describe } from 'vitest';
import { KnowledgePage } from './KnowledgePage';
import { authenticatedFetch } from '../utils/auth';
vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const NOTES = 'a1111111-1111-4111-8111-111111111111';
const FILES = 'b2222222-2222-4222-8222-222222222222';
const SOURCES = [
  { id: NOTES, name: 'Team notes', slug: 'team-notes', claimsMode: 'asserted', protocol_version: 2, categories: ['relaybrain:note'] },
  { id: FILES, name: 'Design files', slug: 'design-files', claimsMode: 'asserted', compartments: ['design'] },
];
const ANSWER = {
  success: true,
  coverage: {
    consulted: [NOTES, FILES], answered: [NOTES], timedOut: [], unavailable: [{ id: FILES, reason: 'transport' }],
    refusedBySource: [], refusedByPolicy: [], skipped: [], truncatedResults: [], invalidResults: [],
    archive: { included: false, declaredBy: [] },
  },
  groups: [{ sourceId: NOTES, sourceSlug: 'team-notes', results: [
    { handle: 'kh.one', title: 'Release gate decision', snippet: 'Fast CI.', contentKind: 'docs', compartment: 'c', score: 0.8, updatedAt: '2026-10-20T08:00:00.000Z' },
  ] }],
  auditRef: 'ka_' + 'a'.repeat(32),
};

type Reply = { status: number; body: unknown };
let sourcesReply: Reply;
let queryReplies: Reply[];
function json(reply: Reply): Response {
  return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body } as Response;
}
beforeEach(() => {
  localStorage.clear();
  sourcesReply = { status: 200, body: { success: true, sources: SOURCES } };
  queryReplies = [];
  vi.mocked(authenticatedFetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/principals/me')) return json({ status: 200, body: { principal: { id: 'p-1', kind: 'human', handle: 'reader', status: 'active' } } });
    if (url.includes('/knowledge-sources')) return json(sourcesReply);
    if (url.includes('/knowledge-queries')) return json(queryReplies.shift() ?? { status: 200, body: ANSWER });
    throw new Error('unexpected read ' + url);
  });
});
afterEach(() => { cleanup(); vi.mocked(authenticatedFetch).mockReset(); });

const knowledgeCalls = () => vi.mocked(authenticatedFetch).mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/knowledge'));
async function ready() {
  await screen.findByText(/This query will be sent/);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Search' })).not.toBeDisabled());
}
async function search(text: string) {
  fireEvent.change(screen.getByLabelText('Search knowledge'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Search' })).not.toBeDisabled());
}
const total = (name: string) => within(screen.getByRole('region', { name: 'Source status' })).getByText(name).nextElementSibling?.textContent;
const card = (name: string) => within(screen.getByRole('region', { name: 'Source status' })).getByRole('heading', { level: 3, name }).closest('li')!;

describe('the status panel on the Knowledge page', () => {
  test('it is fed by the list and the searches the caller ran, and makes no request of its own', async () => {
    render(<KnowledgePage />);
    await ready();
    expect(total('Sources you can search')).toBe('2');
    expect(total('Searches on this page')).toBe('0');
    expect(knowledgeCalls().map((url) => url.replace(/^.*\/api/, ''))).toEqual(['/knowledge-sources']);
    await search('release gate');
    await search('release gate');
    expect(knowledgeCalls().map((url) => url.replace(/^.*\/api/, ''))).toEqual(['/knowledge-sources', '/knowledge-queries', '/knowledge-queries']);
    expect(total('Searches on this page')).toBe('2');
    expect(total('Partial answers')).toBe('2');
    expect(total('Results shown')).toBe('2');
    expect(within(card('Team notes')).getByText('Searched 2 times: 2 answered in full, 0 in part, 0 did not answer.')).toBeTruthy();
    expect(within(card('Design files')).getByText('Searched 2 times: 0 answered in full, 0 in part, 2 did not answer.')).toBeTruthy();
    expect(within(card('Design files')).getByText('Unavailable (transport).')).toBeTruthy();
  });

  test('a search the core refused or could not answer is counted once, under no answer', async () => {
    queryReplies = [{ status: 503, body: { success: false, code: 'source_unavailable' } }];
    render(<KnowledgePage />);
    await ready();
    await search('needle');
    await screen.findByRole('alert');
    expect(total('Searches on this page')).toBe('1');
    expect(total('Searches with no answer')).toBe('1');
    expect(screen.getByText('1 search was refused or could not be answered at all; it is counted under no answer.')).toBeTruthy();
    expect(within(card('Team notes')).getByText('Not searched on this page yet.')).toBeTruthy();
  });

  test('a choice the page refuses before asking the core is not a search and is not counted', async () => {
    render(<KnowledgePage />);
    await ready();
    fireEvent.click(screen.getByLabelText('docs'));
    fireEvent.click(screen.getByLabelText('code'));
    fireEvent.click(screen.getByLabelText('data'));
    await search('needle');
    expect(screen.getByText('Choose at least one value in each narrowed selector.')).toBeTruthy();
    expect(total('Searches on this page')).toBe('0');
    expect(knowledgeCalls().filter((url) => url.includes('/knowledge-queries'))).toEqual([]);
  });

  test('only sources the core listed or an answer named appear; nothing about other sources is shown', async () => {
    sourcesReply = { status: 200, body: { success: true, sources: [SOURCES[0]] } };
    queryReplies = [{ status: 200, body: { ...ANSWER, coverage: { ...ANSWER.coverage, consulted: [NOTES], unavailable: [] } } }];
    render(<KnowledgePage />);
    await ready();
    await search('release gate');
    const panel = screen.getByRole('region', { name: 'Source status' });
    expect(within(panel).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Team notes', 'Not shown here']);
    expect(panel.textContent).not.toContain('Design files');
    expect(panel.textContent).not.toContain(FILES);
    expect(total('Sources you can search')).toBe('1');
  });

  test('no panel when the source list failed to load or is empty: never a panel of zeros', async () => {
    sourcesReply = { status: 503, body: { success: false, code: 'source_unavailable' } };
    const first = render(<KnowledgePage />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('region', { name: 'Source status' })).toBeNull();
    first.unmount();
    sourcesReply = { status: 200, body: { success: true, sources: [] } };
    render(<KnowledgePage />);
    await screen.findByText('No knowledge sources available');
    expect(screen.queryByRole('region', { name: 'Source status' })).toBeNull();
  });
});
