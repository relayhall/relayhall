/**
 * routes/knowledge.ts — RH-KW1 (card `0b4b779b`), the ONE router module of
 * owner decision D8, mounted at the pinned knowledge paths.
 *
 * CANDIDATE A ships the first of the three: `/knowledge-sources`.
 * `/knowledge-queries` (candidate C) and `/knowledge-contents` (candidates B
 * and C) mount the SAME module at their own paths as they land. The module is
 * one file by decision D8, and each mount is added in the candidate that
 * ships a handler for it — a mount with no handler would be a 404 surface
 * that the route census counts as shipped.
 *
 * AUTHORITY: `knowledge-contents:read` (§5.1, vocabulary amendment A21).
 * The route rule in `utils/scopeMap.ts` is the ONLY place in that table that
 * names this scope, which is how A21's "object = the CONTENTS disclosed"
 * ceiling stays true as the table grows — the `directory-provisioning:write`
 * discipline, applied to the second such scope.
 *
 * THE SET THIS ROUTE RETURNS is §5.5's (a ∩ b ∩ c) predicate, and all three
 * limbs are named at their evaluation points below, each a real conjunct. (d) and (e) are
 * REQUEST-time arms of a search — the class intersection and the `sources[]`
 * narrowing — and belong to the fan-out executor in candidate C, not to a
 * caller asking what it may query at all.
 */
import { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { filterAuthorizedResources, actorFromRequest } from '../middleware/sharedAuthorization';
import { authorizationRepository } from '../services/AuthorizationRepository';
import { ROOT_SCOPE } from '../utils/scopeMap';
import { knowledgeSourceService } from '../services/KnowledgeSourceService';
import { pool } from '../db/connection';
import { executeKnowledgeGet } from '../services/KnowledgeGetExecutor';
import {
  executeKnowledgeQuery,
  KNOWLEDGE_QUERY_MAX_LENGTH,
  KNOWLEDGE_SOURCES_NARROWING_CAP,
  KNOWLEDGE_LIMIT_PER_SOURCE_MIN,
  KNOWLEDGE_LIMIT_PER_SOURCE_MAX,
  KNOWLEDGE_LIMIT_PER_SOURCE_DEFAULT,
  KNOWLEDGE_TIMEOUT_MS_MIN,
  KNOWLEDGE_TIMEOUT_MS_MAX,
  KNOWLEDGE_TIMEOUT_MS_DEFAULT,
} from '../services/KnowledgeFanoutExecutor';
import { KNOWLEDGE_CONTENT_KINDS, type KnowledgeContentKind } from '../utils/serviceDescriptor';
import { oauthIssuer } from '../utils/oauthMetadata';
import { boardEndpointFor } from '../utils/onboardingPack';
import { sendApiError } from '../utils/apiErrors';
import { logCaughtFailure } from '../utils/secretSafeLog';

const router = Router();

/**
 * GET /api/knowledge-sources — the caller's QUERYABLE SET.
 *
 * §5.5: "A source is consulted iff ALL hold: (a) knowledge-configured;
 * (b) visible to the caller under the shared predicate; (c) inside the
 * caller's `knowledge-contents:read` selector".
 *
 * Sources failing any limb are UNDISCLOSED ABSOLUTELY (§5.5) — they are
 * absent from this response with no marker, no count and no reason, exactly
 * as they will be absent from a search's `consulted` set. The empty set is a
 * 200 with an empty array, never a 403: "you may query nothing" and "there is
 * nothing to query" must be indistinguishable to a caller, or the route
 * becomes an oracle over the estate's source registry.
 */
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // LIMB (a) — knowledge-configured. The ONE capability predicate of §4.2,
    // stated in KnowledgeSourcePolicy.isKnowledgeCapable and asked here.
    const capable = await knowledgeSourceService.listKnowledgeCapableSources();

    // LIMB (b) — source visibility under the shared predicate. The shipped
    // decision, composed and never copied.
    const visible = await filterAuthorizedResources(
      req,
      'read',
      capable,
      (source) => ({ type: 'service', id: source.id }),
    );

    // LIMB (c) — `knowledge-contents:read` SELECTOR coverage over this source.
    //
    // ── WHY THIS IS A SEPARATE CONJUNCT (round-1 finding S2-B1, `8981983f`) ──
    //
    // The first version of this handler evaluated (b) and (c) as ONE call, on
    // the reading that §5.1 layers the scope+selector onto the shipped service
    // grants. The reviewer showed that reading is not enough IN PRACTICE: for
    // `service` rows the shared predicate's visibility arm is the SQL literal
    // `'shared'` (`AuthorizationRepository.sqlResource`), so limb (b) returns
    // TRUE for every authenticated caller and the selector half could never
    // refuse anything. Every holder of the scope saw every knowledge-capable
    // source's id, slug, name, description, modes, classes and compartments —
    // against A21's "always evaluated against an object selector ... never a
    // flat estate-wide grant" and against §5.5's absolute concealment.
    //
    // So the selector is asked SEPARATELY and the two are intersected.
    // `selectorCoveredIds` is not a second predicate: it composes the SAME two
    // shipped fragments `AuthorizationService.sqlCondition` composes in its
    // own `authorityCore`, over the same resource map and the same verb rule.
    //
    // `root` is exempt because A12.1 makes it the global sentinel that
    // satisfies every check — it is not a selector holder and cannot be one.
    // NO other role is exempt: an administrator without a covering selector
    // sees nothing here.
    //
    // That sentence was FALSE when it was first written — `sqlCondition`'s
    // administrator short-circuit answered TRUE for a non-delegated
    // `admin`/`operator`/`orchestrator` and limb (c) could not refuse them
    // (terminal-round finding P2). It is true now: `selectorCoveredIds`
    // suppresses that one arm by owner ruling `623632b0` option (a).
    //
    // THE COST, STATED: this route is deliberately STRICTER than the shipped
    // `GET /services` list, where an operator sees every Service. An operator
    // holding `knowledge-contents:read` but no covering selector gets an
    // EMPTY list here. That is not an oversight — A21 is ratified for the
    // knowledge plane specifically, and "always evaluated against an object
    // selector ... never a flat estate-wide grant" cannot survive a role that
    // is exempt from the selector.
    const actor = req.authorizationActor ?? actorFromRequest(req);
    const holdsRoot = (actor.scopes ?? []).includes(ROOT_SCOPE);
    const covered = holdsRoot
      ? new Set(visible.map((source) => source.id))
      : await authorizationRepository.selectorCoveredIds(
        actor,
        'service',
        visible.map((source) => source.id),
      );

    res.json({ success: true, sources: visible.filter((source) => covered.has(source.id)) });
  } catch (e) {
    const errorId = logCaughtFailure('list knowledge sources', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to list knowledge sources', undefined, { errorId });
  }
});


/**
 * §10.2 pins THREE knowledge paths and owner decision D8 puts them in ONE
 * module. A single Express router cannot serve them: each mount would answer
 * every path the router declares, so `/knowledge-contents` would also return
 * the source list. One module, one router per pinned path.
 */
export const knowledgeContentsRouter = Router();
/**
 * The deployment identity that issues assertions (§5.2 `iss`). The board's
 * own public API endpoint, exactly as the OAuth issuer is derived, so a source
 * can tie an assertion to the deployment it already talks to.
 */
function knowledgeAssertionIssuer(req: AuthRequest): string {
  return oauthIssuer(boardEndpointFor(req));
}

/**
 * The caller's group ids. The signer intersects these with the source's
 * `knowledge_relevant_groups` (§5.3 minimization) — a source never learns a
 * group its owner did not declare relevant.
 */
async function callerGroupIds(req: AuthRequest): Promise<string[]> {
  const principalId = req.principal?.id;
  if (!principalId) return [];
  const result = await pool.query(
    `SELECT gm.group_id FROM group_members gm
       JOIN principals mp ON mp.id = gm.account_principal_id AND mp.status = 'active'
      WHERE gm.account_principal_id = $1`,
    [principalId],
  );
  return result.rows.map((row) => String(row.group_id));
}

