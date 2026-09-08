/**
 * routes/knowledgeJwks.ts — RH-KW1 candidate B (card `0b4b779b`).
 *
 * `GET /.well-known/knowledge-assertion-jwks` — §10.2's **one knowledge route
 * outside the auth mesh**, stated as such in the design and mounted here on
 * the `OAUTH_WELL_KNOWN_ROUTE_PATH` precedent, BEFORE `registerProtectedRoutes`.
 *
 * ── WHY IT IS UNAUTHENTICATED, AND WHAT THAT COSTS ──
 *
 * A relying source has to verify an assertion core signed, and it does that
 * before — and independently of — any credential it holds for core. A JWKS a
 * source must authenticate to read is a JWKS it cannot use at the moment it
 * needs it.
 *
 * What it discloses is therefore the whole question, and the answer is: PUBLIC
 * KEYS ONLY. No board data, no source registry, no counts, nothing that varies
 * with who asks. `knowledgeAssertionJwks()` builds the set from the public half
 * of each non-retired key and never touches the database at all — which is why
 * this handler takes no request parameters and produces the same bytes for
 * every caller. D8's unauthenticated-reachability drill asserts exactly that
 * against the SERVED bytes, not against this comment.
 */
import { Router, Request, Response } from 'express';
import {
  knowledgeAssertionJwks,
  knowledgeAssertionKeysetConfigured,
} from '../services/KnowledgeAssertionSigner';
import { sendApiError } from '../utils/apiErrors';
import { logCaughtFailure } from '../utils/secretSafeLog';

const router = Router();

export const KNOWLEDGE_ASSERTION_JWKS_SUFFIX = '/knowledge-assertion-jwks';

router.get(KNOWLEDGE_ASSERTION_JWKS_SUFFIX, (_req: Request, res: Response): void => {
  try {
    // A deployment that signs no assertions publishes an EMPTY key set rather
    // than a 500: "this deployment has no knowledge keys" is a true and
    // useful answer, and it leaks nothing a 404 would not.
    if (!knowledgeAssertionKeysetConfigured()) {
      res.json({ keys: [] });
      return;
    }
    res.json(knowledgeAssertionJwks());
  } catch (e) {
    const errorId = logCaughtFailure('[Knowledge JWKS] serve failed:', e);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Failed to serve the knowledge assertion key set', undefined, { errorId });
  }
});

export default router;
