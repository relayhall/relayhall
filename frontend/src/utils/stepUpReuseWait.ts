/**
 * How long the step-up dialog waits before it asks the Identity provider
 * again, after the provider REUSED a recent sign-in (owner ruling E444).
 *
 * What the board applies: a step-up asks for `max_age=0` and holds the ID
 * token's `auth_time` to the moment the step-up request was made, with no
 * skew (refusal 9; the board's challenge always states `max_age: 0`). That
 * rule bounds nothing about the PROVIDER: a provider that reuses any sign-in
 * younger than its own window answers with the old sign-in, the board refuses
 * it as `SSO_STEP_UP_NOT_FRESH`, and only once that window has passed will
 * the provider ask the person again. The earliest moment a fresh
 * confirmation can pass is therefore the reused sign-in's `auth_time` plus
 * the provider's reuse window.
 *
 * Neither number is in the refusal the dialog receives today. So the wait is
 * computed from what IS known, in this order, and says which it used:
 *   1. `auth_time` known: until `auth_time` plus the window (the stated one,
 *      else the conservative one);
 *   2. only the window known: the whole window from now;
 *   3. neither: the conservative window from now, and the dialog SAYS it is
 *      a cautious wait rather than the provider's own figure.
 * Every result is bounded below (a retry never fires straight back into the
 * same reused sign-in) and above (a person is never left waiting minutes).
 */

/** The conservative reuse window, in seconds: the about-30 s reuse seen in the field (E444), plus a margin. */
export const CONSERVATIVE_REUSE_WINDOW_SECONDS = 35;
/** A computed wait never goes below this, so a retry cannot fire back into the same reuse. */
export const MIN_REUSE_WAIT_SECONDS = 5;
/** Nor above this: the upper bound of a provider step-up `max_age` the board accepts. */
export const MAX_REUSE_WAIT_SECONDS = 300;
/** Added after a known `auth_time` plus window, so the retry lands after the edge, not on it. */
export const EDGE_MARGIN_SECONDS = 2;

export type ReuseWaitSource = 'auth_time' | 'window' | 'conservative';

export interface ReuseWaitInput {
  /** The reused sign-in's `auth_time`, in epoch SECONDS, when the refusal carries it. */
  authTime?: number | null;
  /** The provider's reuse window in seconds, when the board states it. */
  reuseWindowSeconds?: number | null;
  /** Now, in epoch milliseconds. */
  now: number;
}

export interface ReuseWait {
  /** Whole seconds to wait, within the bounds above. */
  seconds: number;
  /** What the wait was computed from; `conservative` means neither figure was known. */
  source: ReuseWaitSource;
}

const finitePositive = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export function reuseWait({ authTime, reuseWindowSeconds, now }: ReuseWaitInput): ReuseWait {
  const windowKnown = finitePositive(reuseWindowSeconds) && reuseWindowSeconds <= MAX_REUSE_WAIT_SECONDS;
  const reuseWindow = windowKnown ? reuseWindowSeconds : CONSERVATIVE_REUSE_WINDOW_SECONDS;
  // An auth_time in the future says nothing usable about the reuse.
  const authKnown = finitePositive(authTime) && authTime * 1000 <= now;
  const raw = authKnown ? authTime + reuseWindow + EDGE_MARGIN_SECONDS - now / 1000 : reuseWindow;
  const seconds = Math.min(MAX_REUSE_WAIT_SECONDS, Math.max(MIN_REUSE_WAIT_SECONDS, Math.ceil(raw)));
  const source: ReuseWaitSource = authKnown ? 'auth_time' : windowKnown ? 'window' : 'conservative';
  return { seconds, source };
}