/**
 * GET /api/knowledge-contents — §8.2's drill-down.
 *
 * The handle is the ONLY source selector: this route takes no source
 * parameter, so acceptance item 3's "a handle for source A presented against
 * B" is not merely refused, it is unaddressable. Everything else — the full
 * §5.2 arm set, the compartment check against the handle's PINNED descriptor
 * version, the §8.2 mode branch and §8.3's two-authority etag — lives in the
 * get executor, in that order, so nothing leaves the deployment before core
 * has re-evaluated the caller's authority.
 *
 * Refusals are CORE-AUTHORED tokens. A source's own error text is never
 * forwarded (§7.6), and the refusal shape is identical whether the caller
 * lost the compartment, never had the source, or presented a forged handle —
 * §11.10's oracle resistance.
 */
knowledgeContentsRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const outcome = await executeKnowledgeGet(
      req,
      {
        handle: req.query.handle,
        continueFrom: req.query.continueFrom === undefined ? undefined : Number(req.query.continueFrom),
        contentHash: typeof req.query.contentHash === 'string' ? req.query.contentHash : undefined,
        ifNoneMatch: typeof req.query.ifNoneMatch === 'string' ? req.query.ifNoneMatch : undefined,
      },
      { issuer: knowledgeAssertionIssuer(req), callerGroupIds: await callerGroupIds(req) },
    );
    if (!outcome.ok) {
      res.status(403).json({ success: false, refused: outcome.refused });
      return;
    }
    res.json({ success: true, ...outcome });
  } catch (e) {
    const errorId = logCaughtFailure('read knowledge contents', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to read knowledge contents', undefined, { errorId });
  }
});

/**
 * POST /api/knowledge-queries — §7's search.
 *
 * The THIRD pinned path of §10.2 and the last of owner decision D8's three
 * mounts. Its own router, for the reason stated above: one Express router per
 * pinned path, one module for all three.
 *
 * ── WHY THE REQUEST IS VALIDATED HERE AND NOT IN THE EXECUTOR ──
 *
 * §7.1's bounds are a REQUEST contract — "`q`: string(1..1024) — validated
 * globally, independent of any source" — so they are checked at the boundary
 * where a caller can be told what it got wrong, and the executor receives a
 * request it can trust. The bounds themselves are the executor's exported
 * constants, so the two cannot drift.
 *
 * ── WHAT A REFUSAL HERE MAY SAY ──
 *
 * Everything on this path is about the CALLER'S OWN input: a query that is
 * too long, a `kinds` value that is not vocabulary, more than sixteen ids.
 * None of it discloses estate state, so these refusals are named. The
 * estate-dependent outcomes — which sources exist, which the caller may
 * reach — are concealed by the executor and never reach a status code here.
 */
export const knowledgeQueriesRouter = Router();

