import { Request, Response } from 'express';
import { pool } from '../db/connection';
import { logCaughtFailure } from '../utils/secretSafeLog';
import { taskOrchestrationService } from '../services/TaskOrchestrationService';


/**
 * GET /health — unauthenticated liveness + database check. Lives in its own
 * module so the catch arm is behaviorally testable without booting the
 * server (review 3db17273 B2). The failure envelope follows the
 * error-envelope discipline (card 49399562): fixed developer-authored
 * message, typed code, correlating errorId — never the driver's text.
 */
export async function healthHandler(_req: Request, res: Response): Promise<void> {
  // Read at call time, never at module evaluation: dotenv loads AFTER this
  // module is imported by server.ts (review 3db17273 r2 B4).
  const NODE_ENV = process.env.NODE_ENV || 'development';
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'healthy',
      environment: NODE_ENV,
      timestamp: new Date().toISOString(),
      database: 'connected',
      db_time: result.rows[0].now
    });
  } catch (error) {
    const errorId = logCaughtFailure('[Health] database check failed:', error);
    res.status(500).json({
      status: 'unhealthy',
      environment: NODE_ENV,
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      code: 'HEALTH_DATABASE_CHECK_FAILED',
      error: 'The database health check failed',
      errorId
    });
  }
}

/**
 * GET /health/orchestration - the EFFECTIVE orchestration configuration of
 * this process (card 590c638a, ruling 4: the reachability check).
 *
 * Why here and not in `/release-manifest.json`: the manifest is a
 * build-provenance document written into the image at build time and served
 * as a static file - it cannot know what the container's environment handed
 * the process. This answer is read back from the configured
 * TaskOrchestrationService, the object the claim path consults, so it is
 * the value that REACHED the process: an environment a compose file never
 * forwarded shows up here as "unlimited" where an operator set a number.
 * The health family is unauthenticated liveness; the values are coarse
 * policy integers, never a secret. No database is touched, so the answer is
 * available in boot-check mode too (`RELAYHALL_BOOT_CHECK_PROBE`).
 */
export function orchestrationConfigurationHandler(_req: Request, res: Response): void {
  res.json({
    status: 'configured',
    source: 'process',
    orchestration: taskOrchestrationService.effectiveConfiguration(),
  });
}
