/**
 * KnowledgeDeadline.ts — RH-KW1 candidate C (card `0b4b779b`).
 *
 * The request's CONSTANTS, and the two pieces of arithmetic that turn them
 * into a budget. The object that OWNS them at run time is
 * `KnowledgeRequestClock`; this module is the numbers and nothing else, so a
 * control can read them, compare them, and mutate one of them without
 * touching a line of behaviour.
 *
 * §7.1: "A whole-request deadline of `min(20000, timeoutMs ×
 * ceil(N/concurrency))` bounds total latency; a source unfinished at it lands
 * in `coverage.timedOut`."
 *
 * ── TWO PHASES, TWO CEILINGS, ONE INEQUALITY ──
 *
 * Five review rounds asked the same question at five coordinates: WHICH CLOCK
 * BOUNDS WHICH PHASE, AND WHAT MAY A SOURCE THE CALLER WAS NEVER TOLD ABOUT
 * AFFECT? The rounds' answers pulled against each other because three ratified
 * constraints do:
 *
 *   (A) §5.5 — a concealed candidate must be indistinguishable from
 *       never-selected. Round 1 read that as a statement about OBSERVABLE
 *       behaviour: it must not change an admitted source's outcome. So the
 *       legs cannot be paid for out of a budget a concealed candidate can
 *       spend.
 *   (B) §7.1 — total latency is bounded.
 *   (C) §5.2 — an assertion is dialed inside its TTL (default 30 s), and the
 *       owner default on Q-S3 puts the signing BEFORE the final set is frozen,
 *       which puts (C) on the SUM of the phases rather than on the dial alone.
 *
 * The dispatcher's ruling on `0ee4c4a5` (option (a)) settles it: the request
 * has TWO phases, each with its own cardinality-independent ceiling, and the
 * two ceilings are chosen so that their SUM fits inside the assertion TTL.
 *
 *   • PHASE 1 — ADMISSION, `KNOWLEDGE_ADMISSION_MAX_MS` from the START OF THE
 *     REQUEST. Everything core does before it dials anyone: deciding who may
 *     be asked (§5.5's (a)–(e)), evaluating each asserted candidate's §5.2 arm
 *     set, and the one signing that evaluation buys.
 *   • PHASE 2 — THE LEGS, `min(20000, timeoutMs × ceil(N/concurrency))` from
 *     the END of admission, where N is the FINAL count.
 *
 * (B) is therefore discharged as a bound PER PHASE — the sum, not one clock
 * over both. That is deliberate and it is the ruling's substance: one clock
 * over both phases is exactly what round 1 rejected, because then a slow
 * concealed candidate spends an admitted source's leg budget and the same
 * source comes back `answered` in one run and `timedOut` in the byte-identical
 * run without it.
 *
 * ── THE INEQUALITY ──
 *
 *   KNOWLEDGE_ADMISSION_MAX_MS + KNOWLEDGE_WHOLE_REQUEST_MAX_MS
 *       < ASSERTION_DEFAULT_TTL_SECONDS × 1000
 *
 * 5 000 + 20 000 < 30 000. An assertion is minted at some point inside phase 1
 * and dialed at some point inside phase 2, so its age at the dial can never
 * exceed the sum — which is what round-5 finding F3 measured going wrong, at
 * 37 950 ms against a 30 s TTL, when phase 1's ceiling was the same 20 000 as
 * phase 2's. `knowledgeMaxAssertionAgeMs()` below is that sum, and the drill
 * that guards it compares it with the signer's own constant rather than
 * restating either number.
 */

/** §7.1's ceiling on the LEGS, whatever the fan-out size. */
export const KNOWLEDGE_WHOLE_REQUEST_MAX_MS = 20000;

