/**
 * KnowledgeCoverage.ts — RH-KW1 candidate C (card `0b4b779b`).
 *
 * §7.3/§7.5's coverage record: the honesty half of a knowledge search.
 *
 * ── WHY THIS IS A TYPE AND NOT AN OBJECT LITERAL BUILT IN THE EXECUTOR ──
 *
 * §7.5 states four invariants over the record:
 *
 *   1. `consulted` is the universe;
 *   2. {`answered`, `timedOut`, `unavailable`, `refusedBySource`,
 *      `refusedByPolicy`} is a PARTITION of it — each consulted id in
 *      EXACTLY one;
 *   3. `truncatedResults` and `invalidResults` are MODIFIERS, each ⊆
 *      `answered`;
 *   4. `skipped` is DISJOINT from `consulted`.
 *
 * Card 40e0e542 (owner ruling E127 (5), selector amendment v1.2) adds the
 * scope the answer covered, so every answer states what was searched:
 *
 *   5. `searchedCategories` is a MODIFIER of `consulted` — one entry per id, ⊆
 *      consulted — naming the categories each source was asked to search
 *      (`all` when no category filter was sent);
 *   6. `archive.included` is the caller's opt-in, and when it is false no
 *      entry may name a category its source declares as archive, nor be
 *      `all` for a source that declares one. The record cannot say "archive
 *      excluded" about a search that reached the archive.
 *   7. `archive.declaredBy` is within `consulted`: the consulted sources that
 *      declare archive categories (the L3 review's rider). The scope sentence
 *      reads it, so it can say when there was no archive to exclude, and when
 *      every source holding one refused the opt-in.
 *
 * Acceptance item 9 drills all four across a run touching every outcome. A
 * record assembled field by field in the executor can satisfy them on the
 * paths the drills walk and break on the next one added; a record that can
 * only be built through this class cannot represent the broken state at all,
 * because every writer goes through one method that refuses a second outcome
 * for the same id. That is the C2 delivery model — make the bad state
 * unrepresentable at the WRITE — applied to an honesty record.
 *
 * ── ORDERING IS LOAD-BEARING ──
 *
 * §7.3: "coverage FIRST, then groups (ordering load-bearing: MCP text budget
 * must be able to truncate results, never the honesty record)". `build()`
 * returns coverage alone; the response assembler places it first, and
 * acceptance item 7's second clause drills that a text-budget truncation
 * takes results and leaves this record intact.
 */

/** The five OUTCOME buckets. Each consulted id lands in exactly one. */
export type KnowledgeCoverageOutcome =
  | 'answered'
  | 'timedOut'
  | 'unavailable'
  | 'refusedBySource'
  | 'refusedByPolicy';

/** Core-authored reasons. A source's own error text is never forwarded (§7.3). */
export type KnowledgeUnavailableReason = 'transport' | 'rate-limited';

export interface KnowledgeUnavailableEntry {
  id: string;
  reason: KnowledgeUnavailableReason;
  /** Core-parsed from Retry-After into a bounded integer; never echoed raw. */
  retryAfterSeconds?: number;
}

export interface KnowledgeSkippedEntry {
  id: string;
  /** The only skip reason v1 has: §5.5's class arm. */
  reason: 'kinds' | 'categories' | 'unsupported-selector';
  selector?: 'categories' | 'protocol';
}

/** Card 40e0e542: what one consulted source was asked to search. */
export interface KnowledgeSearchedCategoriesEntry {
  id: string;
  categories: string[] | 'all';
}

/** Card 40e0e542: whether the caller opted in to the declared archive categories. */
export interface KnowledgeArchiveScope {
  included: boolean;
  /** Invariant 7: the CONSULTED source ids that declare archive categories. */
  declaredBy: string[];
}

export interface KnowledgeCoverage {
  consulted: string[];
  answered: string[];
  timedOut: string[];
  unavailable: KnowledgeUnavailableEntry[];
  refusedBySource: string[];
  refusedByPolicy: string[];
  truncatedResults: string[];
  invalidResults: string[];
  skipped: KnowledgeSkippedEntry[];
  /** v2: answered sources whose answer is partial; `deadlineFired` names the budget behind `deadline` (card 3e0ae06e). */
  partialSources?: { id: string; reasons: string[]; deadlineFired?: 'caller_deadline' | 'source_deadline' }[];
  /** Card 40e0e542: invariant 5, a modifier of `consulted`. */
  searchedCategories: KnowledgeSearchedCategoriesEntry[];
  /** Card 40e0e542: invariant 6. */
  archive: KnowledgeArchiveScope;
}

