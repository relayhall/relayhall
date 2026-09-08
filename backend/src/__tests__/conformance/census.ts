/**
 * The expected census for the §4.5(a) conformance gate.
 *
 * ── WHY THIS FILE IS SHAPED THE WAY IT IS ──
 *
 * v1 of this control used a fixture table as its own oracle, and the round-1
 * review was right that this is the OPPOSITE of a coverage gate: deleting a
 * target's row would simply run fewer cases and stay green. The repair deletes
 * the model.
 *
 * The expected census is **not a constant a candidate can quietly edit beside
 * the fixtures**. It is a checked-in TRANSCRIPTION of two ratified sources,
 * carrying a DIGEST of the transcribed text which the gate recomputes and
 * refuses to run on if it does not match. Editing the census without editing
 * the ratified source it transcribes fails the gate; editing both is a
 * governing-document change and therefore a review event. This is the
 * description-digest device the C4 gate work arrived at for exactly this
 * problem: **snapshot what no pattern can decide.**
 *
 * ── THE TWO SOURCES, AND WHY THEY ARE THESE TWO ──
 *
 * 1. **Strategy amendment S-A8**, carried in companion report `94dc31c0` and
 *    ruled at the SSO sitting (`5a7fd9af`, SSO-R18). It REPLACED S-A1's
 *    five-named-target bullet, so transcribing the old list here would bind
 *    this gate to a claim the owner has narrowed. *Claim and evidence narrow
 *    together, per the design's own §12.18 rule.*
 * 2. **Annex `e6dcadb9` §10a**, the shape-class table. SSO-R18 is explicit that
 *    the eight classes KEEP their behavioural assertions and negative controls
 *    as standard-correctness tests, so the class table is transcribed unchanged.
 *
 * Both are transcribed VERBATIM below. Prose differences from the source are
 * limited to the mechanical ones a plain-text transcription forces (markdown
 * emphasis dropped, table pipes preserved), and any edit at all changes the
 * digest.
 */
import crypto from 'crypto';

/**
 * TRANSCRIPTION 1 — strategy amendment S-A8 (companion `94dc31c0`, first
 * entry; ruled 2026-08-30 as SSO-R18 in sitting record `5a7fd9af`).
 */
export const TRANSCRIBED_SUPPORT_CLAIM = `S-A1's bullet "Named targets the design must survive without a code change: authentik, Microsoft Entra ID (and AD federation), Google Workspace, Okta, Keycloak" is REPLACED by:
"RelayHall supports one official standard: OIDC (authorization-code + PKCE, discovery, JWKS). The tested reference is authentik (estate-side, never in the repository). Platforms implementing the standard - among them Microsoft Entra ID, Google Workspace, Okta, Keycloak - are expected to work, and are documented as community-confirmed as real deployments verify them. No per-vendor code exists in core either way."
Consequence for the ratified SSO package (declared, not silent): annex e6dcadb9 s10b's census leg narrows with the claim - the digest-locked five-target relation re-scopes to the standard-conformance set with authentik as the named tested reference. The eight shape classes keep their behavioural assertions and negative controls as standard-correctness tests, and the s4.5(b) vendor-literal gate is unchanged.`;

/**
 * TRANSCRIPTION 2 — annex `e6dcadb9` §10a, the five named targets as shape
 * classes. Transcribed unchanged, because SSO-R18 left it unchanged.
 */
export const TRANSCRIBED_SHAPE_CLASSES = `| # | Class | Where it shows up | Absorbed by |
| 1 | Issuer is a path under a shared host | Entra (.../{tenant}/v2.0), Keycloak (.../realms/{realm}), authentik (per-application slug) | endpoints come from discovery, never from a template (s4.2) |
| 2 | Groups claim has no fixed name or nesting | Keycloak puts realm roles at realm_access.roles; Okta's claim name is operator-chosen; authentik's is a property mapping | groups_claim is a dotted path (s4.1) |
| 3 | Group values are opaque and of no fixed type | Entra emits directory object GUIDs; Keycloak emits group paths (/engineering); authentik commonly emits names | the board Group binding stores an opaque string matched exactly, never parsed, never split (s7.1) |
| 4 | A provider may emit no groups at all | Google Workspace ID tokens carry no group claim; group data needs a vendor admin API | group_binding_mode = off is a first-class, fully-supported configuration, and group-derived authority is optional everywhere (s7.1, s6.5) |
| 5 | A provider may TRUNCATE the claim | Entra replaces a large groups claim with a _claim_names/_claim_sources overage indicator | truncation is detected and fails closed as "claims unavailable", and is refused as a sync input (s7.2) - never read as "member of nothing" |
| 6 | Logout support varies | back-channel logout exists on Keycloak/Okta/Entra/authentik, not on Google | backchannel_logout_enabled, and the honest per-deployment bound in s8.2 |
| 7 | The issuer may be unreachable from the public internet | Keycloak in-cluster; authentik on a LAN | allow_private_issuer_address (s4.3) |
| 8 | Client authentication varies | secret basic/post everywhere; private_key_jwt on Entra/Okta; public+PKCE for some | client_auth_method enumerates all four (s4.1) |`;

