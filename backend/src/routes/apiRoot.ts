import { Request, Response } from 'express';
import { BACKEND_BUILD_IDENTITY, RELAYHALL_VERSION } from '../version';
import type { BuildIdentity } from '../utils/releaseIdentity';

/**
 * GET / (served as `/api/`) - the public API root. Lives in its own module so
 * the response is behaviourally testable without booting the server, the way
 * `healthHandler` is.
 *
 * Card 6d549392: besides the version it carries the backend image's own
 * build identity, so About can show what was actually deployed for the
 * backend and not only for the frontend. `build` is the same class of data
 * the frontend already serves publicly at `/release-manifest.json` - commit,
 * dirty flag, build-context digest, build time and version - projected onto
 * those fixed fields; it is null when the image recorded none.
 */
export function createApiRootHandler(version: string, build: BuildIdentity | null) {
  return function apiRoot(_req: Request, res: Response): void {
    // Read at call time, never at module evaluation: dotenv loads AFTER the
    // route modules are imported by server.ts (review 3db17273 r2 B4).
    const environment = process.env.NODE_ENV || 'development';
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      name: 'RelayHall API',
      version,
      build,
      environment,
      status: 'running',
    });
  };
}

export const apiRootHandler = createApiRootHandler(RELAYHALL_VERSION, BACKEND_BUILD_IDENTITY);
