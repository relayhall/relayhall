/**
 * routes/notificationEndpoints.ts — RH-P3.C8: the human notification path's
 * endpoint configuration surface (strategy §2.12).
 *
 * SUBSCRIPTION-CLASS: this whole family resolves to the `root` sentinel in
 * the scope map — human surface or the admin credential class only, never
 * the agent plane — and every mutation is audited by the service. The same
 * beacon argument that keeps service delivery endpoints out of agent-plane
 * `manage` (§2.6.4) applies identically to human notification endpoints.
 */
import { Router, Request, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import {
  notificationEndpointService,
  NotificationEndpointValidationError,
  NOTIFICATION_ENDPOINT_KINDS,
  type NotificationEndpointKind,
} from '../services/NotificationEndpointService';
import { logCaughtFailure } from '../utils/secretSafeLog';

const router = Router();

function requestAuditActor(req: Request) {
  const authReq = req as AuthRequest;
  return {
    principalId: authReq.principal?.id ?? null,
    handle: authReq.userId || 'user',
    authMethod: authReq.authMethod ?? 'unknown',
  };
}

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const endpoints = await notificationEndpointService.list();
    res.json({ success: true, endpoints });
  } catch (err) {
    const errorId = logCaughtFailure('[NotificationEndpoints API] list failed:', err);
    res.status(500).json({ success: false, code: 'NOTIFICATION_ENDPOINTS_READ_FAILED', error: 'Failed to list notification endpoints', errorId });
  }
});

router.put('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body ?? {};
    const unknown = Object.keys(body).filter((key) => !['principalId', 'kind', 'target', 'enabled'].includes(key));
    if (unknown.length > 0) {
      res.status(400).json({ success: false, code: 'INVALID_ENDPOINT', error: `Unknown field(s): ${unknown.join(', ')}` });
      return;
    }
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof body.principalId !== 'string' || !UUID.test(body.principalId)) {
      res.status(400).json({ success: false, code: 'INVALID_ENDPOINT', error: 'principalId must be a principal UUID' });
      return;
    }
    if (!NOTIFICATION_ENDPOINT_KINDS.includes(body.kind as NotificationEndpointKind)) {
      res.status(400).json({ success: false, code: 'INVALID_ENDPOINT', error: `kind must be one of: ${NOTIFICATION_ENDPOINT_KINDS.join(', ')}` });
      return;
    }
    if (typeof body.target !== 'string' || body.target.length < 3 || body.target.length > 2000) {
      res.status(400).json({ success: false, code: 'INVALID_ENDPOINT', error: 'target must be 3..2000 characters' });
      return;
    }
    if (body.kind === 'webhook' && !/^https?:\/\//i.test(body.target)) {
      res.status(400).json({ success: false, code: 'INVALID_ENDPOINT', error: 'a webhook target must be an http(s) URL' });
      return;
    }
    const enabled = body.enabled === undefined ? true : body.enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, code: 'INVALID_ENDPOINT', error: 'enabled must be a boolean' });
      return;
    }
    const endpoint = await notificationEndpointService.upsert(
      { principalId: body.principalId, kind: body.kind, target: body.target, enabled },
      requestAuditActor(req),
    );
    res.json({ success: true, endpoint });
  } catch (err: any) {
    if (err instanceof NotificationEndpointValidationError) {
      res.status(400).json({ success: false, code: 'INVALID_ENDPOINT', error: err.message });
      return;
    }
    if (err?.code === '23503') {
      res.status(400).json({ success: false, code: 'INVALID_ENDPOINT', error: 'principalId names no principal' });
      return;
    }
    const errorId = logCaughtFailure('[NotificationEndpoints API] upsert failed:', err);
    res.status(500).json({ success: false, code: 'NOTIFICATION_ENDPOINT_SAVE_FAILED', error: 'Failed to save the notification endpoint', errorId });
  }
});

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const removed = await notificationEndpointService.remove(req.params.id, requestAuditActor(req));
    if (!removed) {
      res.status(404).json({ success: false, error: 'No such notification endpoint' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    const errorId = logCaughtFailure('[NotificationEndpoints API] remove failed:', err);
    res.status(500).json({ success: false, code: 'NOTIFICATION_ENDPOINT_REMOVE_FAILED', error: 'Failed to remove the notification endpoint', errorId });
  }
});

export default router;
