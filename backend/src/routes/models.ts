/**
 * /models — interim read-only model catalog.
 *
 * P1.3 (§2.8 + F11) removed everything else this router once carried:
 * harness status probes, config/auth-profile reads, `POST /set-default`, and
 * `POST /switch` (board-side
 * commanding of harness model config), and the transcript-reading
 * session-tools endpoint. Only the LiteLLM-backed catalog remains, feeding
 * the task execution-profile pickers until Phase-2 model descriptors replace
 * it — an interim coupling recorded in docs/seams.md.
 */
import express from 'express';
import type { Request, Response } from 'express';
import { getModelCatalog, normalizeModelId } from '../services/modelCatalog';
import { logCaughtFailure } from '../utils/secretSafeLog';

const router = express.Router();

/**
 * GET /models/available - Live resolved model catalog.
 *
 * Aggregates model ids reachable to the backend (an explicitly configured
 * LiteLLM `/v1/models` endpoint plus a static degraded-startup floor), cached
 * with a ~10min TTL. Feeds the model selector and
 * the doctor's model-pin validation so pins are checked against the LIVE
 * catalog instead of a stale hardcoded list.
 *
 * `?refresh=1` forces a re-resolution (bypasses the TTL cache).
 */
router.get('/available', async (req: Request, res: Response) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const catalog = await getModelCatalog(force);
    res.json({
      success: true,
      models: catalog.ids.map((id) => ({ id, normalized: normalizeModelId(id) })),
      ids: catalog.ids,
      count: catalog.ids.length,
      sources: catalog.sources,
      resolvedAt: new Date(catalog.resolvedAt).toISOString(),
      ttlMs: 10 * 60_000,
    });
  } catch (err) {
    const errorId = logCaughtFailure('❌ Failed to resolve model catalog:', err);
    res.status(500).json({ success: false, code: 'MODEL_CATALOG_FAILED', error: 'Failed to resolve model catalog', errorId });
  }
});

export default router;
