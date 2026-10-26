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
import { isKnowledgeCapable, isKnowledgeWriteCapable, KNOWLEDGE_BOARD_SOURCE_SLUG } from './KnowledgeSourcePolicy';
import { ROOT_SCOPE, scopesSatisfy } from '../utils/scopeMap';
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
/** Resolve source identity only; all outer authorization remains the acting caller's.
 * Delegation links are supplied by authentication only after live chain validation.
 * Parentless human and service Accounts are both valid broker identities; source
 * lifecycle membership is a separate source-owned authorization decision.
 * Never walk guessed ancestors or derive identity from a role/display label.
 */
export function knowledgeAccountPrincipalId(req: AuthRequest): string | null {
  const principal = req.principal;
  if (!principal || principal.status !== 'active') return null;
  const links = req.delegationLinks;
  if (links === undefined || links === null) {
    return ['human', 'service'].includes(principal.kind) && principal.parentPrincipalId === null ? principal.id : null;
  }
  if (!Array.isArray(links) || links.length < 2 || links[0]?.principalId !== principal.id
    || links[0]?.kind !== principal.kind || links[0]?.parentPrincipalId !== principal.parentPrincipalId) return null;
  const seen = new Set<string>();
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (!link || typeof link.principalId !== 'string' || !link.principalId || seen.has(link.principalId)) return null;
    seen.add(link.principalId);
    if (i < links.length - 1) {
      if (!['agent', 'service'].includes(link.kind) || link.parentPrincipalId !== links[i + 1]?.principalId) return null;
    } else if (!['human', 'service'].includes(link.kind) || link.parentPrincipalId !== null) return null;
  }
  return links[links.length - 1].principalId;
}

export async function evaluateKnowledgeArms(
  req: AuthRequest,
  row: KnowledgeSourceArmRow,
): Promise<KnowledgeArmEvaluation | null> {
  const actor: AuthorizationActor = req.authorizationActor ?? actorFromRequest(req);

  // ARM 1 — caller principal status. An unauthenticated or principal-less
  // caller has no identity to attest, so there is nothing to sign about.
  if (!actor.authenticated || !actor.principalId || actor.principalId !== req.principal?.id) return null;
  const accountPrincipalId = knowledgeAccountPrincipalId(req);
  if (!accountPrincipalId) return null;

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
    accountPrincipalId,
    at: Math.floor(Date.now() / 1000),
  });
  ARM_EVALUATIONS.add(evaluation);
  return evaluation;
}

/** The reserved in-process source signs nothing; §8.2's board branch is C's. */
export function isBoardSource(slug: string): boolean {
  return slug === KNOWLEDGE_BOARD_SOURCE_SLUG;
}

// ═══════════════ RB-11 Governor v0 — the WRITE producer set ═══════════════
//
// Card `b796067e`, ratified design C.3 and C.12 (ruling E97), declared change
// D-8. A write evaluation is minted ONLY by `evaluateKnowledgeWriteArms`, into
// its OWN module-private WeakSet. The two producer sets are disjoint by
// construction: the read signer asks `ARM_EVALUATIONS` and refuses every write
// evaluation, and the write signer asks `WRITE_ARM_EVALUATIONS` and refuses
// every read evaluation (C.3: "the read signer refuses write evaluations and
// the write signer refuses read ones"). Nothing exports a way to add to
// either set.

/** The three verbs of the write wire (C.2). Closed. */
export const KNOWLEDGE_WRITE_OPS = ['propose', 'preview', 'commit'] as const;
export type KnowledgeWriteOp = (typeof KNOWLEDGE_WRITE_OPS)[number];

/** The scope the write arm asks for (D-8; distinct from the read scope). */
export const KNOWLEDGE_WRITE_SCOPE = 'knowledge-contents:write';

/**
 * C.3's core-attested task context: the task and its project, BOTH or
 * NEITHER, resolved by the executor from authoritative board state and never
 * taken from the request body.
 */
export interface KnowledgeTaskContext {
  readonly taskId: string;
  readonly projectId: string;
}

export interface KnowledgeWriteArmEvaluation {
  readonly sourceId: string;
  readonly sourceSlug: string;
  /** A write source is always `asserted`: the write predicate requires it. */
  readonly claimsMode: 'asserted';
  readonly subjectMode: 'pairwise' | 'direct';
  readonly relevantGroups: readonly string[];
  readonly accountPrincipalId: string;
  /** The verb this evaluation authorises; the assertion carries it as `op`. */
  readonly op: KnowledgeWriteOp;
  /** `tsk` / `prj` of the assertion, or null for no task context. */
  readonly taskContext: KnowledgeTaskContext | null;
  readonly at: number;
}

const WRITE_ARM_EVALUATIONS = new WeakSet<KnowledgeWriteArmEvaluation>();

