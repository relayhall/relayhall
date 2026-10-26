/**
 * THE KNOWLEDGE SEARCH CONSOLE'S READ MODEL (card 1fd5de08, line 1).
 *
 * Every value on the console comes from the governed routes the MCP tools
 * use: `POST /knowledge-queries` (relayhall_knowledge_source_search) and
 * `GET /knowledge-contents` (relayhall_knowledge_source_get), plus the
 * caller's queryable set from `GET /knowledge-sources`. The core decides what
 * the caller may see and filters it before it answers; nothing here removes,
 * adds or reorders a result. The helpers below only DESCRIBE what the core
 * already returned: the explain view and the coverage lines are made from the
 * fields of the answer, never from a second request or a hidden field.
 */

export type KnowledgeCompartment = string | { id: string; label?: string };

/** One entry of `GET /knowledge-sources`: a source this caller may query. */
export interface KnowledgeSource {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  categories?: string[];
  compartments?: string[];
  compartment_mode?: string;
  protocol_version?: number;
  claimsMode: string;
}

/** One result as it leaves the core: the reference is a sealed handle. */
export interface KnowledgeHit {
  handle: string;
  title: string;
  snippet: string;
  contentKind: string;
  category?: string;
  compartment: KnowledgeCompartment;
  score?: number;
  updatedAt?: string;
  parentHandle?: string;
}

export interface KnowledgeGroup {
  sourceId: string;
  sourceSlug: string;
  results: KnowledgeHit[];
}

export interface KnowledgeCoverage {
  consulted: string[];
  answered: string[];
  timedOut: string[];
  unavailable: { id: string; reason?: string; retryAfterSeconds?: number }[];
  refusedBySource: string[];
  refusedByPolicy: string[];
  skipped: { id: string; reason: string }[];
  partialSources?: { id: string; reasons: string[] }[];
  truncatedResults: string[];
  invalidResults: string[];
  searchedCategories?: { id: string; categories: string[] | 'all' }[];
  archive?: { included: boolean; declaredBy?: string[] };
}

export interface KnowledgeAnswer {
  coverage: KnowledgeCoverage;
  groups: KnowledgeGroup[];
  auditRef: string;
}

/** `GET /knowledge-contents`: one byte window of a cited revision. */
export interface KnowledgeContent {
  content?: string;
  content_base64?: string;
  continuation?: string;
  sha256?: string;
  offset?: number;
  totalBytes?: number;
  byteLength?: number;
  truncated?: boolean;
  notModified?: boolean;
  provenance?: { sourceId?: string; compartment?: KnowledgeCompartment; contentKind?: string; category?: string };
  /** A v1 (legacy) answer names its compartment here, with no provenance block. */
  compartment?: string;
  retrieval?: { status: string; reasons: string[] };
  auditRef?: string;
}

/** A compartment as people read it: its label, with the id when both exist. */
export function compartmentText(compartment: KnowledgeCompartment | undefined): string {
  if (compartment === undefined) return '';
  if (typeof compartment === 'string') return compartment;
  return compartment.label ? `${compartment.label} (${compartment.id})` : compartment.id;
}

/** The compartments a source declares, as the scope selector describes them. */
export function sourceCompartmentsText(source: KnowledgeSource): string {
  if (source.compartment_mode === 'dynamic-opaque') return 'Compartments: set per item by the source';
  const declared = source.compartments ?? [];
  return declared.length ? `Compartments: ${declared.join(', ')}` : 'Compartments: none declared';
}

/** The score as a fixed two-place figure, or a plain "not reported". */
export function scoreText(score: number | undefined): string {
  return typeof score === 'number' && Number.isFinite(score) ? score.toFixed(2) : 'not reported';
}

/**
 * The distinct words of a query, lower-cased, two characters or longer. Used
 * only to point at the words of the caller's OWN query that appear in the
 * title or snippet the core returned.
 */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
  return [...new Set(words)];
}

export interface ExplainRow {
  term: string;
  detail: string;
}

export interface ExplainInput {
  hit: KnowledgeHit;
  /** 1-based position in the source's own list. */
  rank: number;
  groupSize: number;
  sourceId: string;
  sourceLabel: string;
  coverage: KnowledgeCoverage;
  query: string;
  formatInstant: (value: string) => string;
}

/**
 * WHY THIS RESULT IS HERE, from the fields the core already returned.
 *
 * The score and the order are the SOURCE's: the core clamps a score to 0..1,
 * keeps each source's own order and never reranks across sources. What the
 * source searched (its categories, the archive) is the core's coverage
 * record. The "your words" line compares the caller's own query with the
 * title and snippet on screen; it claims nothing about text it cannot see.
 */
