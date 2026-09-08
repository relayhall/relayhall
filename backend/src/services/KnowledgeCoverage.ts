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
  reason: 'kinds';
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
}

/** Raised only by a caller misuse this class refuses to encode. */
export class KnowledgeCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeCoverageError';
  }
}

export class KnowledgeCoverageBuilder {
  private readonly outcomes = new Map<string, KnowledgeCoverageOutcome>();

  private readonly unavailable = new Map<string, KnowledgeUnavailableEntry>();

  private readonly truncated = new Set<string>();

  private readonly invalid = new Set<string>();

  private readonly skippedReasons = new Map<string, 'kinds'>();

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
  markSkipped(id: string): void {
    if (this.outcomes.has(id)) {
      throw new KnowledgeCoverageError(`source ${id} was consulted and cannot also be skipped`);
    }
    this.skippedReasons.set(id, 'kinds');
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
      skipped: [...this.skippedReasons.entries()].map(([id, reason]) => ({ id, reason })),
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
    return coverage;
  }
}
