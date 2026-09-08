/**
 * KnowledgeRequestClock.ts — RH-KW1 candidate C (card `0b4b779b`).
 *
 * ONE object owns ONE knowledge request's deadline, and it is the ONLY way the
 * fan-out awaits anything that can block.
 *
 * ── WHY THIS EXISTS ──
 *
 * Five review rounds of candidate C found the same defect at five different
 * coordinates, because the executor served three ratified constraints with
 * three ad-hoc clocks and each round moved the pressure onto the next one:
 *
 *   round 1 — the deadline counted the SELECTED set, so a source the caller
 *             was never told about changed how much time the others had.
 *   round 2 — the leg signed what a previous phase had evaluated, and an
 *             evaluation carried across a wave boundary is too old to sign.
 *   round 3 — one leg's rejection ended the whole query, and the phase that
 *             sized the budget was not the phase that decided membership.
 *   round 4 — admission had a clock started but no deadline enforced:
 *             "starting a clock does not enforce a deadline".
 *   round 5 — the admission bound was cardinality-dependent; the BOARD leg
 *             awaited PostgreSQL with no deadline at all and could hang the
 *             request forever; and the two phases together could age an
 *             assertion past its own TTL.
 *
 * The dispatcher's ruling on the STOP report `0ee4c4a5` (option (a)) is that
 * the class terminates only when the request's clock has an OWNER. So:
 *
 *   **Every blocking await in `KnowledgeFanoutExecutor` goes through
 *   `clock.race()` or `clock.mustSettle()`.** Not the arm evaluation, not the
 *   signing, not the board leg, not a dial, not a selection query, not the
 *   §7.7 ledger write — nothing. There is one seam, it is testable with one
 *   mutation, and a census in the fan-out suite reads the shipped executor and
 *   fails on any `await` that is not one of a handful of named internal forms.
 *
 * That single seam is what answers "is some path still unbounded" as a
 * PROPERTY rather than as a list of coordinates a reviewer has to re-check.
 *
 * ── WHAT JAVASCRIPT CAN AND CANNOT DO ──
 *
 * A promise cannot be cancelled. What a race guarantees is not that the work
 * stops but that its RESULT IS NEVER USED and that the request does not wait
 * for it. Two consequences are load-bearing and are stated here rather than
 * left to be rediscovered:
 *
 *   • A loser that eventually REJECTS would take an unhandled rejection out of
 *     the process. So the work is turned into a settled VALUE before it is
 *     raced — `work.then(value => …, error => …)` never rejects — and the
 *     loser is therefore always handled.
 *   • A loser that eventually SUCCEEDS may still have had its side effect. An
 *     admission that signs after losing its race produces one TTL-bounded
 *     `jti` row and reaches no wire, because only an admitted source is ever
 *     dialed.
 *
 * ── THE TWO PHASES ──
 *
 * `KnowledgeDeadline.ts` carries the constants and the reasoning behind them.
 * Phase 1 (ADMISSION) is bounded from the start of the request; phase 2 (THE
 * LEGS) is opened once, when the final set is frozen, and is bounded from
 * THERE — so a slow concealed candidate cannot spend an admitted source's leg
 * budget (§5.5, round-1 finding P1).
 */
import {
  KNOWLEDGE_ADMISSION_MAX_MS,
  knowledgeAdmissionBudgetMs,
  knowledgeWholeRequestDeadlineMs,
} from './KnowledgeDeadline';

/** A phase of the request ran out of time, and the request cannot go on. */
export class KnowledgeRequestTimeoutError extends Error {
  constructor(public readonly phase: string) {
    super(`the knowledge request's ${phase} did not settle inside its budget`);
    this.name = 'KnowledgeRequestTimeoutError';
  }
}

/**
 * What a raced await produced. THREE outcomes, deliberately: a caller that
 * cannot tell a failure from a timeout cannot give them the different
 * meanings §5.5 and §7.3 give them.
 */
export type KnowledgeRaced<T> =
  | { kind: 'settled'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'unsettled' };