export function explainHit(input: ExplainInput): ExplainRow[] {
  const { hit, coverage } = input;
  const rows: ExplainRow[] = [];
  rows.push({ term: 'Source', detail: `${input.sourceLabel} answered this search.` });
  rows.push({
    term: 'Score',
    detail: typeof hit.score === 'number'
      ? `${scoreText(hit.score)} of 1.00, as the source ranked it. The core keeps every score between 0 and 1 and never reranks across sources.`
      : 'The source reported no score.',
  });
  rows.push({ term: 'Position', detail: `${input.rank} of ${input.groupSize} from this source, in the source's own order.` });
  const haystack = `${hit.title}\n${hit.snippet}`.toLowerCase();
  const found = queryTerms(input.query).filter((term) => haystack.includes(term));
  rows.push({
    term: 'Your words',
    detail: found.length
      ? `Found in the title or snippet: ${found.map((term) => `"${term}"`).join(', ')}.`
      : 'None of your words appear in the title or snippet; the source matched on text the snippet does not show.',
  });
  rows.push({ term: 'Content kind', detail: hit.contentKind });
  const searched = coverage.searchedCategories?.find((entry) => entry.id === input.sourceId)?.categories;
  const searchedText = searched === undefined
    ? ''
    : searched === 'all' ? ' The source searched all of its categories.' : ` The source searched: ${searched.join(', ')}.`;
  rows.push({ term: 'Category', detail: `${hit.category ?? 'None reported'}.${searchedText}` });
  rows.push({ term: 'Compartment', detail: compartmentText(hit.compartment) });
  if (hit.updatedAt) rows.push({ term: 'Updated', detail: input.formatInstant(hit.updatedAt) });
  if (coverage.archive?.declaredBy?.includes(input.sourceId)) {
    rows.push({
      term: 'Archive',
      detail: coverage.archive.included ? 'This search included the archive.' : 'This search left the archive out.',
    });
  }
  if (hit.parentHandle) rows.push({ term: 'Part of', detail: 'A section of a larger item. The reader opens this section.' });
  return rows;
}

export type SourceStateKind =
  | 'partial' | 'timedOut' | 'unavailable' | 'refusedBySource' | 'refusedByPolicy' | 'skipped';

export interface SourceState {
  id: string;
  kind: SourceStateKind;
  text: string;
}

function unavailableText(entry: KnowledgeCoverage['unavailable'][number]): string {
  const retry = typeof entry.retryAfterSeconds === 'number' ? `, try again in ${entry.retryAfterSeconds} s` : '';
  if (entry.reason === 'transport') return `unavailable (transport: the core could not reach this source)${retry}; this answer is incomplete.`;
  if (entry.reason === 'rate-limited') return `unavailable (rate-limited: the source is refusing more requests for now)${retry}; this answer is incomplete.`;
  return `unavailable${entry.reason ? ` (${entry.reason})` : ''}${retry}; this answer is incomplete.`;
}

const SKIP_TEXT: Record<string, string> = {
  kinds: 'not searched (it holds none of the selected content kinds).',
  categories: 'not searched (none of the selected categories apply, or all of its categories are archive).',
  'unsupported-selector': 'not searched (it does not support this selection).',
};

/**
 * Every source that did NOT give a complete answer, with what happened, in
 * the core's words. Each consulted source lands in exactly one outcome
 * bucket; a partial answer is an answered source with reasons.
 */
export function sourceStates(coverage: KnowledgeCoverage, label: (id: string) => string): SourceState[] {
  const states: SourceState[] = [];
  for (const entry of coverage.skipped) {
    states.push({ id: entry.id, kind: 'skipped', text: `${label(entry.id)}: ${SKIP_TEXT[entry.reason] ?? `not searched (${entry.reason}).`}` });
  }
  for (const id of coverage.timedOut) states.push({ id, kind: 'timedOut', text: `${label(id)}: timed out; this answer is incomplete.` });
  for (const entry of coverage.unavailable) states.push({ id: entry.id, kind: 'unavailable', text: `${label(entry.id)}: ${unavailableText(entry)}` });
  for (const id of coverage.refusedBySource) states.push({ id, kind: 'refusedBySource', text: `${label(id)}: refused by the source; this answer is incomplete.` });
  for (const id of coverage.refusedByPolicy) states.push({ id, kind: 'refusedByPolicy', text: `${label(id)}: refused by policy; this answer is incomplete.` });
  for (const entry of coverage.partialSources ?? []) states.push({ id: entry.id, kind: 'partial', text: `${label(entry.id)}: partial (${entry.reasons.join(', ')})` });
  return states;
}

