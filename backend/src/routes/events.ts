/**
 * routes/events.ts — RH-P3.C1: the cursor event feed read surface.
 *
 * GET /events?cursor=<n>&limit=<n> returns everything appended after the
 * cursor, grant-scoped against the CALLING principal at query time (strategy
 * 4e40f06f §2.6.2 — every consumer, not only ingesters). The feed is
 * authoritative; C2's webhooks will only ever be a latency optimization over
 * this read. Responses carry `nextCursor` for the follow-up query; consumers
 * on the reconciliation doctrine poll this on their slow schedule.
 *
 * There is deliberately no write surface: emission happens inside the write
 * paths' own transactions (FeedEventService.emit), and the ledger is
 * append-only by trigger.
 */
import { Router, Request, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { actorFromRequest } from '../middleware/sharedAuthorization';
import { feedEventService } from '../services/FeedEventService';
import { logCaughtFailure } from '../utils/secretSafeLog';

const router = Router();

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '0';
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const { events, nextCursor } = await feedEventService.listSince(
      actorFromRequest(req as AuthRequest),
      cursor,
      limit,
    );
    res.json({ success: true, events, nextCursor });
  } catch (err) {
    const errorId = logCaughtFailure('[Events API] Error reading the feed:', err);
    res.status(500).json({ success: false, error: 'The event feed could not be read', code: 'FEED_READ_FAILED', errorId });
  }
});

export default router;