/**
 * The digest the gate recomputes. It covers BOTH transcriptions, so narrowing
 * the claim without re-scoping the classes — or the reverse — is caught.
 *
 * If this constant and the text above disagree, the gate REFUSES TO RUN rather
 * than reporting a pass or a failure: a census whose provenance is in doubt
 * cannot discharge anything.
 */
export const CENSUS_DIGEST = 'fbbfcbf8235c734d380efa32880aed801a0ec7d8967bb301fd7bea16aa169497';

export function computeCensusDigest(): string {
  return crypto
    .createHash('sha256')
    .update(`${TRANSCRIBED_SUPPORT_CLAIM}\n---\n${TRANSCRIBED_SHAPE_CLASSES}`, 'utf8')
    .digest('hex');
}

export const SHAPE_CLASS_IDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type ShapeClassId = (typeof SHAPE_CLASS_IDS)[number];

/**
 * THE EXPECTED RELATION, re-scoped by SSO-R18.
 *
 * Before S-A8 this was five vendor targets, each requiring the classes it
 * exhibits. S-A8 narrowed the CLAIM to one official standard with authentik as
 * the tested reference, so the relation narrows with it:
 *
 *  - `standard-oidc` — the one official standard the claim now names. It
 *    requires ALL EIGHT classes, because S-A8's own consequence clause keeps
 *    them "as standard-correctness tests". This is the target that carries the
 *    claim.
 *  - `authentik` — the NAMED TESTED REFERENCE. It requires the classes §10a
 *    names authentik as exhibiting: the per-application issuer path (1), the
 *    property-mapping claim nesting (2), name-shaped opaque group values (3),
 *    a LAN address (7), and client authentication (8). §10a names authentik as
 *    HAVING back-channel logout, so class 6 — whose characteristic is a
 *    provider that does NOT advertise it — is deliberately not required of it.
 *
 * A target with no required class, or a class required by no target, is a
 * defect in this relation and the gate says so by name.
 */
export const EXPECTED_RELATION: ReadonlyArray<{ target: string; requiredClasses: readonly ShapeClassId[] }> = [
  { target: 'standard-oidc', requiredClasses: [1, 2, 3, 4, 5, 6, 7, 8] },
  { target: 'authentik', requiredClasses: [1, 2, 3, 7, 8] },
];

/**
 * The shape classes the TRANSCRIPTION names, parsed from the digest-locked text.
 *
 * This is what ties the relation back to the ratified source. Dropping a class
 * from `EXPECTED_RELATION` leaves the transcription still naming it, so the
 * gate fails — which is mutation (ii). Editing the transcription instead
 * changes the digest and the gate refuses to run.
 */
export function classesNamedInTranscription(): number[] {
  const ids: number[] = [];
  for (const line of TRANSCRIBED_SHAPE_CLASSES.split('\n')) {
    const match = /^\|\s*(\d)\s*\|/.exec(line.trim());
    if (match) ids.push(Number(match[1]));
  }
  return ids.sort((a, b) => a - b);
}

/**
 * The targets the TRANSCRIPTION names. S-A8 names exactly one tested reference
 * by name; the standard itself is the other target the claim carries. Dropping
 * either from the relation is mutation (i).
 */
export function targetsNamedInTranscription(): string[] {
  const named: string[] = [];
  if (/one official standard: OIDC/.test(TRANSCRIBED_SUPPORT_CLAIM)) named.push('standard-oidc');
  const reference = /The tested reference is (\w+)/.exec(TRANSCRIBED_SUPPORT_CLAIM);
  if (reference) named.push(reference[1]);
  return named.sort();
}

/** Every class the relation names, deduplicated — the gate's coverage floor. */
export function requiredClassIds(): ShapeClassId[] {
  const seen = new Set<ShapeClassId>();
  for (const row of EXPECTED_RELATION) for (const id of row.requiredClasses) seen.add(id);
  return [...seen].sort((a, b) => a - b);
}
