// @vitest-environment jsdom
/**
 * THE KNOWLEDGE STATUS PANEL (card 1fd5de08, line 2; owner direction E124).
 *
 * The panel's figures are made only from the caller's queryable set and the
 * answers to the caller's own searches on the page. These tests hold the read
 * model to that: every coverage bucket lands in exactly one outcome, nothing
 * is counted for a source neither the list nor an answer named, the update
 * times are the newest and oldest the results carried, the log is bounded,
 * and the figures counted inside the knowledge service are named as not shown
 * rather than shown as zero.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { test, expect, afterEach, describe } from 'vitest';
import { KnowledgeStatus, KNOWLEDGE_STATUS_NOT_SHOWN } from './KnowledgeStatus';
import {
  KNOWLEDGE_STATUS_LOG_LIMIT, appendSearchRecord, lastTurnText, searchedText, sourceTurns, summarizeKnowledgeStatus,
  type KnowledgeSearchRecord,
} from './knowledgeStatus';
import type { KnowledgeAnswer, KnowledgeCoverage, KnowledgeHit, KnowledgeSource } from './knowledgeModel';
import { formatDateTime } from '../../utils/dateFormat';

afterEach(cleanup);

const A = 'a1111111-1111-4111-8111-111111111111';
const B = 'b2222222-2222-4222-8222-222222222222';
const C = 'c3333333-3333-4333-8333-333333333333';
const D = 'd4444444-4444-4444-8444-444444444444';
const E = 'e5555555-5555-4555-8555-555555555555';
const F = 'f6666666-6666-4666-8666-666666666666';
const G = 'a7777777-7777-4777-8777-777777777777';

const SOURCES: KnowledgeSource[] = [
  { id: A, name: 'Team notes', claimsMode: 'asserted', protocol_version: 2, categories: ['note', 'decision'] },
  { id: B, name: 'Design files', claimsMode: 'asserted', compartments: ['design'] },
];
const label = (id: string) => SOURCES.find((s) => s.id === id)?.name ?? id;

function cov(extra: Partial<KnowledgeCoverage> = {}): KnowledgeCoverage {
  return {
    consulted: [A], answered: [A], timedOut: [], unavailable: [], refusedBySource: [], refusedByPolicy: [], skipped: [],
    truncatedResults: [], invalidResults: [], ...extra,
  };
}
const hit = (title: string, updatedAt?: string): KnowledgeHit =>
  ({ handle: 'kh.' + title, title, snippet: '', contentKind: 'docs', compartment: 'c', ...(updatedAt ? { updatedAt } : {}) });
function answer(coverage: KnowledgeCoverage, groups: KnowledgeAnswer['groups'] = []): KnowledgeSearchRecord {
  return { kind: 'answer', answer: { coverage, groups, auditRef: 'ka_' + 'a'.repeat(32) } };
}

describe('the read model', () => {
  test('every coverage bucket lands in exactly one outcome, with the reason the core gave', () => {
    const turns = sourceTurns({
      coverage: cov({
        consulted: [A, B, C, D, E, F], answered: [A, B],
        partialSources: [{ id: B, reasons: ['deadline'] }], timedOut: [C],
        unavailable: [{ id: D, reason: 'transport' }], refusedBySource: [E], refusedByPolicy: [F],
        skipped: [{ id: G, reason: 'kinds' }],
      }),
      groups: [{ sourceId: A, sourceSlug: 'a', results: [hit('one'), hit('two')] }],
      auditRef: 'ka_' + 'a'.repeat(32),
    });
    expect(Object.fromEntries([...turns].map(([id, turn]) => [id, turn]))).toEqual({
      [A]: { kind: 'answered', results: 2 },
      [B]: { kind: 'partial', results: 0, detail: 'deadline' },
      [C]: { kind: 'timedOut', results: 0 },
      [D]: { kind: 'unavailable', results: 0, detail: 'transport' },
      [E]: { kind: 'refusedBySource', results: 0 },
      [F]: { kind: 'refusedByPolicy', results: 0 },
      [G]: { kind: 'skipped', results: 0, detail: 'kinds' },
    });
  });

  test('a truncated or invalid result list makes an answered source partial, never complete', () => {
    const turns = sourceTurns({
      coverage: cov({ consulted: [A, B], answered: [A, B], truncatedResults: [A], invalidResults: [B] }),
      groups: [], auditRef: 'ka_' + 'a'.repeat(32),
    });
    expect(turns.get(A)).toEqual({ kind: 'partial', results: 0, detail: 'results truncated' });
    expect(turns.get(B)).toEqual({ kind: 'partial', results: 0, detail: 'invalid results omitted' });
  });

  test('the totals count each search once: complete, partial, no answer and failed', () => {
    const log: KnowledgeSearchRecord[] = [
      answer(cov()),
      answer(cov({ consulted: [A, B], unavailable: [{ id: B, reason: 'transport' }] })),
      answer(cov({ consulted: [A], answered: [] , timedOut: [A] })),
      answer(cov({ consulted: [], answered: [], skipped: [{ id: A, reason: 'kinds' }] })),
      { kind: 'failed', failure: { kind: 'unavailable', text: 'down', retry: true } },
    ];
    const summary = summarizeKnowledgeStatus(SOURCES, log, label);
    expect({
      sourcesListed: summary.sourcesListed, searches: summary.searches, complete: summary.completeAnswers,
      partial: summary.partialAnswers, empty: summary.emptyAnswers, failed: summary.failedSearches,
    }).toEqual({ sourcesListed: 2, searches: 5, complete: 1, partial: 1, empty: 2, failed: 1 });
    const notes = summary.sources.find((s) => s.id === A)!;
    expect({
      searched: notes.searched, full: notes.answeredInFull, part: notes.answeredInPart, missed: notes.didNotAnswer, skipped: notes.skipped,
    }).toEqual({ searched: 3, full: 2, part: 0, missed: 1, skipped: 1 });
    const files = summary.sources.find((s) => s.id === B)!;
    expect({ searched: files.searched, missed: files.didNotAnswer, last: files.last })
      .toEqual({ searched: 1, missed: 1, last: { kind: 'unavailable', results: 0, detail: 'transport' } });
  });

  test('update times are the newest and oldest the results carried; undated and unreadable times are counted apart', () => {
    const log = [
      answer(cov(), [{ sourceId: A, sourceSlug: 'a', results: [hit('mid', '2026-10-10T00:00:00.000Z'), hit('none')] }]),
      answer(cov(), [{ sourceId: A, sourceSlug: 'a', results: [
        hit('new', '2026-10-20T08:00:00.000Z'), hit('old', '2026-01-02T03:04:05.000Z'), hit('bad', 'not a time'),
      ] }]),
    ];
    const notes = summarizeKnowledgeStatus(SOURCES, log, label).sources.find((s) => s.id === A)!;
    expect({ results: notes.results, newest: notes.newest, oldest: notes.oldest, undated: notes.undated })
      .toEqual({ results: 5, newest: '2026-10-20T08:00:00.000Z', oldest: '2026-01-02T03:04:05.000Z', undated: 2 });
  });

  test('rows are the listed sources in the core order, plus only a source an answer named; nothing else is invented', () => {
    const summary = summarizeKnowledgeStatus(SOURCES, [
      answer(cov({ consulted: [C], answered: [C] }), [{ sourceId: C, sourceSlug: 'gone', results: [hit('x')] }]),
    ], label);
    expect(summary.sources.map((s) => [s.id, s.listed])).toEqual([[A, true], [B, true], [C, false]]);
    expect(summarizeKnowledgeStatus(SOURCES, [], label).sources.map((s) => s.id)).toEqual([A, B]);
    expect(summarizeKnowledgeStatus([], [], label).sources).toEqual([]);
  });

  test('the protocol and the declared categories come from the source list as the core returned it', () => {
    const [notes, files] = summarizeKnowledgeStatus(SOURCES, [], label).sources;
    expect([notes.protocolVersion, notes.categories, notes.inProcess]).toEqual([2, 2, false]);
    expect([files.protocolVersion, files.categories]).toEqual([1, null]);
    const board = summarizeKnowledgeStatus([{ ...SOURCES[0], inProcess: true } as KnowledgeSource], [], label).sources[0];
    expect(board.inProcess).toBe(true);
  });

  test('the log keeps only the newest searches, so the page memory is bounded', () => {
    let log: KnowledgeSearchRecord[] = [];
    for (let n = 0; n < KNOWLEDGE_STATUS_LOG_LIMIT + 5; n += 1) log = appendSearchRecord(log, answer(cov({ consulted: [String(n)] })));
    expect(log).toHaveLength(KNOWLEDGE_STATUS_LOG_LIMIT);
    expect((log[0] as { answer: KnowledgeAnswer }).answer.coverage.consulted).toEqual(['5']);
  });

  test('the words for each outcome say what happened', () => {
    expect([
      lastTurnText(null),
      lastTurnText({ kind: 'answered', results: 1 }),
      lastTurnText({ kind: 'partial', results: 3, detail: 'deadline' }),
      lastTurnText({ kind: 'timedOut', results: 0 }),
      lastTurnText({ kind: 'unavailable', results: 0, detail: 'rate-limited' }),
      lastTurnText({ kind: 'refusedBySource', results: 0 }),
      lastTurnText({ kind: 'refusedByPolicy', results: 0 }),
      lastTurnText({ kind: 'skipped', results: 0, detail: 'categories' }),
    ]).toEqual([
      'Not searched on this page yet.',
      'Answered in full with 1 result.',
      'Answered in part (deadline) with 3 results.',
      'Timed out.',
      'Unavailable (rate-limited).',
      'Refused by the source.',
      'Refused by policy.',
      'Not searched: none of the selected categories apply.',
    ]);
    const base = summarizeKnowledgeStatus(SOURCES, [], label).sources[0];
    expect(searchedText(base)).toBe('Not searched on this page yet.');
    expect(searchedText({ ...base, searched: 2, answeredInFull: 1, didNotAnswer: 1, skipped: 1 }))
      .toBe('Searched 2 times: 1 answered in full, 0 in part, 1 did not answer; not searched 1 time because the selection did not apply.');
  });
});

describe('the panel', () => {
  test('before any search it lists each source as not searched yet, with zero totals', () => {
    render(<KnowledgeStatus sources={SOURCES} log={[]} label={label} />);
    const panel = screen.getByRole('region', { name: 'Source status' });
    const totals = Object.fromEntries(within(panel).getAllByRole('term').slice(0, 6)
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]));
    expect(totals).toEqual({
      'Sources you can search': '2', 'Searches on this page': '0', 'Complete answers': '0', 'Partial answers': '0',
      'Searches with no answer': '0', 'Results shown': '0',
    });
    const cards = within(panel).getAllByRole('listitem').filter((item) => item.querySelector('h3'));
    expect(cards.map((card) => within(card).getByRole('heading', { level: 3 }).textContent)).toEqual(['Team notes', 'Design files']);
    for (const card of cards) {
      expect(within(card).getByText('Not searched on this page yet.')).toBeTruthy();
      expect(within(card).queryByText('Last search')).toBeNull();
      expect(within(card).queryByText('Newest update')).toBeNull();
    }
    expect(within(cards[0]).getByText('Version 2')).toBeTruthy();
    expect(within(cards[0]).getByText('2 declared')).toBeTruthy();
    expect(within(cards[1]).getByText('Version 1')).toBeTruthy();
    expect(within(cards[1]).getByText('None declared')).toBeTruthy();
  });

  test('after searches it shows each source\'s outcomes, last answer and update times', () => {
    const log = [
      answer(cov({ consulted: [A, B], unavailable: [{ id: B, reason: 'transport' }] }), [
        { sourceId: A, sourceSlug: 'a', results: [hit('new', '2026-10-20T08:00:00.000Z'), hit('old', '2026-09-01T00:00:00.000Z'), hit('undated')] },
      ]),
      { kind: 'failed', failure: { kind: 'unavailable', text: 'down', retry: true } } as KnowledgeSearchRecord,
    ];
    render(<KnowledgeStatus sources={SOURCES} log={log} label={label} />);
    const panel = screen.getByRole('region', { name: 'Source status' });
    const [notes, files] = within(panel).getAllByRole('listitem').filter((item) => item.querySelector('h3'));
    expect(within(notes).getByText('Searched 1 time: 1 answered in full, 0 in part, 0 did not answer.')).toBeTruthy();
    expect(within(notes).getByText('Answered in full with 3 results.')).toBeTruthy();
    expect(within(notes).getByText(formatDateTime('2026-10-20T08:00:00.000Z', ''))).toBeTruthy();
    expect(within(notes).getByText(formatDateTime('2026-09-01T00:00:00.000Z', ''))).toBeTruthy();
    expect(within(notes).getByText('Without an update time').nextElementSibling?.textContent).toBe('1');
    expect(within(files).getByText('Searched 1 time: 0 answered in full, 0 in part, 1 did not answer.')).toBeTruthy();
    expect(within(files).getByText('Unavailable (transport).')).toBeTruthy();
    expect(within(files).queryByText('Newest update')).toBeNull();
    expect(within(panel).getByText('Searches with no answer').nextElementSibling?.textContent).toBe('1');
    expect(within(panel).getByText('1 search was refused or could not be answered at all; it is counted under no answer.')).toBeTruthy();
  });

  test('results with no update time say so instead of showing a date', () => {
    render(<KnowledgeStatus sources={SOURCES} log={[answer(cov(), [{ sourceId: A, sourceSlug: 'a', results: [hit('undated')] }])]} label={label} />);
    expect(screen.getByText('No result reported an update time')).toBeTruthy();
    expect(screen.queryByText('Without an update time')).toBeNull();
  });

  test('the figures counted inside the knowledge service are named as not shown, never shown as numbers', () => {
    render(<KnowledgeStatus sources={SOURCES} log={[]} label={label} />);
    const elsewhere = screen.getByRole('heading', { name: 'Not shown here' }).parentElement!;
    expect(within(elsewhere).getAllByRole('listitem').map((item) => item.textContent)).toEqual([...KNOWLEDGE_STATUS_NOT_SHOWN]);
    expect(KNOWLEDGE_STATUS_NOT_SHOWN.join(' ')).toMatch(/retrieval quality.*MRR and Recall@k/);
    expect(elsewhere.textContent).not.toMatch(/\d/);
  });

  test('a source an earlier answer named but the list no longer holds is marked, with no list facts', () => {
    render(<KnowledgeStatus sources={[SOURCES[0]]} log={[answer(cov({ consulted: [B], answered: [B] }))]} label={label} />);
    const files = screen.getByRole('heading', { name: 'Design files' }).closest('li')!;
    expect(within(files).getByText('No longer among the sources you can search.')).toBeTruthy();
    expect(within(files).queryByText('Protocol')).toBeNull();
  });
});
