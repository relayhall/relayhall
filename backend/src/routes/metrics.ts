import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { MetricsCollectorDenied, metricsConfig, productMetricsService } from '../services/ProductMetricsService';
import { isBearerCredentialKind } from '../utils/administratorSession';
const router = Router();
router.get('/', async (req: AuthRequest, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method Not Allowed' }); return; }
  if (!isBearerCredentialKind(req.authMethod) || !req.principal || !req.credentialId
    || !req.scopes?.includes('metrics:read')) {
    res.status(403).json({ error: 'Forbidden', code: 'METRICS_COLLECTOR_REQUIRED' }); return;
  }
  // No query parameter can select a different Account, object or label.
  if (Object.keys(req.query).length) { res.status(400).json({ error: 'Bad Request', code: 'METRICS_QUERY_NOT_SUPPORTED' }); return; }
  try {
    const text = await productMetricsService.scrape({ principalId: req.principal.id, credentialId: req.credentialId }, metricsConfig());
    res.set('Cache-Control', 'no-store').set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(text);
  } catch (error) {
    if (error instanceof MetricsCollectorDenied) { res.status(403).json({ error: 'Forbidden', code: 'METRICS_COLLECTOR_REQUIRED' }); return; }
    res.status(503).json({ error: 'Service Unavailable', code: 'METRICS_UNAVAILABLE' });
  }
});
export default router;
