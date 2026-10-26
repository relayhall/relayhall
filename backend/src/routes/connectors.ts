/**
 * /connectors — what the local RelayHall connector reads from the board
 * (universal harness connector design v1.5; owner ruling E462, slice S3).
 *
 *   GET /connectors/trust-policy   the board's NARROW-ONLY override of the
 *                                  connector release's trust policy (design
 *                                  4.3, choice C5, B3)
 *
 * Route ceiling `services:read` (utils/scopeMap.ts), a scope the harness token
 * carries; session and bearer alike. The answer holds publisher ids, version
 * numbers, the ceiling's sha256 and refusal codes: no secret, no board object,
 * nothing about the caller. A deployment entry that would widen the ceiling
 * is never served, only named in `rejected`; see services/ConnectorTrustPolicy.
 */
import { Router, Request, Response } from 'express';
import { connectorTrustPolicyResponse } from '../services/ConnectorTrustPolicy';
import { logCaughtFailure } from '../utils/secretSafeLog';

const router = Router();

router.get('/trust-policy', (_req: Request, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(connectorTrustPolicyResponse());
  } catch (err) {
    const errorId = logCaughtFailure('[Connectors] trust policy read failed', err);
    res.status(503).json({ code: 'TRUST_POLICY_UNAVAILABLE', errorId });
  }
});

export default router;
