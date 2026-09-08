/**
 * KnowledgeFanoutExecutor.ts — RH-KW1 candidate C (card `0b4b779b`).
 *
 * §5.5's fan-out set and §7's merged response: the search leg of the
 * knowledge plane, and the only place a knowledge query becomes outbound
 * traffic.
 *
 * ── THE FAN-OUT PREDICATE, LIMB BY LIMB (§5.5) ──
 *
 * "A source is consulted iff ALL hold: (a) knowledge-configured; (b) visible
 * to the caller under the shared predicate; (c) inside the caller's
 * `knowledge-contents:read` selector; (d) declared `classes[].content`
 * intersects the request's `kinds` (`mixed` matches all); AND (e) not
 * excluded by the request's optional `sources[]` narrowing."
 *
 * Each limb below is a REAL conjunct evaluated at its own named point, in
 * that order, and the two DIFFERENT dispositions are kept apart exactly as
 * the design keeps them apart:
 *
 *   • (a), (b), (c) and (e) — UNDISCLOSED ABSOLUTELY. "never dialed, never in
 *     coverage, ids naming them in `sources[]` silently ignored
 *     (byte-identical to unknown ids; gateway 404-conceal parity)". A caller
 *     cannot tell a source it may not see from a source that does not exist,
 *     which is acceptance item 10's oracle-resistance clause.
 *   • (d) — NAMED IN `coverage.skipped` with reason `kinds`. The source is
 *     already disclosed to this caller by (a)–(c), so saying "your query
 *     asked for kinds this source does not carry" discloses nothing new, and
 *     hiding it would make coverage dishonest.
 *
 * ── `consulted` IS THE FINAL SET, NOT THE SELECTED SET (sol R1-4) ──
 *
 * "`consulted` = the FINAL set that survived the §5.2 signing-time
 * re-evaluation (for `none`-mode and board sources, selection and finality
 * coincide) — a candidate whose arm fails between selection and signing is
 * silently absent, identical to never-selected."
 *
 * So an `asserted` source whose arm set turns false in the milliseconds
 * between selection and signing is dropped from the record ENTIRELY: not
 * `refusedByPolicy`, not `skipped`, absent. Acceptance item 8's last clause
 * drills exactly that, and the drop is byte-identical to a source the caller
 * never had.
 *
 * The FINAL set is therefore decided at ONE moment — ADMISSION, below — and
 * that moment is before any budget, worker or record exists. The owner default
 * on Q-S3 states the rule this file is built around: ONE SIGNING PER ASSERTED
 * SOURCE ADMITTED TO THE FINAL SET; a source's arm evaluation and its signer
 * result are both established before the count is frozen, and nothing is
 * re-evaluated after. There is no second membership decision anywhere below.
 *
 * ── WHAT NEVER GOES ON THE WIRE ──
 *
 * `kinds` is a CORE routing arm and is NOT sent (§5.5, §7.2). The caller's
 * credential never leaves core (§5.4). A source receives `{ q, limit,
 * assertion? }` and nothing else — no other source's anything, no foreign
 * refs, no group ids beyond the §5.3 minimization the signer applies.
 */
import type { AuthRequest } from '../middleware/auth';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { filterAuthorizedResources, actorFromRequest } from '../middleware/sharedAuthorization';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { pool } from '../db/connection';
import { ROOT_SCOPE } from '../utils/scopeMap';
import {
  KNOWLEDGE_CONTENT_KINDS,
  type KnowledgeContentKind,
  type ServiceDescriptor,
} from '../utils/serviceDescriptor';
import { isKnowledgeCapable, KNOWLEDGE_BOARD_SOURCE_SLUG } from './KnowledgeSourcePolicy';
import {
  evaluateKnowledgeArms,
  isBoardSource,
  type KnowledgeSourceArmRow,
} from './KnowledgeArmEvaluator';
import { signKnowledgeAssertion } from './KnowledgeAssertionSigner';
import { dialKnowledgeSource } from './KnowledgeDialClient';
import { resolveChannelCredential, channelAuthDialOptions } from './KnowledgeChannelAuth';
import { sealKnowledgeHandle } from './KnowledgeHandleSealer';
import {
  KnowledgeCoverageBuilder,
  type KnowledgeCoverage,
} from './KnowledgeCoverage';
import {
  validateSourceResults,
  KNOWLEDGE_RESPONSE_MAX_BYTES,
  type ValidatedKnowledgeResult,
} from './KnowledgeResultValidator';
import { searchBoard, BOARD_COMPARTMENTS } from './KnowledgeBoardAdapter';
import {
  recordKnowledgeSearch,
  newKnowledgeAuditRef,
  type KnowledgeFanoutAuditEntry,
} from './KnowledgeAuditService';
import {
  KNOWLEDGE_CANDIDATE_ROWS_MAX,
  KNOWLEDGE_LEDGER_MAX_MS,
  KNOWLEDGE_FANOUT_CONCURRENCY as FANOUT_CONCURRENCY,
} from './KnowledgeDeadline';
import { KnowledgeRequestClock } from './KnowledgeRequestClock';