export type AnswerOutcome = 'complete' | 'partial' | 'none-answered' | 'nothing-searched';

/** The verdict on an answer, from its coverage record alone. */
export function answerOutcome(coverage: KnowledgeCoverage): AnswerOutcome {
  if (coverage.consulted.length === 0) return 'nothing-searched';
  if (coverage.answered.length === 0) return 'none-answered';
  const degraded = coverage.answered.length < coverage.consulted.length
    || (coverage.partialSources?.length ?? 0) > 0
    || coverage.truncatedResults.length > 0
    || coverage.invalidResults.length > 0;
  return degraded ? 'partial' : 'complete';
}

export const OUTCOME_TEXT: Record<AnswerOutcome, string> = {
  complete: 'Complete: every source searched answered in full.',
  partial: 'Partial: some sources did not answer in full, so results may be missing.',
  'none-answered': 'No source answered. This is not the same as "nothing found".',
  'nothing-searched': 'No source was searched with this selection.',
};

/** What an empty result list means, honestly, for this coverage record. */
export function emptyAnswerText(coverage: KnowledgeCoverage): string {
  const outcome = answerOutcome(coverage);
  if (outcome === 'complete') return 'No matching results in the sources you can read.';
  if (outcome === 'nothing-searched') return 'No results: no source was searched. Widen the selection and search again.';
  if (outcome === 'none-answered') return 'No results, because no source answered. Try again later.';
  return 'No results so far, but this answer is incomplete: some sources did not answer in full.';
}

/**
 * HOW A KNOWLEDGE REQUEST FAILED, mapped ONCE for the reader and the console.
 *
 * Every code below is one the core answers on the three knowledge routes:
 *  - the get executor's refusal tokens. A v2 answer carries them as `code`,
 *    with the two ACCESS tokens (`not_authorized`, `source_refused`)
 *    collapsed to `refused`; a v1 answer, or a handle that never unsealed,
 *    carries the token as `refused` alone;
 *  - the search route's caller-input codes (a query, kinds, sources, limit or
 *    timeout out of bounds, a selector the contract refuses, a selection too
 *    broad), which name the caller's own input and so are shown as the core
 *    words them;
 *  - the codes the middleware in front of every route answers with: the scope
 *    ceiling (`FORBIDDEN`), a credential pinned to another transport, a
 *    concealed surface (`RESOURCE_NOT_FOUND`), the rate limit and the two
 *    fail-closed services of the session and delegation checks.
 *
 * ACCESS refusals keep the core's concealment: ONE sentence that names no
 * cause, because the core gives the same answer for "no access", "no such
 * item" and a source that refused. Every other code is NOT an access
 * statement and is never shown as one: a source that is unavailable for now,
 * a source answer the core could not read, a link that is no longer valid,
 * content that changed between windows. A code this table does not know is a
 * generic failure with Retry, never the access sentence.
 */
export type KnowledgeFailureKind =
  | 'access' | 'unavailable' | 'invalidAnswer' | 'staleLink' | 'changed' | 'request' | 'failed';

/** Where the failure is shown: the reader (one item) or the search console. */
export type KnowledgeSurface = 'read' | 'search';

export interface KnowledgeFailure {
  kind: KnowledgeFailureKind;
  text: string;
  /** Whether asking again unchanged can succeed. */
  retry: boolean;
  auditRef?: string;
}

const ACCESS_CODES: ReadonlySet<string> = new Set([
  'refused', 'not_authorized', 'source_refused', 'FORBIDDEN', 'TRANSPORT_MISMATCH', 'RESOURCE_NOT_FOUND',
]);
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'source_unavailable', 'source_timed_out', 'transport',
  'RATE_LIMITED', 'SESSION_AUTH_UNAVAILABLE', 'DELEGATION_EVALUATOR_FAILED',
]);
const INVALID_ANSWER_CODES: ReadonlySet<string> = new Set(['source_protocol_error', 'source_response_invalid']);
const STALE_LINK_CODES: ReadonlySet<string> = new Set([
  'handle_malformed', 'handle_tampered', 'handle_key_retired', 'handle_key_unknown', 'handle_version_unsupported',
  'invalid_continuation', 'continuation_without_content_hash',
]);
const REQUEST_CODES: ReadonlySet<string> = new Set([
  'KNOWLEDGE_QUERY_INVALID', 'KNOWLEDGE_KINDS_INVALID', 'KNOWLEDGE_SOURCES_INVALID', 'KNOWLEDGE_LIMIT_INVALID',
  'KNOWLEDGE_TIMEOUT_INVALID', 'INVALID_SELECTOR', 'SOURCE_SELECTION_TOO_BROAD',
]);

