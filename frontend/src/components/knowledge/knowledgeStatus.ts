/**
 * THE KNOWLEDGE STATUS PANEL'S READ MODEL (card 1fd5de08, line 2).
 *
 * The panel shows how the sources a caller may search answered that caller's
 * own searches, and nothing else. Every figure is made from two things the
 * core has ALREADY returned to this browser:
 *  - the caller's queryable set, `GET /knowledge-sources` (sources the caller
 *    may not read are absent from it, with no marker and no count);
 *  - the answers to the searches run on this page since it opened
 *    (`POST /knowledge-queries`): each answer's coverage record, its result
 *    groups and each result's `updatedAt`, or the failure the core answered.
 *
 * There is no new request, no new route, no stored metric and no figure about
 * anybody else's access. The log lives in the page's memory only: a reload
 * starts it again. Counts inside the knowledge service (index size, items per
 * collection, ingestion, retrieval quality, content health, items over time)
 * never reach the core, so this model has nothing to say about them and the
 * panel says so instead of estimating.
 */
import {
  answerOutcome, type KnowledgeAnswer, type KnowledgeCoverage, type KnowledgeFailure, type KnowledgeSource,
} from './knowledgeModel';

/** One search run on the page: the answer the core returned, or its failure. */
export type KnowledgeSearchRecord =
  | { kind: 'answer'; answer: KnowledgeAnswer }
  | { kind: 'failed'; failure: KnowledgeFailure };

/** The page keeps at most this many searches; older ones fall off the front. */
export const KNOWLEDGE_STATUS_LOG_LIMIT = 200;

/** Append one search to the page's log, keeping the newest LOG_LIMIT. */
export function appendSearchRecord(log: KnowledgeSearchRecord[], record: KnowledgeSearchRecord): KnowledgeSearchRecord[] {
  const next = [...log, record];
  return next.length > KNOWLEDGE_STATUS_LOG_LIMIT ? next.slice(next.length - KNOWLEDGE_STATUS_LOG_LIMIT) : next;
}

/** How one source took part in one search, from that answer's coverage alone. */
export type SourceTurnKind =
  | 'answered' | 'partial' | 'timedOut' | 'unavailable' | 'refusedBySource' | 'refusedByPolicy' | 'skipped';

export interface SourceTurn {
  kind: SourceTurnKind;
  /** The source's results in this answer. */
  results: number;
  /** The reason the core gave (an unavailable reason, a skip reason, partial reasons). */
  detail?: string;
}

/** One source of the caller's set, as the panel describes it. */
export interface SourceStatus {
  id: string;
  label: string;
  /** True for the board's own source, which the core answers in process. */
  inProcess: boolean;
  /** Absent when the source is not in the caller's current set (it answered an earlier search). */
  listed: boolean;
  protocolVersion: number;
  /** null when the source declares no categories (every v1 source). */
  categories: number | null;
  /** Searches that consulted this source. */
  searched: number;
  answeredInFull: number;
  answeredInPart: number;
  /** Consulted, and timed out, unavailable or refused. */
  didNotAnswer: number;
  /** Not searched because the selection did not apply to it. */
  skipped: number;
  results: number;
  /** The newest and oldest `updatedAt` among this source's results, as ISO strings. */
  newest: string | null;
  oldest: string | null;
  /** Results that carried no usable `updatedAt`. */
  undated: number;
  /** The source's part in the most recent search that named it. */
  last: SourceTurn | null;
}

export interface KnowledgeStatusSummary {
  sourcesListed: number;
  searches: number;
  completeAnswers: number;
  partialAnswers: number;
  /** Answers where no consulted source answered, or nothing was searched. */
  emptyAnswers: number;
  /** Searches the core refused or could not answer at all. */
  failedSearches: number;
  resultsShown: number;
  sources: SourceStatus[];
}

const list = <T,>(value: T[] | undefined | null): T[] => (Array.isArray(value) ? value : []);

/** The turn of every source an answer names, keyed by source id. */
export function sourceTurns(answer: KnowledgeAnswer): Map<string, SourceTurn> {
  const cov: Partial<KnowledgeCoverage> = answer.coverage ?? {};
  const turns = new Map<string, SourceTurn>();
  const results = new Map<string, number>();
  for (const group of list(answer.groups)) {
    results.set(group.sourceId, (results.get(group.sourceId) ?? 0) + list(group.results).length);
  }
  const put = (id: string, kind: SourceTurnKind, detail?: string) => {
    turns.set(id, { kind, results: results.get(id) ?? 0, ...(detail ? { detail } : {}) });
  };
  for (const entry of list(cov.skipped)) put(entry.id, 'skipped', entry.reason);
  const partial = new Map(list(cov.partialSources).map((entry) => [entry.id, list(entry.reasons)]));
  const truncated = new Set(list(cov.truncatedResults));
  const invalid = new Set(list(cov.invalidResults));
  for (const id of list(cov.answered)) {
    const reasons = [...(partial.get(id) ?? [])];
    if (truncated.has(id)) reasons.push('results truncated');
    if (invalid.has(id)) reasons.push('invalid results omitted');
    if (reasons.length) put(id, 'partial', reasons.join(', '));
    else put(id, 'answered');
  }
  for (const id of list(cov.timedOut)) put(id, 'timedOut');
  for (const entry of list(cov.unavailable)) put(entry.id, 'unavailable', entry.reason);
  for (const id of list(cov.refusedBySource)) put(id, 'refusedBySource');
  for (const id of list(cov.refusedByPolicy)) put(id, 'refusedByPolicy');
  return turns;
}