/** §7.1's request bounds, restated as the constants the route validates with. */
export const KNOWLEDGE_QUERY_MAX_LENGTH = 1024;
export const KNOWLEDGE_SOURCES_NARROWING_CAP = 16;
export const KNOWLEDGE_LIMIT_PER_SOURCE_MIN = 1;
export const KNOWLEDGE_LIMIT_PER_SOURCE_MAX = 25;
export const KNOWLEDGE_LIMIT_PER_SOURCE_DEFAULT = 8;
export const KNOWLEDGE_TIMEOUT_MS_MIN = 500;
export const KNOWLEDGE_TIMEOUT_MS_MAX = 8000;
export const KNOWLEDGE_TIMEOUT_MS_DEFAULT = 3000;
// §7.1's whole-request deadline lives in its own module, so a control can
// watch which COUNT the executor computes it from — see KnowledgeDeadline.ts.
export {
  KNOWLEDGE_WHOLE_REQUEST_MAX_MS,
  KNOWLEDGE_ADMISSION_MAX_MS,
  KNOWLEDGE_LEDGER_MAX_MS,
  KNOWLEDGE_CANDIDATE_ROWS_MAX,
  KNOWLEDGE_FANOUT_CONCURRENCY,
} from './KnowledgeDeadline';

/**
 * §7.4's fixed order. "for a default all-kinds request the order is `code`,
 * `docs`, `data`, `mixed` then source-slug lexical" — and declaring `mixed`
 * cannot buy position, which is why `mixed` sorts LAST rather than matching
 * whichever bucket would rank it highest.
 */
const DEFAULT_KIND_PRIORITY: readonly KnowledgeContentKind[] = ['code', 'docs', 'data', 'mixed'];

/**
 * §7.4's config seat, read at call time so a deployment can reorder without a
 * code change. An entry that is not a ratified kind is ignored; kinds the
 * seat omits keep their default relative order after the ones it names.
 */
export function kindPriority(env: NodeJS.ProcessEnv = process.env): readonly KnowledgeContentKind[] {
  const raw = env.RELAYHALL_KNOWLEDGE_KIND_PRIORITY;
  if (!raw) return DEFAULT_KIND_PRIORITY;
  const named = raw.split(',').map((value) => value.trim())
    .filter((value): value is KnowledgeContentKind =>
      (KNOWLEDGE_CONTENT_KINDS as readonly string[]).includes(value));
  return [...named, ...DEFAULT_KIND_PRIORITY.filter((kind) => !named.includes(kind))];
}

export interface KnowledgeQueryRequest {
  q: string;
  kinds: readonly KnowledgeContentKind[];
  /** §7.1's narrowing-only `sources[]`, already deduplicated and capped. */
  sources?: readonly string[];
  limitPerSource: number;
  timeoutMs: number;
}

export interface KnowledgeGroup {
  sourceId: string;
  sourceSlug: string;
  results: KnowledgeEmittedResult[];
}

/**
 * A result as it LEAVES core: `ref` and `parentRef` replaced by sealed
 * handles (§7.6 — "never emitted raw, only inside a SEALED handle").
 */
export interface KnowledgeEmittedResult {
  handle: string;
  title: string;
  snippet: string;
  contentKind: KnowledgeContentKind;
  compartment: string;
  score: number;
  updatedAt?: string;
  parentHandle?: string;
}

export interface KnowledgeQueryResponse {
  coverage: KnowledgeCoverage;
  groups: KnowledgeGroup[];
  auditRef: string;
}

export interface KnowledgeQueryOptions {
  /** §5.2 `iss`, derived from the deployment's own board endpoint. */
  issuer: string;
  callerGroupIds?: readonly string[];
  /** TEST-ONLY (owner decision D7(a)); forwarded to the dial client's guard. */
  trustAnchors?: string | string[];
}

interface SourceRow extends KnowledgeSourceArmRow {
  name: string;
  knowledge_get_endpoint: string | null;
  knowledge_allowed_networks: string[] | null;
  knowledge_core_credential_ref: string | null;
  current_descriptor_version: number | null;
}

interface SelectedSource {
  row: SourceRow;
  classes: KnowledgeContentKind[];
  compartments: string[];
  descriptorVersion: number;
}

/**
 * A source ADMITTED to the final set: it holds everything it needs to be
 * dialed, and nothing about its membership is decided again.
 *
 * The owner default on Q-S3 is what this type is for. An `asserted` source is
 * admitted only after its §5.2 arm evaluation AND the one signing that
 * evaluation buys have both succeeded, so `assertion` is present for exactly
 * the asserted members and a leg has no reason to reach for the signer.
 */
interface AdmittedSource {
  readonly source: SelectedSource;
  /** Present iff the source is `asserted`. Signed ONCE, at admission. */
  readonly assertion?: string;
}

/** The per-source result of one leg, before it becomes coverage. */
type LegOutcome =
  | { kind: 'absent' }
  | { kind: 'answered'; results: ValidatedKnowledgeResult[]; invalid: boolean; truncated: boolean; assertionJti?: string }
  | { kind: 'timedOut' }
  | { kind: 'unavailable'; reason: 'transport' | 'rate-limited'; retryAfterSeconds?: number }
  | { kind: 'refusedBySource' }
  | { kind: 'refusedByPolicy' };