const ACCESS_TEXT: Record<KnowledgeSurface, string> = {
  read: 'This item cannot be opened for you. It may have changed or moved, or your access may have changed: the core checks your access again on every read.',
  search: 'Knowledge search is not available to you. Your access may have changed: the core checks your access again on every request.',
};
const SERVICE_UNAVAILABLE_TEXT = 'The knowledge service is unavailable right now. Try again.';
const UNAVAILABLE_TEXT: Record<KnowledgeSurface, string> = {
  read: 'The source is unavailable right now. Try again.',
  search: SERVICE_UNAVAILABLE_TEXT,
};
const INVALID_ANSWER_TEXT = 'The source answered with something that could not be read.';
const STALE_LINK_TEXT = 'This link to the item is no longer valid. Search again.';
const CHANGED_TEXT = 'This item changed since its first window was read. Open it again from the results.';
const FAILED_TEXT = 'Something went wrong and nothing was shown. Try again.';

/**
 * The audit reference of a refusal, in either form the core mints: `ka_` and
 * 32 hex digits (a search's ledger row) or a UUID (a v2 read's receipt).
 * Anything else is not a reference and is not shown.
 */
const AUDIT_REF_PATTERN = /^(?:ka_[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function auditRefOf(body: unknown): string | undefined {
  const value = body && typeof body === 'object' ? (body as { auditRef?: unknown }).auditRef : undefined;
  return typeof value === 'string' && AUDIT_REF_PATTERN.test(value) ? value : undefined;
}

/** The core's own words for a caller-input refusal, which name only that input. */
function requestText(body: Record<string, unknown>): string {
  if (typeof body.message === 'string' && body.message) return body.message;
  if (typeof body.error === 'string' && body.error) return body.error;
  return 'The knowledge request was not accepted.';
}

/** A request that got no readable answer at all: a dropped connection, a proxy page. */
export function unreachableFailure(): KnowledgeFailure {
  return { kind: 'unavailable', text: SERVICE_UNAVAILABLE_TEXT, retry: true };
}

/** One answer that is not a success, as the reader or the console shows it. */
export function classifyKnowledgeFailure(status: number, body: unknown, surface: KnowledgeSurface): KnowledgeFailure {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const code = typeof record.code === 'string' ? record.code : typeof record.refused === 'string' ? record.refused : undefined;
  const auditRef = auditRefOf(record);
  const make = (kind: KnowledgeFailureKind, text: string, retry: boolean): KnowledgeFailure =>
    ({ kind, text, retry, ...(auditRef ? { auditRef } : {}) });
  if (code !== undefined) {
    if (ACCESS_CODES.has(code)) return make('access', ACCESS_TEXT[surface], false);
    if (TRANSIENT_CODES.has(code)) return make('unavailable', UNAVAILABLE_TEXT[surface], true);
    if (INVALID_ANSWER_CODES.has(code)) return make('invalidAnswer', INVALID_ANSWER_TEXT, true);
    if (STALE_LINK_CODES.has(code)) return make('staleLink', STALE_LINK_TEXT, false);
    if (code === 'content_changed') return make('changed', CHANGED_TEXT, false);
    if (REQUEST_CODES.has(code)) return make('request', requestText(record), false);
  } else if (status === 429 || status === 502 || status === 503 || status === 504) {
    return make('unavailable', UNAVAILABLE_TEXT[surface], true);
  } else if (status === 400 || status === 422) {
    return make('request', requestText(record), false);
  }
  return make('failed', FAILED_TEXT, true);
}

/** A failure as one line of text, with its audit reference when it has one. */
export function failureMessage(failure: KnowledgeFailure): string {
  return failure.auditRef ? `${failure.text} Audit reference: ${failure.auditRef}` : failure.text;
}

/** Decode a base64 byte window as UTF-8 text, or say it is binary. */
export function decodeWindow(content: KnowledgeContent): { text: string; binary: boolean } {
  if (content.content !== undefined) return { text: content.content, binary: false };
  if (content.content_base64 === undefined) return { text: '', binary: false };
  try {
    const bytes = Uint8Array.from(atob(content.content_base64), (c) => c.charCodeAt(0));
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), binary: false };
  } catch {
    return { text: 'Binary byte window. Use the API or the CLI for byte-exact retrieval.', binary: true };
  }
}