/**
 * PHASE 1's absolute ceiling, measured from the start of the REQUEST.
 *
 * Round-5 finding F3: this used to be the same 20 000 as phase 2's, so the
 * two phases together could age an assertion past its 30 s TTL. It is now the
 * small slice that makes the inequality above hold with 5 s of margin.
 *
 * 5 000 is not an arbitrary slice. `ARM_EVALUATION_MAX_AGE_SECONDS` is 5: an
 * arm evaluation older than that is refused by the signer, so an admission
 * that has been running for longer than this ceiling could not produce a
 * signable evaluation anyway. The ceiling therefore cuts nothing the signer
 * would have accepted — asserted, not asserted-in-prose, in the fan-out
 * suite.
 */
export const KNOWLEDGE_ADMISSION_MAX_MS = 5000;

/**
 * The §7.7 ledger write's own budget.
 *
 * It sits outside both phases — no assertion is alive by the time it runs and
 * no source is waiting on it — but it is a database write on the request's
 * critical path, and round-5 finding F2 was precisely a database call with no
 * deadline on it. A ledger write that does not settle is treated exactly like
 * one that fails: logged, and the caller still receives the `auditRef` core
 * minted for its query.
 */
export const KNOWLEDGE_LEDGER_MAX_MS = 2000;

/** How many sources are admitted, and later dialed, at once. */
export const KNOWLEDGE_FANOUT_CONCURRENCY = 4;

/**
 * The most candidate rows one query loads.
 *
 * DEFENCE IN DEPTH, NOT THE BOUND. What makes phase 1 terminate whatever the
 * estate's size is the queue-level stop in the executor — a row count cannot
 * be trusted to bound a phase, which is round-5 finding F1 in one sentence.
 * This cap bounds the OTHER cost of an unbounded candidate set: the rows
 * themselves, and the visibility and selector questions asked over them. The
 * board pseudo-source is ordered ahead of the cap so it can never be the row
 * a large estate drops.
 */
export const KNOWLEDGE_CANDIDATE_ROWS_MAX = 512;

/**
 * `min(20000, timeoutMs × ceil(N/concurrency))`.
 *
 * `finalCount` is the FINAL set's size — the sources that survived §5.2's
 * re-evaluation — and never the selected set's.
 */
export function knowledgeWholeRequestDeadlineMs(finalCount: number, timeoutMs: number): number {
  const waves = Math.max(1, Math.ceil(finalCount / KNOWLEDGE_FANOUT_CONCURRENCY));
  return Math.min(KNOWLEDGE_WHOLE_REQUEST_MAX_MS, timeoutMs * waves);
}

/**
 * The budget ONE source's admission gets.
 *
 * §7.1's per-source `timeoutMs` — the same budget the design gives that
 * source's dial, applied to that source's own evaluation and signing — and
 * never more than what is left of `KNOWLEDGE_ADMISSION_MAX_MS`.
 *
 * It is a function of the CALLER'S request and the clock, and of nothing about
 * the source set: a budget computed from a count would put the number of
 * concealed candidates back into an admitted source's outcome, which is the
 * defect round 1 rejected.
 *
 * The floor of 1 keeps a timer from being asked for a negative delay. It is
 * NOT what stops the phase: a floored budget still costs a scheduler turn per
 * item, and 4 000 of those overran the ceiling by 1 493 ms in round 5's probe.
 * The phase stops because the executor stops DEQUEUING once
 * `admissionRemainingMs()` reaches zero.
 */
export function knowledgeAdmissionBudgetMs(elapsedMs: number, timeoutMs: number): number {
  return Math.max(1, Math.min(timeoutMs, KNOWLEDGE_ADMISSION_MAX_MS - elapsedMs));
}

/**
 * The oldest an assertion can be when its dial starts.
 *
 * Signed at some point inside phase 1, dialed at some point inside phase 2, so
 * the whole of both phases is the bound. Compared with the signer's
 * `ASSERTION_DEFAULT_TTL_SECONDS` by the drill that owns finding F3.
 */
export function knowledgeMaxAssertionAgeMs(): number {
  return KNOWLEDGE_ADMISSION_MAX_MS + KNOWLEDGE_WHOLE_REQUEST_MAX_MS;
}