/** Raised only by a caller misuse this class refuses to encode. */
export class KnowledgeCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeCoverageError';
  }
}

export class KnowledgeCoverageBuilder {
  /**
   * Card 40e0e542: the caller's archive opt-in is fixed when the record is
   * opened, so no writer can change the scope the answer states afterwards.
   */
  constructor(options: { archiveIncluded?: boolean } = {}) {
    this.archiveIncluded = options.archiveIncluded === true;
  }

  private readonly archiveIncluded: boolean;

  private readonly searched = new Map<string, { categories: string[] | 'all'; archive: string[] }>();

  private readonly outcomes = new Map<string, KnowledgeCoverageOutcome>();

  private readonly unavailable = new Map<string, KnowledgeUnavailableEntry>();

  private readonly truncated = new Set<string>();

  private readonly invalid = new Set<string>();

  private readonly skippedReasons = new Map<string, KnowledgeSkippedEntry>();
  private readonly partial = new Map<string, { reasons: string[]; deadlineFired?: 'caller_deadline' | 'source_deadline' }>();
  markPartial(id: string, reasons: string[], deadlineFired?: 'caller_deadline' | 'source_deadline'): void {
    this.requireAnswered(id, 'partialSources');
    this.partial.set(id, { reasons, ...(deadlineFired ? { deadlineFired } : {}) });
  }

  /**
   * Record the FINAL outcome for one consulted source.
   *
   * A second call for the same id is a bug in the executor, not a state the
   * record can hold: the partition would already be broken by the time
   * anything could check it, so it throws here instead. Recording an outcome
   * also makes the id `consulted` — there is deliberately no separate
   * "consulted" writer, because a consulted id with no outcome is exactly the
   * hole §7.5's partition forbids.
   */
  record(id: string, outcome: KnowledgeCoverageOutcome): void {
    if (this.skippedReasons.has(id)) {
      throw new KnowledgeCoverageError(`source ${id} is skipped and cannot also be consulted`);
    }
    if (this.outcomes.has(id)) {
      throw new KnowledgeCoverageError(`source ${id} already has outcome ${this.outcomes.get(id)}`);
    }
    this.outcomes.set(id, outcome);
  }

