/**
 * Appearance asset serving (RH-DESIGN.6 §7, §5.6).
 *
 * This router carries ONLY public, active-asset reads — a discovery redirect and
 * the content-addressed byte route. Every write surface, the full-object read and
 * the version history are root-gated or authenticated and arrive with the rest of
 * RH-UI.4; keeping the public routes in their own router means the
 * unauthenticated surface is the whole file, and a reviewer can see all of it at
 * once. An exact route-list pin in the tests keeps it that way.
 *
 * Three §7 rules are structural here rather than conventional:
 *
 *  - **Only the active row is reachable.** There is no path parameter that names
 *    a row — the kind selects, and the service applies `active` in the query. A
 *    superseded asset cannot be requested by an unauthenticated caller because
 *    there is nothing to ask for.
 *  - **`nosniff`, always, with the exact stored MIME.** The stored MIME came
 *    from the magic bytes at upload, not from the uploader's claim.
 *  - **The URL is content-addressed, and only that URL is immutable.** §5.6 and
 *    §7 require the content sha IN THE URL with sha-keyed immutable caching.
 *    The first cut put `immutable, max-age=31536000` on a URL keyed only by
 *    KIND — so replacing a logo left every cache serving the old bytes for a
 *    year, with no way to invalidate them (review 0cd2ee83, finding F2). An
 *    ETag cannot repair that: an immutable response is never revalidated.
 *
 *    So there are two routes. `/assets/:kind` is the discovery URL and is
 *    explicitly NOT cacheable — it redirects to the active asset's sha URL.
 *    `/assets/:kind/:sha` serves the bytes and is the only immutable one, and
 *    it 404s any sha that is not currently active, which also keeps superseded
 *    bytes unreachable without authentication (§7).
 */
import { logCaughtFailure } from '../utils/secretSafeLog';
import { Router, Request, Response } from 'express';
import { appearanceService, isAssetKind } from '../services/AppearanceService';

const router = Router();

/** Where a kind's bytes live right now. Built here so one rule makes the URL. */
export function assetUrlFor(kind: string, sha256: string): string {
  return `/api/appearance/assets/${kind}/${sha256}`;
}

/**
 * GET /appearance/assets/:kind — DISCOVERY ONLY, never cacheable.
 *
 * Redirects to the active asset's content-addressed URL. This exists because a
 * consumer that only knows "the logo" needs somewhere to start; it deliberately
 * carries `no-store`, so the indirection is re-resolved every time and a
 * replaced asset is picked up immediately.
 *
 * Public by design: deployment identity renders before anyone authenticates
 * (§5.4).
 */
router.get('/assets/:kind', async (req: Request, res: Response) => {
  const kind = String(req.params.kind);
  if (!isAssetKind(kind)) {
    // A closed enum, answered as "no such asset" rather than as a hint about
    // which kinds exist.
    res.status(404).json({ error: 'Not found', message: 'No such asset kind.' });
    return;
  }

  try {
    const asset = await appearanceService.getActiveAsset(kind);
    if (!asset) {
      // Missing asset ⇒ the frontend serves the built-in default, and this route
      // says so plainly (§5.1: missing or corrupt ⇒ built-in defaults).
      res.status(404).json({ error: 'Not found', message: 'No asset is set for this kind.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, assetUrlFor(kind, asset.sha256));
  } catch (error) {
    const errorId = logCaughtFailure('[appearance] failed to resolve asset:', error);
    res.status(500).json({ error: 'Internal error', code: 'APPEARANCE_ASSET_RESOLVE_FAILED', message: 'Failed to resolve the asset.', errorId });
  }
});

/**
 * GET /appearance/assets/:kind/:sha — the bytes, content-addressed.
 *
 * The ONLY immutable response here, and safe to be one precisely because the
 * sha is in the URL: replacing an asset changes the URL rather than asking a
 * cache to forget something.
 *
 * A sha that is not the ACTIVE one 404s. That covers a stale client and, more
 * importantly, keeps superseded bytes unreachable on the unauthenticated
 * surface (§7): history is root-only, and this route cannot name a row.
 */
router.get('/assets/:kind/:sha', async (req: Request, res: Response) => {
  const kind = String(req.params.kind);
  const sha = String(req.params.sha);
  if (!isAssetKind(kind) || !/^[0-9a-f]{64}$/.test(sha)) {
    res.status(404).json({ error: 'Not found', message: 'No such asset.' });
    return;
  }

  try {
    const asset = await appearanceService.getActiveAsset(kind);
    if (!asset || asset.sha256 !== sha) {
      // Deliberately the same answer for "nothing set", "superseded" and
      // "never existed": the public surface discloses no history.
      res.status(404).json({ error: 'Not found', message: 'No such asset.' });
      return;
    }

    const etag = `"${asset.sha256}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', asset.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Length', String(asset.byteSize));
    res.send(asset.bytes);
  } catch (error) {
    // The secret-safe sink: Postgres puts the offending row into `detail` on
    // constraint violations, so a serialized exception on a public route is a
    // disclosure channel (the P2.1/P2.2/P2.3 lesson, repeated at RH-UI.2 F2).
    const errorId = logCaughtFailure('[appearance] failed to serve asset:', error);
    res.status(500).json({ error: 'Internal error', code: 'APPEARANCE_ASSET_SERVE_FAILED', message: 'Failed to serve the asset.', errorId });
  }
});

export default router;
