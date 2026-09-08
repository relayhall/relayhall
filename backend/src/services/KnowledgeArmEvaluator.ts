// KnowledgeArmEvaluator.ts — RH-KW1 candidate B (card `0b4b779b`).
//
// §5.2's arm set, and the token that makes the signer's issuance predicate a
// PRODUCER-SET property rather than a call count.
//
// ── THE ARM SET, VERBATIM (§5.2) ──
//
//   "Arm set evaluated by the executor BEFORE every signing, per query and
//    per get: caller principal status; presented credential status;
//    `knowledge-contents:read` grant and selector coverage OVER THIS SOURCE;
//    source visibility; source knowledge configuration live. Any arm false at
//    signing time ⇒ no assertion, source not dialed, and the source is
//    SILENTLY REMOVED from the response universe — indistinguishable from
//    never having been selected."
//
// So a false arm is not an error to report. It is an ABSENCE. The evaluator
// returns null and the caller drops the source; §11.10's oracle-resistance
// clause is what that silence is for.
//
// ── WHY A TOKEN, AND WHY A WeakSet ──
//
// §5.2: the signer "refuses any call not carrying an executor-issued
// arm-evaluation result, and only the fan-out and get executors hold one,
// which IS the issuance predicate". §11.13 adds that this must be proven "as
// a producer-set property, not a call count".
//
// A count proves nothing: a test that asserts "the signer was called twice"
// passes just as well when a third caller signs something it should not. So
// the token is not data the signer inspects — it is an object identity this
// module MINTED. `ARM_EVALUATIONS` is module-private and nothing exports a
// way to add to it, so the producer set is exactly {this module}, and a
// hand-built object with every field right is still refused.
import { authorizationRepository } from './AuthorizationRepository';
import { actorFromRequest } from '../middleware/sharedAuthorization';
import type { AuthorizationActor } from './AuthorizationService';
import type { AuthRequest } from '../middleware/auth';
import { isKnowledgeCapable, KNOWLEDGE_BOARD_SOURCE_SLUG } from './KnowledgeSourcePolicy';
import { ROOT_SCOPE } from '../utils/scopeMap';
import type { ServiceDescriptor } from '../utils/serviceDescriptor';

/**
 * The result of one arm-set evaluation. Opaque by design: the signer checks
 * its IDENTITY, not its shape.
 */
export interface KnowledgeArmEvaluation {
  readonly sourceId: string;
  readonly sourceSlug: string;
  readonly claimsMode: 'asserted' | 'none';
  readonly subjectMode: 'pairwise' | 'direct';
  readonly relevantGroups: readonly string[];
  readonly accountPrincipalId: string;
  /** Evaluated at, seconds. The signer refuses a stale evaluation. */
  readonly at: number;
}

/**
 * The producer set, and the whole content of the issuance predicate. Private
 * to this module: there is no export that adds to it.
 */
const ARM_EVALUATIONS = new WeakSet<KnowledgeArmEvaluation>();

/** How long an evaluation may sit before the signer refuses it. */
export const ARM_EVALUATION_MAX_AGE_SECONDS = 5;

/** Was this object minted by THIS module? The signer asks exactly this. */
export function isKnowledgeArmEvaluation(candidate: unknown): candidate is KnowledgeArmEvaluation {
  return typeof candidate === 'object' && candidate !== null
    && ARM_EVALUATIONS.has(candidate as KnowledgeArmEvaluation);
}

/** The row shape the evaluator needs. Supplied by the caller's own query. */
export interface KnowledgeSourceArmRow {
  id: string;
  slug: string;
  status: string;
  retired_at: string | null;
  knowledge_query_endpoint: string | null;
  knowledge_claims_mode: 'asserted' | 'none';
  knowledge_subject_mode: 'pairwise' | 'direct';
  knowledge_relevant_groups: string[] | null;
  descriptor: ServiceDescriptor | null;
}

/**
 * Evaluate §5.2's arm set for ONE source, as the acting caller.
 *
 * Returns a minted evaluation, or **null** — never a reason. A caller that
 * gets null drops the source silently; anything else would be the oracle
 * §11.10 forbids.
 */
export async function evaluateKnowledgeArms(
  req: AuthRequest,
  row: KnowledgeSourceArmRow,
): Promise<KnowledgeArmEvaluation | null> {
  const actor: AuthorizationActor = req.authorizationActor ?? actorFromRequest(req);

  // ARM 1 — caller principal status. An unauthenticated or principal-less
  // caller has no identity to attest, so there is nothing to sign about.
  if (!actor.authenticated || !actor.principalId) return null;

  // ARM 2 — presented credential status. The middleware resolves the
  // credential; a request that reached here without one is not a credentialed
  // act, and §5.2 attests the CALLER's context, not an anonymous login
  // session.
  //
  // The session half asks for the SESSION, not for its role snapshot.
  // `req.sessionRole` is `session.roleSnapshot` (`middleware/auth.ts`), which
  // is NULL for an SSO-minted session — so reading it here refused every human
  // the product actually signs in, while `req.sessionId` is set for every
  // resolved session and is what "there is a session" means.
  if (!req.credentialId && !req.sessionId) return null;

  // ARM 5 — source knowledge configuration live. Checked before the
  // authority arms because a retired or unconfigured source is not a source
  // at all, and the ONE capability predicate decides it (§4.2).
  if (row.retired_at !== null || row.status === 'retired') return null;
  const block = row.descriptor?.knowledgeSource ?? null;
  if (!isKnowledgeCapable({ slug: row.slug, knowledgeQueryEndpoint: row.knowledge_query_endpoint }, block)) {
    return null;
  }

  // ARMS 3 AND 4 — `knowledge-contents:read` grant and selector coverage over
  // THIS source, and source visibility.
  //
  // Composed exactly as `GET /knowledge-sources` composes them (candidate A,
  // and terminal-round finding P2): the shipped visibility decision, AND the
  // selector question with the administrator arm suppressed, so no role is
  // exempt from A21's selector. `root` is the A12.1 sentinel and is the only
  // caller that skips the selector.
  const visible = await authorizationRepository.authorizedIds(actor, 'service', [row.id], 'read');
  if (!visible.has(row.id)) return null;
  if (!(actor.scopes ?? []).includes(ROOT_SCOPE)) {
    const covered = await authorizationRepository.selectorCoveredIds(actor, 'service', [row.id]);
    if (!covered.has(row.id)) return null;
  }

  const evaluation: KnowledgeArmEvaluation = Object.freeze({
    sourceId: row.id,
    sourceSlug: row.slug,
    claimsMode: row.knowledge_claims_mode,
    subjectMode: row.knowledge_subject_mode,
    relevantGroups: Object.freeze([...(row.knowledge_relevant_groups ?? [])]),
    accountPrincipalId: actor.principalId,
    at: Math.floor(Date.now() / 1000),
  });
  ARM_EVALUATIONS.add(evaluation);
  return evaluation;
}

/** The reserved in-process source signs nothing; §8.2's board branch is C's. */
export function isBoardSource(slug: string): boolean {
  return slug === KNOWLEDGE_BOARD_SOURCE_SLUG;
}
