/**
 * The authenticated principal's own presentation preferences
 * (RH-DESIGN.6 §5.1/§5.5, task 07113036).
 *
 * TWO ROUTES, NO IDENTIFIER. `GET /preferences` and `PUT /preferences` read
 * the principal from `req.principal` — the identity the auth middleware
 * resolved — and nothing else. There is no `/preferences/:principalId`, and a
 * `principalId` in the body is ignored by construction because the patch
 * parser only understands `theme` and `reducedMotion`. A cross-principal
 * probe therefore cannot be expressed, which is the point (review S-F11): the
 * IDOR is prevented by the shape of the surface rather than by a check
 * somebody has to remember to write.
 *
 * SCOPES: authenticated self-service in scopeMap. Reading or writing one's own
 * display preferences is not a grantable object-family verb, and minting
 * `preferences:*` would be new vocabulary. The route has no target identifier,
 * so authentication plus the resolved caller principal is the whole boundary.
 */
import { logCaughtFailure } from '../utils/secretSafeLog';
import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import {
  principalPreferencesService,
  parsePreferencesPatch,
  PreferencesValidationError,
} from '../services/PrincipalPreferencesService';

const router = Router();

/**
 * Secret-safe log sink (the P2.1/P2.2/P2.3 standard set by reviews f52e44db
 * and b82cb8bd, and the one this route failed to adopt — review 241ce388 F2).
 * A fixed context string plus a bounded two-value category. NOTHING
 * exception-derived is serialized: not the message, not `Error.name`. The
 * concrete risk here is not hypothetical — Postgres CHECK and unique
 * violations carry a `detail` that quotes the offending ROW, so a raw error
 * on this route would print a principal's stored preferences into the log.
 */
function logPreferencesFailure(context: string, error: unknown): string {
  return logCaughtFailure(`[Preferences API] ${context} failed:`, error);
}

/**
 * Resolve the caller's principal, or respond. Preferences are stored against
 * a principal row, so an identity that never resolved to one (a legacy env
 * key, an unknown JWT handle before the enforcement flag flips) has nowhere
 * to store them. That is a 403 with a plain reason, not a silent no-op that
 * looks like a save and loses the setting.
 */
function requirePrincipalId(req: AuthRequest, res: Response): string | null {
  const principalId = req.principal?.id;
  if (!principalId) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Preferences belong to a principal; this credential resolves to none',
    });
    return null;
  }
  return principalId;
}

router.get('/', async (req: AuthRequest, res: Response) => {
  const principalId = requirePrincipalId(req, res);
  if (!principalId) return;
  try {
    const preferences = await principalPreferencesService.get(principalId);
    res.json({ success: true, data: preferences });
  } catch (error) {
    const errorId = logPreferencesFailure('read', error);
    res.status(500).json({ error: 'Internal Server Error', code: 'PREFERENCES_READ_FAILED', message: 'Failed to read preferences', errorId });
  }
});

router.put('/', async (req: AuthRequest, res: Response) => {
  const principalId = requirePrincipalId(req, res);
  if (!principalId) return;
  let patch;
  try {
    patch = parsePreferencesPatch(req.body);
  } catch (error) {
    if (error instanceof PreferencesValidationError) {
      res.status(400).json({ error: 'Bad Request', message: error.message });
      return;
    }
    throw error;
  }
  try {
    const preferences = await principalPreferencesService.save(principalId, patch);
    res.json({ success: true, data: preferences });
  } catch (error) {
    const errorId = logPreferencesFailure('write', error);
    res.status(500).json({ error: 'Internal Server Error', code: 'PREFERENCES_SAVE_FAILED', message: 'Failed to save preferences', errorId });
  }
});

export default router;