/** The `jti` of an assertion core just minted, for the audit row only. */
function assertionJti(compact: string): string | undefined {
  const segments = compact.split('.');
  if (segments.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as { jti?: unknown };
    return typeof claims.jti === 'string' ? claims.jti : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one knowledge query.
 *
 * The shape of this function is the acceptance shape: selection first and
 * whole, then the legs, then the coverage record, then the groups, then the
 * audit row. Nothing dials before selection is complete, and nothing is
 * rendered before coverage is built.
 */
export async function executeKnowledgeQuery(
  req: AuthRequest,
  request: KnowledgeQueryRequest,
  options: KnowledgeQueryOptions,
): Promise<KnowledgeQueryResponse> {
  // ── THE REQUEST'S CLOCK, CREATED ONCE, AND THE ONLY WAY THIS FILE WAITS ──
  //
  // Five review rounds found one defect at five coordinates because three
  // ad-hoc clocks each bounded one phase and nothing owned the request. The
  // dispatcher's ruling on `0ee4c4a5` (option (a)) is that the class ends only
  // when the clock has an OWNER: EVERY blocking await below — the selection
  // queries, each admission's arm evaluation and signing, the board leg, every
  // dial, the §7.7 ledger write — is raced through this object, so no leg can
  // outlive the request. `KnowledgeRequestClock.ts` carries the reasoning and
  // `KnowledgeDeadline.ts` the constants; the fan-out suite carries a census
  // that reads this file and fails on any awaited expression not in its frozen
  // set, which is what makes "nothing escapes the clock" checkable rather than
  // re-argued.
  const clock = new KnowledgeRequestClock();
  const actor = req.authorizationActor ?? actorFromRequest(req);
  const coverage = new KnowledgeCoverageBuilder();

  // ── LIMB (a) — knowledge-configured, decided by the ONE predicate ──
  //
  // Core's own questions about its own estate are bounded by PHASE 1's ceiling
  // and, unlike a source's failure, a failure here ENDS the request (§7.5 is
  // about a source failing, not about core being unable to decide who may be
  // asked). Round-5 finding F2 was exactly a PostgreSQL call with no deadline
  // on it, and these three are PostgreSQL calls.
  const rows = await clock.mustSettle(
    loadCandidateRows(), clock.admissionRemainingMs(), 'candidate load',
  );
  const capable: SelectedSource[] = [];
  for (const row of rows) {
    const block = row.descriptor?.knowledgeSource ?? null;
    if (!isKnowledgeCapable(
      { slug: row.slug, knowledgeQueryEndpoint: row.knowledge_query_endpoint },
      block,
    )) continue;
    capable.push({
      row,
      classes: (block?.classes ?? []).map((entry) => entry.content),
      compartments: block?.compartments ?? [...BOARD_COMPARTMENTS],
      descriptorVersion: row.current_descriptor_version ?? 1,
    });
  }

  // ── LIMB (b) — source visibility under the SHARED predicate ──
  const visible = new Set((await clock.mustSettle(
    filterAuthorizedResources(
      req,
      'read',
      capable,
      (source) => ({ type: 'service', id: source.row.id }),
    ),
    clock.admissionRemainingMs(),
    'source visibility',
  )).map((source) => source.row.id));

  // ── LIMB (c) — the A21 selector, for every caller but `root` ──
  //
  // Identical to `GET /knowledge-sources` (candidate A, terminal finding P2):
  // `root` is the A12.1 global sentinel and skips the selector; no ROLE is
  // exempt, administrators included.
  const holdsRoot = (actor.scopes ?? []).includes(ROOT_SCOPE);
  const covered = holdsRoot
    ? visible
    : await clock.mustSettle(
      authorizationRepository.selectorCoveredIds(actor, 'service', [...visible]),
      clock.admissionRemainingMs(),
      'selector coverage',
    );

  // ── LIMB (e) — the `sources[]` NARROWING, applied before (d) ──
  //
  // "narrowing-only, deduplicated, cap 16, out-of-set ids silently ignored".
  // Applied here, after (a)–(c), so an id naming a source the caller cannot
  // see behaves EXACTLY like an id naming nothing at all: both narrow the set
  // to the same thing and neither is reported.
  // PRESENCE, not length (round-1 finding P2). `sources` omitted means "every
  // source I may query"; `sources: []` means "these ones", of which there are
  // none. Reading an empty array as omission fanned the query out to the whole
  // set — the opposite of what a narrowing-only field can ever mean, and it
  // put the caller's text on wires the caller did not name.
  const narrowing = request.sources === undefined
    ? null
    : new Set(request.sources.map(String));

  const selected: SelectedSource[] = [];
  for (const source of capable) {
    if (!visible.has(source.row.id) || !covered.has(source.row.id)) continue;
    if (narrowing && !narrowing.has(source.row.id)) continue;

    // ── LIMB (d) — the class arm. Named in `skipped`, never concealed ──
    //
    // "`mixed` matches all": a source declaring `mixed` intersects every
    // request, which is why the check is on the SOURCE's side of the
    // intersection rather than a plain set membership.
    const intersects = source.classes.some((declared) =>
      declared === 'mixed' || request.kinds.includes(declared));
    if (!intersects) {
      coverage.markSkipped(source.row.id);
      continue;
    }
    selected.push(source);
  }

  // ── PHASE 1: ADMISSION — the evaluation AND the signing, before the count ──
  //
  // §5.5: "`consulted` = the FINAL set that survived the §5.2 signing-time
  // re-evaluation … a candidate whose arm fails between selection and signing
  // is silently absent, identical to never-selected."
  //
  // THREE ROUNDS MADE THIS SHAPE:
  //   • round-1 P1 — the deadline was computed from `selected`, so a source
  //     nobody was told about changed how much time the others had, and a slow
  //     survivor came back `answered` in one run and `timedOut` in the
  //     byte-identical run without them.
  //   • round 2 — PREPARE signed what PREPARE had evaluated, and an evaluation
  //     carried across a wave boundary is older than
  //     `ARM_EVALUATION_MAX_AGE_SECONDS` by the time it reaches the signer.
  //   • terminal P2 — the two repairs together STILL left a membership
  //     decision after the count was frozen: a source could pass PREPARE, fail
  //     its signing-time evaluation, and have already sized the deadline and
  //     occupied a worker while being absent from coverage, groups and audit.
  //
  // OWNER DEFAULT ON Q-S3 (dispatcher 2026-09-05, acceptance item 13's
  // observable): ONE SIGNING PER ASSERTED SOURCE ADMITTED TO THE FINAL SET.
  // Each asserted source's arm evaluation AND its signer result are
  // established HERE, before anything is frozen, and nothing is re-evaluated
  // afterwards. A source whose arms are false, whose evaluation cannot be
  // completed, or whom the signer refuses is EXCLUDED — no coverage, no group,
  // no audit line, indistinguishable from never-selected (§5.5). Membership is
  // decided once, in one place, before the budget exists; what a leg carries is
  // what admission signed.
  //
  // §7.5's "a failed source never fails the whole query" is STRUCTURAL here:
  // `runBounded` settles every item instead of propagating the first
  // rejection, so one source's evaluator or signer throwing is one source's
  // exclusion and never the request's end (terminal finding P1).
  //
  // ADMISSION IS BOUNDED (round-4 finding F1). Moving the evaluation and the
  // signing ahead of the count moved them out from under the only clock the
  // fan-out had, and an evaluator or signer that never settles kept the whole
  // query pending — "starting a clock does not enforce a deadline". Each
  // source's admission now gets §7.1's per-source budget, floored at what is
  // left of the absolute ceiling, so the phase terminates whatever happens
  // below it. A source that does not settle inside its budget is EXCLUDED, on
  // the same terms as one whose arms are false: core did not establish its
  // authority.
  // ADMISSION STOPS DEQUEUING AT ITS CEILING (round-5 finding F1). The
  // previous repair gave each source a budget floored at what was left of the
  // ceiling, which bounds one source and not the PHASE: past the ceiling every
  // remaining candidate was still launched with a 1 ms timer, so the phase grew
  // with the candidate count and 4 000 hung admissions ran 21 493 ms against a
  // 20 000 ms ceiling. The bound is now at the QUEUE: once the ceiling is
  // reached the workers stop dequeuing, whatever is left of the list. A
  // candidate the phase never reached is not admitted, and §5.5 makes that
  // indistinguishable from never-selected — the fail-closed direction, and the
  // reason this is a cardinality-INDEPENDENT bound rather than a smaller one.
  const admissions = await runBounded(
    selected,
    FANOUT_CONCURRENCY,
    (source) => admit(req, source, options, clock, request.timeoutMs),
    () => !clock.admissionOpen(),
  );
  const admitted: AdmittedSource[] = [];
  for (const admission of admissions) {
    // NEVER DEQUEUED: the ceiling arrived first. No log — there is nothing to
    // report about a candidate core never asked about — and no bucket.
    if (admission === undefined) continue;
    if (!admission.ok) {
      // ONE source's admission failed. Logged secret-safely for the operator
      // and invisible to the caller: core could not establish this source's
      // authority, and §5.5 gives that state silence rather than a bucket.
      logCaughtFailure('admit knowledge source', admission.error);
      continue;
    }
    if (admission.value) admitted.push(admission.value);
  }

  // ── PHASE 2: THE LEGS ──
  //
  // The whole-request deadline is §7.1's: `min(20000, timeoutMs ×
  // ceil(N/concurrency))`, where N is the FINAL count — so it cannot carry
  // information about a source the caller was never told about.
  //
  // WHY THIS CLOCK STARTS HERE AND NOT AT `fanoutStartedAt`. Round-1 finding
  // P1 is not only about which number is passed to the formula; its reason is
  // that "a source nobody was told about changed how much time the others had
  // — and a slow survivor came back `answered` in one run and `timedOut` in
  // the byte-identical run without them". A budget measured from the start of
  // the fan-out spends itself on ADMISSION, and a concealed candidate that is
  // slow to evaluate would take that time out of an admitted source's leg —
  // the same observable difference, bought back by a different route. So the
  // legs get their whole budget, and the phase before them is bounded on its
  // own terms above. Total latency is therefore bounded by the admission
  // ceiling plus this deadline, and both are bounded.
  clock.openLegs(admitted.length, request.timeoutMs);

  const groups: KnowledgeGroup[] = [];
  const audit: KnowledgeFanoutAuditEntry[] = [];
  const settledLegs = await runBounded(admitted, FANOUT_CONCURRENCY, async (entry) => ({
    source: entry.source,
    outcome: await runLeg(req, entry, request, options, clock),
  }));
  const legs = settledLegs.map((settled, index) => {
    if (settled === undefined) {
      // Unreachable while the legs pass no stop predicate — and they do not,
      // because coverage is a PARTITION over the final set (§7.5, item 9) and
      // dropping an admitted source would break it. §7.1 already names the
      // answer for a member the fan-out did not finish, so this branch returns
      // it rather than casting the possibility away.
      return { source: admitted[index].source, outcome: { kind: 'timedOut' } as LegOutcome };
    }
    if (settled.ok) return settled.value;
    // An unexpected failure INSIDE an admitted source's leg. This source is in
    // the final set — the caller is already told it exists — so it is NAMED in
    // item 8's bucket for a call core could not complete, never concealed.
    logCaughtFailure('knowledge fan-out leg', settled.error);
    return {
      source: admitted[index].source,
      outcome: { kind: 'unavailable', reason: 'transport' } as LegOutcome,
    };
  });

  for (const { source, outcome } of legs) {
    const id = source.row.id;
    if (outcome.kind === 'absent') {
      // sol R1-4: silently absent, identical to never-selected. No coverage
      // entry, no group, and no audit line either — an audit line would be a
      // record of a source the caller was never told about.
      continue;
    }
    if (outcome.kind === 'answered') {
      coverage.record(id, 'answered');
      if (outcome.truncated) coverage.markTruncated(id);
      if (outcome.invalid) coverage.markInvalid(id);
      groups.push({
        sourceId: id,
        sourceSlug: source.row.slug,
        results: outcome.results.map((result) => emit(result, id, source.descriptorVersion)),
      });
      audit.push({
        sourceId: id,
        sourceSlug: source.row.slug,
        outcome: 'answered',
        resultCount: outcome.results.length,
        ...(outcome.assertionJti ? { assertionJti: outcome.assertionJti } : {}),
        ...(outcome.invalid ? { invalidResults: true } : {}),
        ...(outcome.truncated ? { truncatedResults: true } : {}),
      });
      continue;
    }
    if (outcome.kind === 'unavailable') {
      coverage.recordUnavailable(id, outcome.reason, outcome.retryAfterSeconds);
    } else {
      coverage.record(id, outcome.kind);
    }
    audit.push({ sourceId: id, sourceSlug: source.row.slug, outcome: outcome.kind });
  }

  // §5.5's (d) skips are audited too: they were disclosed to the caller, so
  // the forensic record carries what the caller saw.
  for (const source of capable) {
    if (!visible.has(source.row.id) || !covered.has(source.row.id)) continue;
    if (narrowing && !narrowing.has(source.row.id)) continue;
    if (selected.some((entry) => entry.row.id === source.row.id)) continue;
    // Only (d)-skipped sources reach here: an absent-at-preparation source is
    // in `selected` and is therefore skipped by the line above, which is what
    // keeps it out of the audit record too.
    audit.push({ sourceId: source.row.id, sourceSlug: source.row.slug, outcome: 'skipped' });
  }

  const priority = kindPriority();
  groups.sort((left, right) => {
    const rank = (group: KnowledgeGroup): number => {
      const source = selected.find((entry) => entry.row.id === group.sourceId);
      const ranks = (source?.classes ?? []).map((kind) => priority.indexOf(kind))
        .filter((index) => index >= 0);
      return ranks.length === 0 ? priority.length : Math.min(...ranks);
    };
    const difference = rank(left) - rank(right);
    return difference !== 0 ? difference : left.sourceSlug.localeCompare(right.sourceSlug);
  });

  // ── P4: §7.2's WHOLE-RESPONSE byte budget, enforced ONCE ──
  //
  // It used to be enforced per source inside the validator, which meant N
  // sources bought N budgets: eleven sources returned 299,663 bytes against a
  // declared 262,144. The budget is a property of the RESPONSE, so it is
  // applied here, over the merged groups, in the order §7.4 already fixed —
  // and a source whose results are cut for volume is named in
  // `truncatedResults`, exactly as an over-limit drop is.
  //
  // Coverage is not charged against it: §7.3 makes the honesty record the
  // thing that must survive truncation, so it is reserved rather than
  // budgeted.
  //
  // MEASURED, not estimated. An earlier version summed the serialized size of
  // each result and then of each group's envelope, and was still 175 bytes
  // over on an eleven-group response: the separators and brackets JSON adds
  // between elements belong to the response too. So the budget is enforced
  // against the ACTUAL serialization, and results are dropped from the end
  // until the emitted bytes fit. Ordering is §7.4's, so what a budget drops
  // is always the lowest-priority material.
  const overBudget = (): boolean =>
    Buffer.byteLength(JSON.stringify(groups), 'utf8') > KNOWLEDGE_RESPONSE_MAX_BYTES;
  for (let index = groups.length - 1; index >= 0 && overBudget(); index -= 1) {
    const group = groups[index];
    while (group.results.length > 0 && overBudget()) {
      group.results.pop();
      coverage.markTruncated(group.sourceId);
    }
  }

  // §7.7's ledger write, through the clock like everything else. The ref is
  // minted HERE so that the response carries the same identifier whatever the
  // write does: a write that does not settle is treated exactly like the write
  // that fails, which this feature already logs rather than raising (the audit
  // service's own header states that trade and §7.7 ratifies it). The
  // alternative — a hang treated more harshly than a failure — would be an
  // inconsistency, not a safeguard.
  const auditRef = newKnowledgeAuditRef();
  const ledger = await clock.race(
    recordKnowledgeSearch(req, {
      auditRef,
      queryText: request.q,
      kinds: request.kinds,
      fanout: audit,
    }),
    KNOWLEDGE_LEDGER_MAX_MS,
  );
  if (ledger.kind !== 'settled') {
    logCaughtFailure(
      'record knowledge search audit',
      ledger.kind === 'failed'
        ? ledger.error
        : new Error('the search ledger write did not settle inside its budget'),
    );
  }

  // §7.3's ordering, made structural: coverage is the first key of the object
  // literal, so a serializer that truncates by bytes truncates groups.
  return { coverage: coverage.build(), groups, auditRef };
}

/**
 * The candidate rows, bounded exactly as candidate A's list bounds them — and
 * CAPPED.
 *
 * The cap is defence in depth and NOT the bound on the admission phase: what
 * makes that phase terminate whatever the estate's size is the queue-level
 * stop above, because a row count cannot be trusted to bound a phase (round-5
 * finding F1). What the cap bounds is the other cost of an unbounded candidate
 * set — the rows themselves and the visibility and selector questions asked
 * over them.
 *
 * The board pseudo-source is ordered AHEAD of the cap, so a large estate can
 * never drop the one source §9 guarantees is always there; the outer ordering
 * then restores §7.4's slug order, so nothing downstream sees a different
 * sequence than before.
 */
async function loadCandidateRows(): Promise<SourceRow[]> {
  const result = await pool.query(
    `SELECT c.id, c.slug, c.name, c.status, c.retired_at,
            c.knowledge_query_endpoint, c.knowledge_get_endpoint,
            c.knowledge_claims_mode, c.knowledge_subject_mode,
            c.knowledge_relevant_groups, c.knowledge_allowed_networks,
            c.knowledge_core_credential_ref, c.current_descriptor_version,
            c.descriptor
       FROM (
         SELECT s.id, s.slug, s.name, s.status, s.retired_at,
                s.knowledge_query_endpoint, s.knowledge_get_endpoint,
                s.knowledge_claims_mode, s.knowledge_subject_mode,
                s.knowledge_relevant_groups, s.knowledge_allowed_networks,
                s.knowledge_core_credential_ref, s.current_descriptor_version,
                v.descriptor
           FROM services s
           LEFT JOIN service_descriptor_versions v
             ON v.service_id = s.id AND v.version = s.current_descriptor_version
          WHERE s.retired_at IS NULL
            AND s.status <> 'retired'
            AND (s.knowledge_query_endpoint IS NOT NULL OR s.slug = $1)
          ORDER BY (s.slug <> $1), s.slug
          LIMIT $2
       ) c
      ORDER BY c.slug`,
    [KNOWLEDGE_BOARD_SOURCE_SLUG, KNOWLEDGE_CANDIDATE_ROWS_MAX],
  );
  return result.rows as SourceRow[];
}

/**
 * §5.2's arm evaluation and the ONE signing it buys, for ONE source, before
 * the final set exists.
 *
 * `null` means NOT ADMITTED: the source is excluded from the final set and
 * from everything downstream of it — no coverage, no group, no audit line,
 * indistinguishable from never-selected (§5.5). A THROW means the same
 * exclusion and is contained by `runBounded`: whether core could not complete
 * the evaluation or the signer refused to emit, core did not establish this
 * source's authority, and §7.5's fail-closed rule says a source without a
 * fresh assertion is not dialed.
 */
async function admit(
  req: AuthRequest,
  source: SelectedSource,
  options: KnowledgeQueryOptions,
  clock: KnowledgeRequestClock,
  timeoutMs: number,
): Promise<AdmittedSource | null> {
  // §5.5: "for `none`-mode and board sources, selection and finality coincide"
  // — there is no signing moment for them to be admitted at.
  if (isBoardSource(source.row.slug) || source.row.knowledge_claims_mode !== 'asserted') {
    return { source };
  }

  const work = (async (): Promise<AdmittedSource | null> => {
    const arms = await evaluateKnowledgeArms(req, source.row);
    if (!arms) return null;
    // Fresh by construction: the evaluation this signs was made on the line
    // above, so it cannot be older than `ARM_EVALUATION_MAX_AGE_SECONDS` (the
    // round-2 finding), and there is no later moment at which it is remade
    // (the terminal finding P2).
    const assertion = await signKnowledgeAssertion({
      armEvaluation: arms,
      issuer: options.issuer,
      callerGroupIds: options.callerGroupIds ?? [],
    });
    return { source, assertion };
  })();

  // THROUGH THE CLOCK. The settle-before-race this function used to carry now
  // lives in `KnowledgeRequestClock.race`, with the reasoning about losers that
  // reject and losers that succeed — admission is one of its callers rather
  // than one of three copies of it.
  const outcome = await clock.race(work, clock.admissionBudgetMs(timeoutMs));

  if (outcome.kind === 'unsettled') {
    // JavaScript cannot cancel the work, so what is guaranteed is that its
    // RESULT is never used: the final set is frozen without this source, and a
    // signing that lands afterwards produces one TTL-bounded `jti` row and
    // reaches no wire, because only an admitted source is ever dialed.
    logCaughtFailure(
      'admit knowledge source',
      new Error('admission did not settle inside its budget'),
    );
    return null;
  }
  // Thrown rather than returned, so that a failed admission and a refused one
  // leave by the SAME door: `runBounded` contains it and the caller excludes
  // the source.
  if (outcome.kind === 'failed') throw outcome.error;
  return outcome.value;
}

/** One admitted source's leg: the board branch, or a dial. */
async function runLeg(
  req: AuthRequest,
  entry: AdmittedSource,
  request: KnowledgeQueryRequest,
  options: KnowledgeQueryOptions,
  clock: KnowledgeRequestClock,
): Promise<LegOutcome> {
  const { source, assertion } = entry;
  const remaining = clock.legsRemainingMs();
  if (remaining <= 0) return { kind: 'timedOut' };

  // ── THE BOARD BRANCH — in-process, no channel, no assertion ──
  //
  // §9: "answered IN-PROCESS — no channel, no assertion, no SSRF surface".
  // Acceptance item 13's third and fourth clauses drill that ZERO signings
  // happen for board dials, measured at the signer seam: this branch cannot
  // sign because it never reaches the signer.
  if (isBoardSource(source.row.slug)) {
    // ROUND-5 FINDING F2, AND IT WAS PRE-EXISTING. The leg deadline used to be
    // checked only BEFORE a leg started, and this branch then awaited
    // `searchBoard` directly — PostgreSQL calls with no deadline on them. A
    // board adapter that never settled left the whole query pending past its
    // budget with no audit row written, and three earlier rounds did not reach
    // it. In-process is not the same thing as bounded: the board leg is raced
    // like every other leg, and a board that does not answer inside the
    // request's remaining budget is §7.1's `timedOut`, named in coverage like
    // any other member of the final set.
    const raced = await clock.race(searchBoard(req, {
      q: request.q,
      kinds: request.kinds,
      limit: request.limitPerSource,
    }), remaining);
    if (raced.kind === 'unsettled') return { kind: 'timedOut' };
    // A REJECTION leaves by the door it always left by: `runBounded` contains
    // it and the caller gives it item 8's `unavailable:transport`.
    if (raced.kind === 'failed') throw raced.error;
    const board = raced.value;
    // The board obeys `limitPerSource` as ONE source (round-1 finding P3), and
    // says so in the same modifier an external source uses.
    return { kind: 'answered', results: board.results, invalid: false, truncated: board.truncated };
  }

  // ── THE ASSERTION WAS MADE AT ADMISSION, AND IS NOT MADE AGAIN ──
  //
  // §5.2's arm set was evaluated once, immediately before the one signing this
  // source gets, and both happened before the final set was frozen (the owner
  // default on Q-S3). So there is nothing left to decide here: a source that
  // reaches this line IS a member of the final set and holds its assertion,
  // and a source that holds none never became a member. A `none`-mode source
  // has no assertion by design, and the channel remains its authenticator.
  //
  // THE ASSERTION CANNOT GO STALE BETWEEN ADMISSION AND THIS DIAL, and
  // round-5 finding F3 is that the comment this replaces was WRONG about why.
  // The two phases have two ceilings, so the age of an assertion at its dial is
  // bounded by their SUM — not by either one — and when both were 20 000 ms a
  // time-scaled probe dialed one aged 37 950 ms against a 30 s TTL. The
  // constants are now chosen so that
  // `KNOWLEDGE_ADMISSION_MAX_MS + KNOWLEDGE_WHOLE_REQUEST_MAX_MS` is under
  // `ASSERTION_DEFAULT_TTL_SECONDS × 1000`, before the ±10 s skew budget §5.2
  // gives the source is counted at all. That inequality is drilled from the
  // three shipped constants themselves rather than restated as a number here.

  const endpoint = source.row.knowledge_query_endpoint;
  if (!endpoint) return { kind: 'absent' };

  // ── §4.2's CHANNEL AUTHENTICATION, before anything is sent ──
  //
  // "REQUIRED for every external source in BOTH claims modes … every
  // knowledge dial (search and get) authenticates core to the source over
  // this channel BEFORE anything else is read". A source core cannot
  // authenticate itself to is NOT dialed: sending the query text to an
  // unauthenticated peer is the exfiltration surface §7.7 is written about.
  // The caller sees item 8's ruled outcome for a channel-auth failure.
  const credential = resolveChannelCredential(source.row.knowledge_core_credential_ref);
  if (!credential) return { kind: 'unavailable', reason: 'transport' };
  const channel = channelAuthDialOptions(credential);

  // §7.2's source-facing contract. `kinds` is NOT here, deliberately.
  const body = JSON.stringify({
    q: request.q,
    limit: request.limitPerSource,
    ...(assertion ? { assertion } : {}),
  });

  // The dial client keeps its own socket timeout — that is where a stalled
  // TLS handshake is named — and the clock races it with the SAME budget, so a
  // dial client that ever failed to honour its own timer still cannot outlive
  // the request. Both answers are §7.1's `timedOut`, so a tie changes nothing.
  const legBudgetMs = Math.max(1, Math.min(request.timeoutMs, clock.legsRemainingMs()));
  const raced = await clock.race(dialKnowledgeSource({
    url: endpoint,
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...(channel.headers ?? {}) },
    allowedNetworks: source.row.knowledge_allowed_networks ?? [],
    ...(channel.clientCertificate ? { clientCertificate: channel.clientCertificate } : {}),
    timeoutMs: legBudgetMs,
    ...(options.trustAnchors !== undefined ? { trustAnchors: options.trustAnchors } : {}),
  }), legBudgetMs);
  if (raced.kind === 'unsettled') return { kind: 'timedOut' };
  if (raced.kind === 'failed') throw raced.error;
  const dialed = raced.value;

  const jti = assertion ? assertionJti(assertion) : undefined;

  if (!dialed.ok) {
    if (dialed.failure === 'refusedByPolicy') return { kind: 'refusedByPolicy' };
    if (dialed.failure === 'timedOut') return { kind: 'timedOut' };
    if (dialed.failure === 'rate-limited') {
      return {
        kind: 'unavailable',
        reason: 'rate-limited',
        ...(dialed.retryAfterSeconds !== undefined ? { retryAfterSeconds: dialed.retryAfterSeconds } : {}),
      };
    }
    // §11.8: "channel-auth failure ⇒ `unavailable:transport`". A refused TLS
    // handshake or a closed socket reaches here as `transport`, and core does
    // not speculate about which of the two it was.
    return { kind: 'unavailable', reason: 'transport' };
  }

  // A 401 or 403 is a DENIAL the source stated, which is a different fact
  // from an unreachable source: §7.3's `refusedBySource` is "an explicit
  // denial envelope", and a status-line denial is the same statement without
  // the body.
  if (dialed.status === 401 || dialed.status === 403) return { kind: 'refusedBySource' };
  if (dialed.status < 200 || dialed.status >= 300) return { kind: 'unavailable', reason: 'transport' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(dialed.body);
  } catch {
    // An unparseable body answered nothing. It is `answered` with every
    // result dropped — the source WAS reachable and DID answer — and
    // `invalidResults` names it, which is exactly §7.3's all-dropped shape.
    return { kind: 'answered', results: [], invalid: true, truncated: false, ...(jti ? { assertionJti: jti } : {}) };
  }
  if ((parsed as { refused?: unknown } | null)?.refused === true) return { kind: 'refusedBySource' };

  const validated = validateSourceResults({
    raw: parsed,
    requestedKinds: request.kinds,
    declaredCompartments: source.compartments,
    limit: request.limitPerSource,
  });
  return {
    kind: 'answered',
    results: validated.results,
    invalid: validated.invalid,
    truncated: validated.truncated,
    ...(jti ? { assertionJti: jti } : {}),
  };
}

/** §8.1: every surviving `ref` leaves core sealed, and only sealed. */
function emit(
  result: ValidatedKnowledgeResult,
  sourceId: string,
  descriptorVersion: number,
): KnowledgeEmittedResult {
  return {
    handle: sealKnowledgeHandle({
      s: sourceId,
      dv: descriptorVersion,
      c: result.compartment,
      r: result.ref,
    }),
    title: result.title,
    snippet: result.snippet,
    contentKind: result.contentKind,
    compartment: result.compartment,
    score: result.score,
    ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}),
    ...(result.parentRef
      ? {
        parentHandle: sealKnowledgeHandle({
          s: sourceId,
          dv: descriptorVersion,
          c: result.compartment,
          r: result.parentRef,
        }),
      }
      : {}),
  };
}