/** Was this object minted by THIS module's WRITE evaluator? The write signer asks exactly this. */
export function isKnowledgeWriteArmEvaluation(candidate: unknown): candidate is KnowledgeWriteArmEvaluation {
  return typeof candidate === 'object' && candidate !== null
    && WRITE_ARM_EVALUATIONS.has(candidate as KnowledgeWriteArmEvaluation);
}

/** The row shape the write evaluator needs: the read row plus the write endpoint. */
export interface KnowledgeWriteSourceArmRow extends KnowledgeSourceArmRow {
  knowledge_write_endpoint: string | null;
}

/** Why a write evaluation was not minted, for the executor's audit row ONLY. */
export type KnowledgeWriteArmRefusal = 'arms' | 'not_write_capable';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Evaluate the WRITE arm set for ONE source, as the acting caller (C.12):
 * arms 1, 2 and 5 exactly as the read evaluator; the explicit
 * `knowledge-contents:write` arm; visibility and selector coverage over the
 * source exactly as for reads; and write capability.
 *
 * Returns a minted evaluation, or the refusal class. `arms` is the uniform,
 * silent refusal of C.11 ("the arms failing on the core side give one uniform
 * `refused` without a reason"); `not_write_capable` is returned ONLY after
 * every arm that decides whether the caller may see this source has passed, so
 * naming it discloses nothing the caller's own queryable set does not already
 * show.
 */
export async function evaluateKnowledgeWriteArms(
  req: AuthRequest,
  row: KnowledgeWriteSourceArmRow,
  op: KnowledgeWriteOp,
  taskContext: KnowledgeTaskContext | null,
): Promise<KnowledgeWriteArmEvaluation | KnowledgeWriteArmRefusal> {
  const actor: AuthorizationActor = req.authorizationActor ?? actorFromRequest(req);
  if (!(KNOWLEDGE_WRITE_OPS as readonly string[]).includes(op)) return 'arms';
  if (taskContext !== null
    && (!CANONICAL_UUID.test(taskContext.taskId) || !CANONICAL_UUID.test(taskContext.projectId))) return 'arms';

  // ARM 1 — caller principal status, and the Account the assertion attests.
  if (!actor.authenticated || !actor.principalId || actor.principalId !== req.principal?.id) return 'arms';
  const accountPrincipalId = knowledgeAccountPrincipalId(req);
  if (!accountPrincipalId) return 'arms';

  // ARM 2 — presented credential or live login session, as for reads.
  if (!req.credentialId && !req.sessionId) return 'arms';

  // THE WRITE SCOPE — explicit, and evaluated per act. The route ceiling
  // already named a missing scope by its own refusal before this point; this
  // arm is the executor's own statement that the act needs it, so an
  // in-process caller that skipped the ceiling cannot mint a write evaluation.
  // `root` satisfies it by the A12.1 sentinel; the READ scope never does.
  if (!scopesSatisfy(actor.scopes ?? null, KNOWLEDGE_WRITE_SCOPE)) return 'arms';

  // ARM 5 — source knowledge configuration live, by the ONE read predicate.
  if (row.retired_at !== null || row.status === 'retired') return 'arms';
  const block = row.descriptor?.knowledgeSource ?? null;
  if (!isKnowledgeCapable({ slug: row.slug, knowledgeQueryEndpoint: row.knowledge_query_endpoint }, block)) {
    return 'arms';
  }

  // ARMS 3 AND 4 — visibility and selector coverage over THIS source,
  // composed exactly as the read evaluator composes them (the `read` action,
  // the administrator arm suppressed, `root` alone exempt).
  const visible = await authorizationRepository.authorizedIds(actor, 'service', [row.id], 'read');
  if (!visible.has(row.id)) return 'arms';
  if (!(actor.scopes ?? []).includes(ROOT_SCOPE)) {
    const covered = await authorizationRepository.selectorCoveredIds(actor, 'service', [row.id]);
    if (!covered.has(row.id)) return 'arms';
  }

  // WRITE CAPABILITY — the ONE write predicate (KnowledgeSourcePolicy).
  if (!isKnowledgeWriteCapable({
    slug: row.slug,
    knowledgeQueryEndpoint: row.knowledge_query_endpoint,
    knowledgeWriteEndpoint: row.knowledge_write_endpoint,
    knowledgeClaimsMode: row.knowledge_claims_mode,
  }, block)) {
    return 'not_write_capable';
  }

  const evaluation: KnowledgeWriteArmEvaluation = Object.freeze({
    sourceId: row.id,
    sourceSlug: row.slug,
    claimsMode: 'asserted' as const,
    subjectMode: row.knowledge_subject_mode,
    relevantGroups: Object.freeze([...(row.knowledge_relevant_groups ?? [])]),
    accountPrincipalId,
    op,
    taskContext: taskContext === null ? null : Object.freeze({ taskId: taskContext.taskId, projectId: taskContext.projectId }),
    at: Math.floor(Date.now() / 1000),
  });
  WRITE_ARM_EVALUATIONS.add(evaluation);
  return evaluation;
}