  /** `unavailable` carries a reason and an optional bounded Retry-After. */
  recordUnavailable(id: string, reason: KnowledgeUnavailableReason, retryAfterSeconds?: number): void {
    this.record(id, 'unavailable');
    this.unavailable.set(id, {
      id,
      reason,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
  }

  /**
   * A MODIFIER: over-limit results were dropped. Only an `answered` source can
   * carry one, which is §7.5's "each ⊆ answered" made unrepresentable
   * otherwise.
   */
  markTruncated(id: string): void {
    this.requireAnswered(id, 'truncatedResults');
    this.truncated.add(id);
  }

  /** A MODIFIER: at least one result failed §7.2 validation and was dropped. */
  markInvalid(id: string): void {
    this.requireAnswered(id, 'invalidResults');
    this.invalid.add(id);
  }

  /**
   * §5.5's class arm: passed (a)–(c),(e) but failed (d).
   *
   * Skipped is DISJOINT from consulted — the source was never dialed, so it
   * has no outcome and must not appear in the partition.
   */
  markSkipped(id: string, reason: KnowledgeSkippedEntry['reason'] = 'kinds', selector?: KnowledgeSkippedEntry['selector']): void {
    if (this.outcomes.has(id)) {
      throw new KnowledgeCoverageError(`source ${id} was consulted and cannot also be skipped`);
    }
    this.skippedReasons.set(id, { id, reason, ...(selector ? { selector } : {}) });
  }

  /**
   * Invariant 5: the categories one CONSULTED source was asked to search, and
   * the archive categories it declares (kept for invariant 6, never emitted).
   * Only a consulted id, once, and never an empty list.
   */
  markSearchedCategories(id: string, categories: readonly string[] | 'all', declaredArchive: readonly string[] = []): void {
    if (!this.outcomes.has(id)) {
      throw new KnowledgeCoverageError(`searchedCategories is a modifier of consulted; source ${id} is not consulted`);
    }
    if (this.searched.has(id)) throw new KnowledgeCoverageError(`source ${id} already names its searched categories`);
    if (categories !== 'all' && categories.length === 0) {
      throw new KnowledgeCoverageError(`source ${id} cannot be consulted over no categories`);
    }
    this.searched.set(id, {
      categories: categories === 'all' ? 'all' : [...new Set(categories)].sort(),
      archive: [...declaredArchive],
    });
  }

  /** Was this source already recorded? The executor asks before re-recording. */
  has(id: string): boolean {
    return this.outcomes.has(id) || this.skippedReasons.has(id);
  }

  private requireAnswered(id: string, modifier: string): void {
    if (this.outcomes.get(id) !== 'answered') {
      throw new KnowledgeCoverageError(
        `${modifier} is a modifier of answered; source ${id} is ${this.outcomes.get(id) ?? 'not consulted'}`,
      );
    }
  }

  /**
   * The record, with the four invariants asserted one last time.
   *
   * The assertions cannot fail if every writer went through the methods above
   * — which is the point. They are here so that a future writer who reaches
   * past them (a field assignment, a merged record, a copy) fails at the
   * boundary rather than shipping a dishonest record.
   */
  build(): KnowledgeCoverage {
    const bucket = (outcome: KnowledgeCoverageOutcome): string[] =>
      [...this.outcomes.entries()].filter(([, value]) => value === outcome).map(([id]) => id);

    const consulted = [...this.outcomes.keys()];
    const answered = bucket('answered');
    const coverage: KnowledgeCoverage = {
      consulted,
      answered,
      timedOut: bucket('timedOut'),
      unavailable: bucket('unavailable').map((id) => this.unavailable.get(id) as KnowledgeUnavailableEntry),
      refusedBySource: bucket('refusedBySource'),
      refusedByPolicy: bucket('refusedByPolicy'),
      truncatedResults: [...this.truncated],
      invalidResults: [...this.invalid],
      skipped: [...this.skippedReasons.values()],
      ...(this.partial.size ? { partialSources: [...this.partial].map(([id, entry]) => ({ id, ...entry })) } : {}),
      searchedCategories: [...this.searched].map(([id, entry]) => ({ id, categories: entry.categories })),
      archive: {
        included: this.archiveIncluded,
        declaredBy: [...this.searched].filter(([, entry]) => entry.archive.length > 0).map(([id]) => id),
      },
    };

    const partitionTotal = coverage.answered.length + coverage.timedOut.length
      + coverage.unavailable.length + coverage.refusedBySource.length
      + coverage.refusedByPolicy.length;
    if (partitionTotal !== coverage.consulted.length) {
      throw new KnowledgeCoverageError('the outcome buckets do not partition consulted');
    }
    const answeredSet = new Set(answered);
    for (const id of coverage.truncatedResults) {
      if (!answeredSet.has(id)) throw new KnowledgeCoverageError('truncatedResults is not a subset of answered');
    }
    for (const id of coverage.invalidResults) {
      if (!answeredSet.has(id)) throw new KnowledgeCoverageError('invalidResults is not a subset of answered');
    }
    const consultedSet = new Set(consulted);
    for (const entry of coverage.skipped) {
      if (consultedSet.has(entry.id)) throw new KnowledgeCoverageError('skipped intersects consulted');
    }
    for (const [id, entry] of this.searched) {
      if (!consultedSet.has(id)) throw new KnowledgeCoverageError('searchedCategories is not a subset of consulted');
      if (!this.archiveIncluded && entry.archive.length > 0
        && (entry.categories === 'all' || entry.categories.some((category) => entry.archive.includes(category)))) {
        throw new KnowledgeCoverageError('the archive is excluded but a searched scope reaches an archive category');
      }
    }
    for (const id of coverage.archive.declaredBy) {
      if (!consultedSet.has(id)) throw new KnowledgeCoverageError('archive.declaredBy is not a subset of consulted');
    }
    return coverage;
  }
}