export class KnowledgeRequestClock {
  /** When the request began. Phase 1's ceiling is measured from here. */
  readonly startedAt: number;

  /** Set exactly once, by `openLegs`, when the final set is frozen. */
  private legsDeadlineAt: number | null = null;

  constructor(startedAt: number = Date.now()) {
    this.startedAt = startedAt;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** What is left of PHASE 1's absolute ceiling. Never negative. */
  admissionRemainingMs(): number {
    return Math.max(0, this.startedAt + KNOWLEDGE_ADMISSION_MAX_MS - Date.now());
  }

  /**
   * Whether phase 1 may still START work.
   *
   * THIS is what makes the phase cardinality-independent (round-5 finding F1).
   * The executor asks it before dequeuing each candidate, so a queue of four
   * thousand hung admissions ends at the ceiling instead of paying one
   * scheduler turn per remaining item after it. A candidate the phase never
   * reached is not admitted, and a candidate that is not admitted is
   * indistinguishable from one that was never selected (§5.5).
   */
  admissionOpen(): boolean {
    return this.admissionRemainingMs() > 0;
  }

  /** ONE candidate's admission budget: §7.1's `timeoutMs`, clipped to the ceiling. */
  admissionBudgetMs(timeoutMs: number): number {
    return knowledgeAdmissionBudgetMs(this.elapsedMs(), timeoutMs);
  }

  /**
   * Freeze the final set and open PHASE 2.
   *
   * `finalCount` is the ADMITTED count and never the selected count (round-1
   * finding P1), and the deadline runs from NOW — the end of admission — so
   * the legs get their whole budget whatever admission cost.
   */
  openLegs(finalCount: number, timeoutMs: number): void {
    if (this.legsDeadlineAt !== null) {
      // One request, one final set, one leg deadline. A second call would mean
      // a second membership decision, which is what terminal finding P2 forbids.
      throw new Error('the legs phase is opened exactly once per request');
    }
    this.legsDeadlineAt = Date.now() + knowledgeWholeRequestDeadlineMs(finalCount, timeoutMs);
  }

  /**
   * What is left of PHASE 2. May be negative — a caller that is past the
   * deadline gives §7.1's answer, `timedOut`, rather than starting work.
   */
  legsRemainingMs(): number {
    if (this.legsDeadlineAt === null) {
      throw new Error('the legs phase has not been opened');
    }
    return this.legsDeadlineAt - Date.now();
  }

  /**
   * THE ONE SEAM. Await `work` for at most `budgetMs`, and never longer.
   *
   * Every blocking await the fan-out makes comes through here or through
   * `mustSettle` below, which is itself this function plus a rule about what a
   * timeout MEANS to that caller.
   */
  async race<T>(work: Promise<T>, budgetMs: number): Promise<KnowledgeRaced<T>> {
    // SETTLED BEFORE RACED. See the header: a loser that rejects later would
    // otherwise take an unhandled rejection out of the process.
    const settled: Promise<KnowledgeRaced<T>> = work.then(
      (value) => ({ kind: 'settled' as const, value }),
      (error) => ({ kind: 'failed' as const, error }),
    );
    if (budgetMs <= 0) {
      // The budget is already spent. `settled` still absorbs whatever `work`
      // does; the request simply does not wait for it.
      return { kind: 'unsettled' };
    }
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      settled,
      new Promise<KnowledgeRaced<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'unsettled' }), budgetMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return outcome;
  }

  /**
   * `race`, for the awaits whose failure ENDS the request rather than
   * excluding one source: the selection queries core asks about its own
   * estate. A source's failure is contained at the source (§7.5); core's own
   * inability to decide who may be asked is not a source's failure and is not
   * dressed up as one.
   */
  async mustSettle<T>(work: Promise<T>, budgetMs: number, phase: string): Promise<T> {
    const outcome = await this.race(work, budgetMs);
    if (outcome.kind === 'settled') return outcome.value;
    if (outcome.kind === 'failed') throw outcome.error;
    throw new KnowledgeRequestTimeoutError(phase);
  }
}