/** One item's outcome, whether `work` returned or threw. */
type SettledResult<R> = { ok: true; value: R } | { ok: false; error: unknown };

/**
 * Run `work` over `items` with at most `limit` in flight, and SETTLE every
 * item.
 *
 * Deliberately a few lines rather than a dependency: owner decision D4(a) is
 * zero new packages, and a pool that only ever needs "at most N at once, keep
 * every result" is smaller than the sentence describing a library's version
 * policy.
 *
 * TERMINAL FINDING P1. It used to hand `work`'s promise straight to
 * `Promise.all`, so ONE source's rejection — an arm evaluator that threw, a
 * signer that threw, anything unexpected inside a leg — rejected the WHOLE
 * query, against §7.5's "a failed source never fails the whole query". Now
 * every call to `work` is contained at the ITEM; the worker keeps serving the
 * queue after one item fails; and the CALLER decides what that failure means,
 * because the two callers mean different things by it — at admission it is an
 * exclusion (§5.5), inside a leg it is item 8's named bucket. The `Promise.all`
 * below joins WORKERS, not items, and a worker cannot reject: the only
 * expression in its body that can throw is inside the `try`.
 */
async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
  stopDequeuing?: () => boolean,
): Promise<(SettledResult<R> | undefined)[]> {
  const results: (SettledResult<R> | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      // THE QUEUE-LEVEL STOP (round-5 finding F1). Asked BEFORE the item is
      // taken, so the phase's cost after its ceiling is one predicate call per
      // worker — four — and not one scheduler turn per remaining candidate.
      // Only admission passes it: the legs must settle every member because
      // coverage is a partition over the final set.
      if (stopDequeuing !== undefined && stopDequeuing()) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await work(items[index]) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Re-exported for the route's own validation, so the bounds have one home. */
export type { KnowledgeCoverage } from './KnowledgeCoverage';
export type { ServiceDescriptor };
