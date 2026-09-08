import { Router, Request, Response } from 'express';
import { relayhallConfig, getPublicConfig, type SsoPresence } from '../config/relayhall';
import { appearanceService } from '../services/AppearanceService';
import { identityProviderService } from '../services/identity/IdentityProviderService';
import { firstRunService } from '../services/FirstRunService';

const router = Router();

/**
 * The SSO presence lookup (design d95136d7 3.2, RH-P5.SSO.W2).
 *
 * SS-14a makes "the" Identity provider well defined: at most one may be
 * enabled, enforced by a partial unique index in migration 104.
 *
 * It fails CLOSED and separately from the appearance lookup, because the two
 * failures mean different things: the login page must render even when the
 * database is unreachable, and "no SSO button" is a survivable answer while
 * "no login page" is not.
 */
async function ssoPresence(): Promise<SsoPresence> {
  try {
    const provider = await identityProviderService.activeProvider();
    return { enabled: provider !== undefined, displayName: provider ? provider.name : null };
  } catch {
    return { enabled: false, displayName: null };
  }
}

/**
 * GET /config
 * Returns public configuration (bot, branding, features)
 * Safe to expose to frontend - no sensitive paths or service URLs
 */
router.get('/', async (_req: Request, res: Response) => {
  const sso = await ssoPresence();
  // Separately and fail-closed, for the same reason the SSO presence lookup is
  // separate: the login page must render even when the database is unreachable,
  // and "no first-run step" is a survivable answer while "no login page" is
  // not. `firstRunAvailable` swallows its own failures to `false`.
  const firstRun = await firstRunService.firstRunAvailable();
  try {
    const publicConfig = getPublicConfig(relayhallConfig, await appearanceService.get(), sso, firstRun);
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicConfig);
  } catch (error) {
    // Pre-login identity must survive a missing/corrupt row and even a DB
    // outage. Fixed diagnostic: never serialize database exception detail.
    console.error('[config] appearance unavailable; serving built-in identity');
    res.setHeader('Cache-Control', 'no-store');
    res.json(getPublicConfig(relayhallConfig, undefined, sso, firstRun));
  }
});

export default router;