function validInstant(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * The panel's figures: one row per source in the caller's current set, in the
 * order the core listed them, then any source an earlier answer named that is
 * no longer listed (the caller's access changed since). Nothing is counted for
 * a source neither the list nor an answer named.
 */
export function summarizeKnowledgeStatus(
  sources: KnowledgeSource[],
  log: KnowledgeSearchRecord[],
  label: (id: string) => string,
): KnowledgeStatusSummary {
  const rows = new Map<string, SourceStatus>();
  const row = (id: string, listed: boolean, source?: KnowledgeSource): SourceStatus => {
    const existing = rows.get(id);
    if (existing) return existing;
    const created: SourceStatus = {
      id, label: source?.name ?? label(id), listed,
      inProcess: (source as { inProcess?: unknown } | undefined)?.inProcess === true,
      protocolVersion: source?.protocol_version === 2 ? 2 : 1,
      categories: source && Array.isArray(source.categories) && source.categories.length ? source.categories.length : null,
      searched: 0, answeredInFull: 0, answeredInPart: 0, didNotAnswer: 0, skipped: 0, results: 0,
      newest: null, oldest: null, undated: 0, last: null,
    };
    rows.set(id, created);
    return created;
  };
  for (const source of sources) row(source.id, true, source);

  const summary: KnowledgeStatusSummary = {
    sourcesListed: sources.length, searches: log.length, completeAnswers: 0, partialAnswers: 0, emptyAnswers: 0,
    failedSearches: 0, resultsShown: 0, sources: [],
  };
  const newest = new Map<string, number>();
  const oldest = new Map<string, number>();
  for (const record of log) {
    if (record.kind === 'failed') { summary.failedSearches += 1; continue; }
    const answer = record.answer;
    const cov: Partial<KnowledgeCoverage> = answer.coverage ?? {};
    const outcome = answerOutcome({
      timedOut: [], unavailable: [], refusedBySource: [], refusedByPolicy: [], skipped: [], ...cov,
      consulted: list(cov.consulted), answered: list(cov.answered),
      truncatedResults: list(cov.truncatedResults), invalidResults: list(cov.invalidResults),
    });
    if (outcome === 'complete') summary.completeAnswers += 1;
    else if (outcome === 'partial') summary.partialAnswers += 1;
    else summary.emptyAnswers += 1;
    for (const [id, turn] of sourceTurns(answer)) {
      const status = row(id, false);
      status.last = turn;
      if (turn.kind === 'skipped') { status.skipped += 1; continue; }
      status.searched += 1;
      if (turn.kind === 'answered') status.answeredInFull += 1;
      else if (turn.kind === 'partial') status.answeredInPart += 1;
      else status.didNotAnswer += 1;
    }
    for (const group of list(answer.groups)) {
      const status = row(group.sourceId, false);
      for (const hit of list(group.results)) {
        status.results += 1;
        summary.resultsShown += 1;
        const at = validInstant(hit.updatedAt);
        if (at === null) { status.undated += 1; continue; }
        if (!newest.has(group.sourceId) || at > newest.get(group.sourceId)!) newest.set(group.sourceId, at);
        if (!oldest.has(group.sourceId) || at < oldest.get(group.sourceId)!) oldest.set(group.sourceId, at);
      }
    }
  }
  for (const status of rows.values()) {
    const top = newest.get(status.id), bottom = oldest.get(status.id);
    status.newest = top === undefined ? null : new Date(top).toISOString();
    status.oldest = bottom === undefined ? null : new Date(bottom).toISOString();
  }
  summary.sources = [...rows.values()];
  return summary;
}

const SKIP_REASON: Record<string, string> = {
  kinds: 'it holds none of the selected content kinds',
  categories: 'none of the selected categories apply',
  'unsupported-selector': 'it does not support this selection',
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The source's part in the most recent search that named it, in words. */
export function lastTurnText(turn: SourceTurn | null): string {
  if (!turn) return 'Not searched on this page yet.';
  switch (turn.kind) {
    case 'answered': return `Answered in full with ${plural(turn.results, 'result', 'results')}.`;
    case 'partial': return `Answered in part (${turn.detail}) with ${plural(turn.results, 'result', 'results')}.`;
    case 'timedOut': return 'Timed out.';
    case 'unavailable': return `Unavailable${turn.detail ? ` (${turn.detail})` : ''}.`;
    case 'refusedBySource': return 'Refused by the source.';
    case 'refusedByPolicy': return 'Refused by policy.';
    case 'skipped': return `Not searched: ${SKIP_REASON[turn.detail ?? ''] ?? turn.detail ?? 'the selection did not apply'}.`;
  }
}

/** How often the source was searched on this page, and how it answered. */
export function searchedText(status: SourceStatus): string {
  const skipped = status.skipped ? `; not searched ${plural(status.skipped, 'time', 'times')} because the selection did not apply` : '';
  if (!status.searched) return status.skipped ? `Never searched${skipped}.` : 'Not searched on this page yet.';
  return `Searched ${plural(status.searched, 'time', 'times')}: ${status.answeredInFull} answered in full, `
    + `${status.answeredInPart} in part, ${status.didNotAnswer} did not answer${skipped}.`;
}