/** §7.1's `sources?: uuid[]`, in canonical form. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

knowledgeQueriesRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const q = body.q;
    if (typeof q !== 'string' || q.length < 1 || q.length > KNOWLEDGE_QUERY_MAX_LENGTH) {
      sendApiError(res, 422, 'KNOWLEDGE_QUERY_INVALID',
        `'q' must be a string of 1..${KNOWLEDGE_QUERY_MAX_LENGTH} characters`, 'q');
      return;
    }

    // §7.1: "`kinds`?: ('code'|'docs'|'data')[] default all". `mixed` is a
    // SOURCE-side declaration meaning "matches every request" (§5.5), never a
    // request value: asking for `mixed` would be asking for a routing arm, so
    // it is refused rather than silently reinterpreted.
    const requestableKinds = KNOWLEDGE_CONTENT_KINDS.filter((kind) => kind !== 'mixed');
    let kinds: KnowledgeContentKind[] = [...requestableKinds];
    if (body.kinds !== undefined) {
      if (!Array.isArray(body.kinds) || body.kinds.length === 0
        || !body.kinds.every((kind) => (requestableKinds as readonly string[]).includes(kind as string))) {
        sendApiError(res, 422, 'KNOWLEDGE_KINDS_INVALID',
          `'kinds' must be a non-empty array of ${requestableKinds.join(', ')}`, 'kinds');
        return;
      }
      kinds = [...new Set(body.kinds as KnowledgeContentKind[])];
    }

    // §7.1: "`sources`?: uuid[] narrowing-only, deduplicated, cap 16,
    // out-of-set ids silently ignored". Deduplicated BEFORE the cap, so a
    // caller repeating one id sixteen times is not refused for a list of one.
    // Out-of-set ids are ignored in the EXECUTOR, where "out of set" is
    // decided — this route cannot know it without disclosing the set.
    let sources: string[] | undefined;
    if (body.sources !== undefined) {
      // §7.1 types this field `uuid[]`, and round-1 finding P6 is that the
      // route only checked for a string: `not-a-uuid` was accepted, narrowed
      // to nothing it could ever match, and answered 200. A malformed id is
      // the caller's own input, so it is NAMED — this discloses nothing about
      // which sources exist, which is why an id that is well-formed but
      // unknown is still silently ignored by the executor.
      if (!Array.isArray(body.sources)
        || !body.sources.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))) {
        sendApiError(res, 422, 'KNOWLEDGE_SOURCES_INVALID',
          "'sources' must be an array of source ids in canonical UUID form", 'sources');
        return;
      }
      sources = [...new Set(body.sources as string[])];
      if (sources.length > KNOWLEDGE_SOURCES_NARROWING_CAP) {
        sendApiError(res, 422, 'KNOWLEDGE_SOURCES_INVALID',
          `'sources' carries at most ${KNOWLEDGE_SOURCES_NARROWING_CAP} ids`, 'sources');
        return;
      }
    }

    const limitPerSource = boundedInteger(
      body.limitPerSource, KNOWLEDGE_LIMIT_PER_SOURCE_DEFAULT,
      KNOWLEDGE_LIMIT_PER_SOURCE_MIN, KNOWLEDGE_LIMIT_PER_SOURCE_MAX,
    );
    if (limitPerSource === null) {
      sendApiError(res, 422, 'KNOWLEDGE_LIMIT_INVALID',
        `'limitPerSource' must be an integer in ${KNOWLEDGE_LIMIT_PER_SOURCE_MIN}..${KNOWLEDGE_LIMIT_PER_SOURCE_MAX}`,
        'limitPerSource');
      return;
    }
    const timeoutMs = boundedInteger(
      body.timeoutMs, KNOWLEDGE_TIMEOUT_MS_DEFAULT, KNOWLEDGE_TIMEOUT_MS_MIN, KNOWLEDGE_TIMEOUT_MS_MAX,
    );
    if (timeoutMs === null) {
      sendApiError(res, 422, 'KNOWLEDGE_TIMEOUT_INVALID',
        `'timeoutMs' must be an integer in ${KNOWLEDGE_TIMEOUT_MS_MIN}..${KNOWLEDGE_TIMEOUT_MS_MAX}`, 'timeoutMs');
      return;
    }

    const outcome = await executeKnowledgeQuery(
      req,
      { q, kinds, ...(sources ? { sources } : {}), limitPerSource, timeoutMs },
      { issuer: knowledgeAssertionIssuer(req), callerGroupIds: await callerGroupIds(req) },
    );

    // §7.5: "a failed source never fails the whole query (HTTP 200 + named
    // degradation)". There is deliberately no status code here that depends
    // on how many sources answered.
    res.json({ success: true, ...outcome });
  } catch (e) {
    const errorId = logCaughtFailure('run knowledge query', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to run knowledge query', undefined, { errorId });
  }
});

/** An optional bounded integer: the default when absent, `null` when wrong. */
function boundedInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) return null;
  return numeric;
}

export default router;
