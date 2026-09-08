/**
 * ssoGroupClaims — the production claim parser (design `d95136d7` §4.1, §7.2;
 * SS-12, SS-13; annex `e6dcadb9` §10a shape classes 2, 3, 4, 5).
 *
 * ── THIS IS THE BOUNDARY THE CONFORMANCE GATE OBSERVES ──
 *
 * Annex §10b, after round-6 F2: *"each class asserts something observed at the
 * production boundary where the code meets the provider's data — the claim
 * parser's verdict, the validated metadata — and only then the behaviour that
 * follows. A class satisfiable by our own configuration alone is testing us,
 * not the provider."*
 *
 * This module IS that boundary. It reads a token's groups claim and returns a
 * VERDICT about what the Identity provider actually sent. `group_binding_mode`
 * is a board setting and is deliberately NOT consulted here: a parser that
 * answered differently because of our own configuration would let a fixture
 * satisfy its class without the provider exhibiting anything.
 *
 * ── WHY THE VERDICTS ARE FOUR, NOT TWO ──
 *
 * SS-13 folds absent, unparseable, truncated and overage-indicated claims into
 * one BEHAVIOUR — "claims unavailable", no snapshot applied, watermark not
 * advanced. But they are not the same OBSERVATION, and class 5 turns on the
 * difference: *"the recorded reason is `overage`, distinguishable from
 * `claim_absent`"*. Reading an overage indicator as "member of nothing"
 * produces a snapshot that removes every membership the person has, which is
 * the directory-wipe threat (T-SS14). So the verdicts are distinguishable and
 * the behaviour they map to is not.
 *
 * ── THE OVERAGE INDICATOR IS A STANDARD CONSTRUCT, NOT A VENDOR ONE ──
 *
 * `_claim_names` / `_claim_sources` are OpenID Connect Core §5.6.2 aggregated
 * and distributed claims. A provider that cannot fit a large claim into the
 * token replaces it with an entry there. Detecting that is standard
 * conformance, not a vendor branch — which is why this file contains no vendor
 * name and passes the §4.5(b) literal gate unexempted.
 */

import { directoryCarriageBounds } from '../../config/directoryCarriage';

export const GROUP_CLAIM_VERDICTS = ['claim_present', 'claim_absent', 'overage', 'unparseable'] as const;
export type GroupClaimVerdict = (typeof GROUP_CLAIM_VERDICTS)[number];

export interface GroupClaimReading {
  verdict: GroupClaimVerdict;
  /**
   * The opaque values the Identity provider sent, in the order it sent them.
   * Empty for every verdict except `claim_present`. NEVER parsed, split on a
   * separator, trimmed or case-folded — shape class 3 is the reason: the same
   * field must hold a directory GUID, a `/path` and a bare name without the
   * code knowing which it is looking at.
   */
  values: string[];
}

/** OIDC Core §5.6.2: the claim was moved out of the token. */
const AGGREGATED_CLAIM_NAMES = '_claim_names';

/**
 * Walk a DOTTED PATH, so a claim nested under a container is expressible as
 * configuration rather than as code (shape class 2). Returns `undefined` when
 * any segment is missing, which is what makes "the same bytes addressed as a
 * flat claim yield no value" true rather than asserted.
 */
function readPath(claims: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = claims;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

/**
 * Read the groups claim, and say what the Identity provider actually sent.
 *
 * `groupsClaimPath` is the per-provider configuration. When a deployment has
 * not configured one there is nothing to read, and the answer is `claim_absent`
 * — the same answer as a provider that emits no groups, because from the
 * board's side those are the same observation.
 */
export function readGroupClaim(
  claims: Record<string, unknown>,
  groupsClaimPath: string | null,
  /** The deployment bound, injectable so a drill can move it without
   *  moving the process environment. Omitted, it IS the deployment
   *  bound -- a caller cannot opt out of it by forgetting it. */
  maxValues?: number,
): GroupClaimReading {
  if (!groupsClaimPath) return { verdict: 'claim_absent', values: [] };

  // Overage is checked FIRST, and against the claim's TOP-LEVEL name, because
  // that is the key an aggregated-claims entry uses. Checking it after the
  // value lookup would read a truncated claim as absent, which is exactly the
  // directory wipe SS-13 refuses.
  const topLevelName = groupsClaimPath.split('.')[0];
  const claimNames = claims[AGGREGATED_CLAIM_NAMES];
  if (
    typeof claimNames === 'object' &&
    claimNames !== null &&
    !Array.isArray(claimNames) &&
    Object.prototype.hasOwnProperty.call(claimNames, topLevelName)
  ) {
    return { verdict: 'overage', values: [] };
  }

  const raw = readPath(claims, groupsClaimPath);
  if (raw === undefined || raw === null) return { verdict: 'claim_absent', values: [] };

  // A single string is a legitimate one-group claim; an array is the usual
  // shape. Anything else is a claim we cannot read, and an unreadable claim is
  // "claims unavailable", never "member of nothing".
  if (typeof raw === 'string') {
    return raw.length === 0 ? { verdict: 'unparseable', values: [] } : { verdict: 'claim_present', values: [raw] };
  }
  if (!Array.isArray(raw)) return { verdict: 'unparseable', values: [] };
  if (raw.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    return { verdict: 'unparseable', values: [] };
  }
  // ── THE BOARD'S OWN OVERAGE BOUND (RH-LENSES-a, obligation B-L8) ──────
  //
  // A claim the PROVIDER truncated is already `overage`. A claim the
  // provider sent in full but that is larger than this deployment will
  // carry is the same OBSERVATION -- we do not know what the full
  // membership is -- so it takes the same verdict and therefore the same
  // fail-closed behaviour: no carriage written, no carriage deleted, no
  // membership changed, and the staleness watermark left where it was so
  // AZ-30's alarm fires past its threshold.
  //
  // It is deliberately NOT a new refusal code. A second way to say "this
  // claim is unusable" is a second thing every consumer has to learn, and
  // reading an oversized claim as "member of nothing" is the directory
  // wipe (T-SS14) this verdict exists to refuse.
  if (raw.length > (maxValues ?? directoryCarriageBounds().claimMaxValues)) {
    return { verdict: 'overage', values: [] };
  }
  if (raw.length === 0) {
    // An EMPTY array is the one case a provider really can mean "no groups".
    // It is still not a snapshot input under SS-13's fail-closed rule, but it
    // is observably different from a claim that never arrived.
    return { verdict: 'claim_present', values: [] };
  }
  return { verdict: 'claim_present', values: raw as string[] };
}

/**
 * SS-13's behaviour, separated from the observation above.
 *
 * Absent, unparseable and overage-indicated claims all mean the same thing to
 * the WRITE path — no snapshot is applied, memberships are left exactly as they
 * were, the staleness watermark is not advanced — while remaining
 * distinguishable to the audit trail and to shape classes 4 and 5.
 */
export function groupClaimIsUsableAsSnapshot(reading: GroupClaimReading): boolean {
  return reading.verdict === 'claim_present';
}
