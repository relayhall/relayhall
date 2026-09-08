/**
 * Reporter-ingest health — the seed of the Phase-3 telemetry contract.
 *
 * `GET /sessions/pipeline-health` survives the P1.3 observer retirement
 * (ruling A18): its response shape is exactly what a reporter-ingest health
 * surface needs, and reporters will keep the `session_adapter_health` table
 * current through health self-reports (`CanonicalAdapterHealthInput` in
 * `types/CanonicalSession.ts`). With no reporters connected it returns
 * `{ status: 'unknown', adapters: [] }` — the documented empty state.
 *
 * See docs/observability.md.
 */
import { Router, Request, Response } from 'express';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import type { CanonicalAdapterHealth, CanonicalAdapterHealthStatus } from '../types/CanonicalSession';
import { logCaughtFailure } from '../utils/secretSafeLog';

export type PipelineStatus = 'unknown' | 'healthy' | 'degraded';

/**
 * Aggregate adapter rows into the pipeline status:
 * no adapters → 'unknown'; any non-healthy adapter → 'degraded'; else 'healthy'.
 */
export function derivePipelineStatus(adapters: Array<{ status: CanonicalAdapterHealthStatus }>): PipelineStatus {
  if (adapters.length === 0) return 'unknown';
  return adapters.some((adapter) => adapter.status !== 'healthy') ? 'degraded' : 'healthy';
}

export async function listAdapterHealth(pool: Pool = defaultPool): Promise<CanonicalAdapterHealth[]> {
  const result = await pool.query<CanonicalAdapterHealth>(
    `SELECT source, source_instance, adapter_version, status, reason_code,
            last_source_at, last_success_at, last_error_at, checked_at, safe_details
     FROM session_adapter_health ORDER BY source, source_instance`,
  );
  return result.rows;
}

const router = Router();

export async function getPipelineHealth(_req: Request, res: Response): Promise<void> {
  try {
    const adapters = await listAdapterHealth();
    res.json({
      success: true,
      status: derivePipelineStatus(adapters),
      adapters,
    });
  } catch (error) {
    const errorId = logCaughtFailure('Failed to read reporter-ingest pipeline health:', error);
    res.status(503).json({ success: false, status: 'unavailable', error: 'pipeline_health_unavailable', errorId });
  }
}

router.get('/pipeline-health', getPipelineHealth);

export default router;
