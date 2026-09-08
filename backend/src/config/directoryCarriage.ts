/**
 * The three deployment bounds of RH-LENSES-a (card 74e02a05, obligation
 * `B-L8`), read from the environment on the `HardenedOrchestrationConfig`
 * pattern: parsed once, refused loudly when malformed, never silently coerced.
 *
 * EVERY ONE OF THESE IS A REFUSAL BOUND, NEVER A TRUNCATION BOUND. A truncated
 * membership is a silent access change, and the whole point of the carriage
 * store is that what the directory said and what the board derived from it are
 * the same thing. So each bound refuses the act and NAMES ITSELF in the
 * refusal, so the administrator raises it deliberately or splits the group.
 *
 * `DIRECTORY_CLAIM_MAX_VALUES` is the one exception to "a new bound is a new
 * refusal", and deliberately so (design v5 s3.4): an oversized claim takes the
 * EXISTING `overage` path in `ssoGroupClaims`, so it writes nothing, deletes
 * nothing, moves no watermark, and AZ-30's staleness alarm fires past its
 * threshold -- the same fail-closed behaviour SS-13 already gives a claim the
 * provider itself truncated. A new refusal shape here would have been a second
 * way to say one thing.
 */

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface DirectoryCarriageBounds {
  /**
   * The most group values one OIDC claim may carry before it is read as
   * `overage`. Design default 500.
   */
  claimMaxValues: number;
  /**
   * The most `members` one SCIM Group write may carry. Above it the write is
   * refused `413 tooMany` (RFC 7644 s3.12). Design default 5000.
   */
  scimMaxMembers: number;
  /**
   * The most carrying Accounts a single *Use this group* bind may recompute.
   * Above it the bind is refused with a named error: a binding that silently
   * locks thousands of rows is an availability incident. Design default 5000.
   */
  bindMaxAccounts: number;
}

function parseBound(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  // The floor is 1, not 0: a bound of zero would refuse every act, which is a
  // deployment that has turned the feature off by arithmetic rather than by
  // saying so. The ceiling keeps a typo'd bound from being no bound at all.
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error(`${name} must be between 1 and 1000000`);
  }
  return value;
}

export function loadDirectoryCarriageBounds(env: Env = process.env): DirectoryCarriageBounds {
  return {
    claimMaxValues: parseBound(env, 'DIRECTORY_CLAIM_MAX_VALUES', 500),
    scimMaxMembers: parseBound(env, 'DIRECTORY_SCIM_MAX_MEMBERS', 5000),
    bindMaxAccounts: parseBound(env, 'DIRECTORY_BIND_MAX_ACCOUNTS', 5000),
  };
}

/**
 * Read at each use rather than cached at import.
 *
 * The suites in this tree set environment variables and then require modules;
 * a value frozen at import time would make a bound untestable without a module
 * registry reset, and an untestable bound is one nobody drills.
 */
export function directoryCarriageBounds(): DirectoryCarriageBounds {
  return loadDirectoryCarriageBounds();
}
