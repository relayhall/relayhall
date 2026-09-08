export interface HardenedOrchestrationConfig {
  reviewerHeartbeatEnabled: boolean;
  reviewerHeartbeatIntervalMs: number;
  reviewTimeoutMs: number;
  reviewerHeartbeatStateFile: string;
  /**
   * Optional estate-wide policy bounds on concurrently active leases
   * (card 590c638a, owner ruling 2026-08-30 §2). `null` = UNLIMITED, the
   * default: capacity is the harnesses' concern under the pull-only
   * doctrine; leases bound squatting and rate limits bound API abuse.
   */
  maxActiveGlobal: number | null;
  maxActivePerProject: number | null;
  leaseTtlMs: number;
  notificationBaseBackoffMs: number;
  notificationMaxBackoffMs: number;
  hermesQaRepo?: string;
}

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

function parseBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be exactly true or false`);
}

function parseInteger(env: Env, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

/** An OPTIONAL bound: unset or empty means no bound at all (`null`), never 1. */
function parseOptionalBound(env: Env, name: string, maximum: number): number | null {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  return parseInteger(env, name, 1, 1, maximum);
}

export function loadHardenedOrchestrationConfig(env: Env = process.env): HardenedOrchestrationConfig {
  const reviewerHeartbeatEnabled = parseBoolean(env, 'TASK_REVIEWER_HEARTBEAT_ENABLED', false);
  // The Verifier switch remains fail-closed until the DB-backed review
  // controller is complete. The transactional lease/claim surface has NO
  // switch (card 590c638a, ruling 1): the rollout it guarded closed with
  // Phase 3, and a board that cannot hand out work is not a product mode. A
  // deployment cannot be born with the surface off.
  if (reviewerHeartbeatEnabled) {
    throw new Error('TASK_REVIEWER_HEARTBEAT_ENABLED=true is unavailable until the DB-backed Verifier controller is implemented');
  }


  const baseBackoff = parseInteger(env, 'CLAWBEAT_NOTIFICATION_BASE_BACKOFF_MS', 60_000, 1_000, 3_600_000);
  const maxBackoff = parseInteger(env, 'CLAWBEAT_NOTIFICATION_MAX_BACKOFF_MS', 900_000, 1_000, 86_400_000);
  if (maxBackoff < baseBackoff) {
    throw new Error('CLAWBEAT_NOTIFICATION_MAX_BACKOFF_MS must be greater than or equal to CLAWBEAT_NOTIFICATION_BASE_BACKOFF_MS');
  }

  const maxActiveGlobal = parseOptionalBound(env, 'CLAWBEAT_MAX_ACTIVE_GLOBAL', 64);
  const maxActivePerProject = parseOptionalBound(env, 'CLAWBEAT_MAX_ACTIVE_PER_PROJECT', 64);
  if (maxActiveGlobal !== null && maxActivePerProject !== null && maxActivePerProject > maxActiveGlobal) {
    throw new Error('CLAWBEAT_MAX_ACTIVE_PER_PROJECT cannot exceed CLAWBEAT_MAX_ACTIVE_GLOBAL');
  }

  const hermesQaRepo = env.CLAWBEAT_HERMES_QA_REPO?.trim() || env.DEPLOYED_REPO_PATH?.trim() || undefined;
  if (hermesQaRepo && !hermesQaRepo.startsWith('/')) {
    throw new Error('CLAWBEAT_HERMES_QA_REPO/DEPLOYED_REPO_PATH must be an absolute path');
  }

  return {
    reviewerHeartbeatEnabled,
    reviewerHeartbeatIntervalMs: parseInteger(env, 'REVIEWER_HEARTBEAT_INTERVAL_MS', 15_000, 1_000, 3_600_000),
    reviewTimeoutMs: parseInteger(env, 'TASK_REVIEW_TIMEOUT_MS', 300_000, 1_000, 3_600_000),
    reviewerHeartbeatStateFile: env.REVIEWER_HEARTBEAT_STATE_FILE?.trim() || '/data/reviewer-heartbeat-state.json',
    maxActiveGlobal,
    maxActivePerProject,
    leaseTtlMs: parseInteger(env, 'CLAWBEAT_LEASE_TTL_MS', 900_000, 30_000, 3_600_000),
    notificationBaseBackoffMs: baseBackoff,
    notificationMaxBackoffMs: maxBackoff,
    hermesQaRepo,
  };
}
